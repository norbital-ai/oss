// The assistant's runtime settings: an administrator's monthly spending limits (the workspace's, each member's by
// default, and each member's by a policy they hold), the models members may pick and the models System 1, System 2 and
// strong run, kept in `sys_config` under `agent` so they change without a source release. All AI calls (chat,
// infer_facility, sys_1 decisions, embed) enforce and account against the monthly caps; model classes (`fast`, `default`,
// `strong`) route distinctly instead of flattening to one model.
import { Context, Effect, Layer, Option, Schema, Stream } from 'effect';
import { FacilityFailure } from '@norbital-ai/host-api';
import { TenantDb, type TenantDbShape } from '../db/tenant-db.ts';
import { Ai } from '../ports.ts';
import { WorkspaceAlertsService } from '../alerts.ts';
import { TASK } from './schema.ts';

export const AGENT_KEY = 'agent';
const Usd = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
/**
 * Until an administrator says otherwise: the host starts no system agent, an automation may, one the host starts reads
 * no record, and their spend stops at 10 USD a month and 1 USD each.
 */
export const SYSTEM_AGENTS = { improve: false, automations: true, policies: [], monthly: 10, task: 1 };
const ModelPick = Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null)));
/**
 * Monthly caps in USD: `monthly` the workspace's spend this calendar month, `member` each member's by default, `policies`
 * each member's by a policy they hold (the most generous of theirs wins over the default); `models` the allowed ids
 * (empty: every model the provider lists); `system1` the model decisions and `fast` run on, `system2` the one `default`
 * runs on, `strong` an optional override for the `strong` class (null/absent: falls back to `system2`, then the host's own).
 * `system`: system agents, which work with no person attending. `improve` lets the host start them (its automatic
 * improvement); `automations` lets an automation start them (`ctx.ai.sys_2.task`). `policies` is what one the host
 * starts holds (none: it reads no record); `monthly` caps their spend this calendar month and `task` one's whole spend.
 */
export const AgentSettings = Schema.Struct({
	monthly: Schema.NullOr(Usd),
	member: Schema.NullOr(Usd),
	policies: Schema.Record(Schema.String, Usd).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed({}))
	),
	models: Schema.Array(Schema.String),
	system1: ModelPick,
	system2: ModelPick,
	strong: Schema.optionalKey(Schema.NullOr(Schema.String)),
	system: Schema.Struct({
		improve: Schema.Boolean,
		automations: Schema.Boolean,
		policies: Schema.Array(Schema.String),
		monthly: Schema.NullOr(Usd),
		task: Schema.NullOr(Usd)
	}).pipe(Schema.withDecodingDefaultKey(Effect.succeed(SYSTEM_AGENTS)))
});
export type AgentSettings = typeof AgentSettings.Type;
const NONE: AgentSettings = {
	monthly: null,
	member: null,
	policies: {},
	models: [],
	system1: null,
	system2: null,
	system: SYSTEM_AGENTS
};

/** Optional member/policy attribution for facility AI calls (`infer_facility`, `sys_1`, `embed`). */
export const SpendActor = Context.Reference<
	{ readonly member: string | null; readonly policies: readonly string[] } | undefined
>('bolt/SpendActor', { defaultValue: () => undefined });

const SPEND_MONTH_SQL = `to_char(date_trunc('month', now() AT TIME ZONE 'UTC'), 'YYYY-MM')`;

export const agentSettings = (db: TenantDbShape) =>
	db
		.one(Schema.Struct({ value: Schema.fromJsonString(AgentSettings) }), {
			text: `SELECT value FROM sys_config WHERE key = '${AGENT_KEY}'`,
			params: []
		})
		.pipe(Effect.map((row) => Option.match(row, { onNone: () => NONE, onSome: (r) => r.value })));

export const saveAgentSettings = (db: TenantDbShape, s: AgentSettings) =>
	db.write({
		text: `INSERT INTO sys_config (key, value) VALUES ('${AGENT_KEY}', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
		params: [JSON.stringify(s)]
	});

/** Atomically records non-chat AI facility spend (`infer_facility`, `sys_1`, `embed`) in the current UTC month bucket. */
export const recordSpend = Effect.fn('Agents.recordSpend')(function* (
	db: TenantDbShape,
	costUsd: number,
	member: string | null = null
) {
	if (!Number.isFinite(costUsd) || costUsd <= 0) return;
	yield* db.write({
		text: `INSERT INTO sys_config (key, value)
			VALUES ('agent.spend.' || ${SPEND_MONTH_SQL}, ($1::float8)::text)
			ON CONFLICT (key) DO UPDATE SET value = ((coalesce(nullif(sys_config.value, ''), '0')::float8) + $1::float8)::text`,
		params: [costUsd]
	});
	if (member !== null)
		yield* db.write({
			text: `INSERT INTO sys_config (key, value)
				VALUES ('agent.spend.' || ${SPEND_MONTH_SQL} || '.m.' || $2, ($1::float8)::text)
				ON CONFLICT (key) DO UPDATE SET value = ((coalesce(nullif(sys_config.value, ''), '0')::float8) + $1::float8)::text`,
			params: [costUsd, member]
		});
});

/** What replies and AI facilities cost this calendar month (UTC): the workspace's, and `member`'s own (sub-agents included). */
export const spent = (db: TenantDbShape, member: string | null) =>
	db.value(Schema.Number, {
		text: `SELECT (
			coalesce((
				SELECT sum((m.meta->'usage'->>'cost')::float8)
				FROM sys_message m JOIN sys_conversation c ON c.id = m.conversation
				WHERE m.copied_from IS NULL AND m.meta->>'tag' IN ('reply', 'failed')
				  AND m.created_at >= date_trunc('month', now())
				  AND ($1::text IS NULL OR c.owner = $1)
			), 0)
			+ coalesce((
				SELECT (nullif(value, ''))::float8
				FROM sys_config
				WHERE key = CASE
					WHEN $1::text IS NULL THEN 'agent.spend.' || ${SPEND_MONTH_SQL}
					ELSE 'agent.spend.' || ${SPEND_MONTH_SQL} || '.m.' || $1
				END
			), 0)
		)::float8`,
		params: [member]
	});

/** A member's monthly cap: the most generous of their policies' caps, else the default. */
export const memberCap = (s: AgentSettings, policies: readonly string[]) => {
	const caps = policies.flatMap((p) => (s.policies[p] === undefined ? [] : [s.policies[p]]));
	return caps.length > 0 ? Math.max(...caps) : s.member;
};

/**
 * The limit a new step would cross, or null: the workspace's first, then the member's (by their policies).
 * `inFlightUsd` includes uncommitted spend accumulated earlier in the current turn.
 */
export const overLimit = Effect.fn('Agents.overLimit')(function* (
	db: TenantDbShape,
	s: AgentSettings,
	member: string | null,
	policies: readonly string[],
	inFlightUsd: number = 0
) {
	const inFlight = Number.isFinite(inFlightUsd) && inFlightUsd > 0 ? inFlightUsd : 0;
	if (s.monthly !== null && (inFlight >= s.monthly || (yield* spent(db, null)) + inFlight >= s.monthly))
		return 'workspace' as const;
	const cap = memberCap(s, policies);
	if (cap !== null && member !== null && (inFlight >= cap || (yield* spent(db, member)) + inFlight >= cap))
		return 'member' as const;
	return null;
});

/** What system agents' tasks cost: this calendar month (UTC) across all of them, or `task`'s alone since it began. */
const tasksSpent = (db: TenantDbShape, task: string | null) =>
	db.value(Schema.Number, {
		text: `SELECT coalesce(sum((m.meta->'usage'->>'cost')::float8), 0)::float8
			FROM sys_message m JOIN sys_conversation c ON c.id = m.conversation
			WHERE c.kind = '${TASK}' AND m.copied_from IS NULL AND m.meta->>'tag' IN ('reply', 'failed')
			  AND CASE WHEN $1::text IS NULL THEN m.created_at >= date_trunc('month', now()) ELSE c.id = $1 END`,
		params: [task]
	});

/**
 * The system limit a task's next step would cross, or null: the month's first, then the task's own. `task` null asks
 * whether a new task may start.
 */
export const overTaskLimit = Effect.fn('Agents.overTaskLimit')(function* (
	db: TenantDbShape,
	s: AgentSettings,
	task: string | null,
	inFlightUsd: number = 0
) {
	const { monthly, task: each } = s.system;
	if (monthly !== null && (yield* tasksSpent(db, null)) + inFlightUsd >= monthly) return 'monthly' as const;
	if (each !== null && task !== null && (yield* tasksSpent(db, task)) + inFlightUsd >= each)
		return 'task' as const;
	return null;
});

/** A model a turn may run: its own when allowed (or every model is), else the first allowed. */
export const allowedModel = (s: AgentSettings, model: string) => {
	const [first] = s.models;
	return first === undefined || s.models.includes(model) ? model : first;
};

const spendLimitError = (tripped: 'workspace' | 'member') =>
	new FacilityFailure({
		kind: 'invalid',
		message:
			tripped === 'member'
				? 'Monthly member AI spending limit reached.'
				: 'Monthly workspace AI spending limit reached.'
	});

/**
 * The host's AI under the administrator's picks and monthly spend caps:
 * - decisions (`ask`) run on `system1` when listed;
 * - model classes route distinctly: `'fast'` -> `system1` (or host decider model in catalog) -> `'fast'`,
 *   `'default'` -> `system2` -> `'default'`, `'strong'` -> `strong` -> `system2` -> `'strong'`;
 * - named models go as is;
 * - all `ask`, `infer`, and `embed` calls enforce workspace/member monthly spend caps, and non-chat calls
 *   (`sys_1`, `infer_facility`) record their USD cost in the monthly spend bucket.
 */
export const AdminAi = Layer.effect(
	Ai,
	Effect.gen(function* () {
		const ai = yield* Ai,
			db = yield* TenantDb,
			alerts = yield* Effect.serviceOption(WorkspaceAlertsService);
		const readSettings = agentSettings(db).pipe(
			Effect.mapError((error) => new FacilityFailure({ kind: 'upstream', message: error.message }))
		);
		const gate = (s: AgentSettings) =>
			Effect.gen(function* () {
				const actor = yield* SpendActor;
				const tripped = yield* overLimit(db, s, actor?.member ?? null, actor?.policies ?? []).pipe(
					Effect.mapError(
						(error) => new FacilityFailure({ kind: 'upstream', message: error.message })
					)
				);
				if (tripped !== null) return yield* Effect.fail(spendLimitError(tripped));
				return actor;
			});
		const safeListing = (listing: typeof ai.catalog) =>
			listing.pipe(Effect.catch(() => Effect.succeed({ models: [], default: '' })));
		const resolveClass = Effect.fn('AdminAi.resolveClass')(function* (
			model: string,
			s: AgentSettings
		) {
			if (!ai.models.includes(model)) return model;
			if (model === 'default' && s.system2 === null) return model;
			if (model === 'strong' && s.strong == null && s.system2 === null) return model;
			const cat = yield* safeListing(ai.catalog);
			const has = (id: string | null | undefined): id is string =>
				id != null && cat.models.some((m) => m.id === id);
			if (model === 'fast') {
				if (has(s.system1)) return s.system1;
				if (Ai.hasSystem1(ai)) {
					const dec = yield* safeListing(ai.deciders);
					if (has(dec.default)) return dec.default;
					const listedDecider = dec.models.find((m) => has(m.id));
					if (listedDecider !== undefined) return listedDecider.id;
				}
				return model;
			}
			if (model === 'strong') {
				if (has(s.strong)) return s.strong;
				if (has(s.system2)) return s.system2;
				return model;
			}
			return has(s.system2) ? s.system2 : model;
		});
		return {
			...ai,
			ask: Ai.hasSystem1(ai)
				? (request, model) =>
						Effect.gen(function* () {
							const s = yield* readSettings;
							const actor = yield* gate(s);
							const chosen =
								model !== undefined
									? model
									: s.system1 === null
										? undefined
										: (yield* ai.deciders).models.some((m) => m.id === s.system1)
											? s.system1
											: undefined;
							const result = yield* ai.ask(request, chosen);
							if (Number.isFinite(result.cost_usd) && result.cost_usd > 0) {
								yield* recordSpend(db, result.cost_usd, actor?.member ?? null).pipe(
									Effect.tapCause(Effect.logWarning),
									Effect.ignore
								);
								if (Option.isSome(alerts)) yield* alerts.value.checkAiSpend;
							}
							return result;
						})
				: ai.ask,
			infer: (request) =>
				Stream.unwrap(
					Effect.gen(function* () {
						const s = yield* readSettings;
						const actor = yield* gate(s);
						const model = yield* resolveClass(request.model, s);
						const stream = ai.infer(model === request.model ? request : { ...request, model });
						if (request.purpose === 'chat') return stream;
						return stream.pipe(
							Stream.tap((event) =>
								event._tag === 'Response' &&
								typeof event.response.usage.cost === 'number' &&
								Number.isFinite(event.response.usage.cost) &&
								event.response.usage.cost > 0
									? recordSpend(db, event.response.usage.cost, actor?.member ?? null).pipe(
											Effect.andThen(
												Option.isSome(alerts) ? alerts.value.checkAiSpend : Effect.void
											),
											Effect.tapCause(Effect.logWarning),
											Effect.ignore
										)
									: Effect.void
							)
						);
					})
				),
			embed: (inputs, model, dimensions) =>
				Effect.gen(function* () {
					const s = yield* readSettings;
					yield* gate(s);
					return yield* ai.embed(inputs, model, dimensions);
				})
		};
	})
);
