// The assistant's runtime settings: an administrator's monthly spending limits (the workspace's, each member's by
// default, and each member's by a policy they hold), the models members may pick and the models System 1 and System 2
// run, kept in `sys_config` under `agent` so they change without a source release. A turn refuses once a limit is
// reached; the model list narrows the picker (one model hides it) and the model a turn runs.
import { Effect, Layer, Option, Schema, Stream } from 'effect';
import { FacilityFailure } from '@norbital-ai/host-api';
import { TenantDb, type TenantDbShape } from '../db/tenant-db.ts';
import { Ai } from '../ports.ts';

export const AGENT_KEY = 'agent';
const Usd = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
const ModelPick = Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null)));
/**
 * Monthly caps in USD: `monthly` the workspace's spend this calendar month, `member` each member's by default, `policies`
 * each member's by a policy they hold (the most generous of theirs wins over the default); `models` the allowed ids
 * (empty: every model the provider lists); `system1` the model decisions run on, `system2` the one every model class
 * and a new conversation run on (null: the host's own).
 */
export const AgentSettings = Schema.Struct({
	monthly: Schema.NullOr(Usd),
	member: Schema.NullOr(Usd),
	policies: Schema.Record(Schema.String, Usd).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed({}))
	),
	models: Schema.Array(Schema.String),
	system1: ModelPick,
	system2: ModelPick
});
export type AgentSettings = typeof AgentSettings.Type;
const NONE: AgentSettings = {
	monthly: null,
	member: null,
	policies: {},
	models: [],
	system1: null,
	system2: null
};

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

/** What replies cost this calendar month (UTC): the workspace's, and `member`'s own conversations' (sub-agents included). */
export const spent = (db: TenantDbShape, member: string | null) =>
	db.value(Schema.Number, {
		text: `SELECT coalesce(sum((m.meta->'usage'->>'cost')::float8), 0)::float8 FROM sys_message m JOIN sys_conversation c ON c.id = m.conversation
			WHERE m.copied_from IS NULL AND m.meta->>'tag' IN ('reply', 'failed') AND m.created_at >= date_trunc('month', now()) AND ($1::text IS NULL OR c.owner = $1)`,
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

/** A model a turn may run: its own when allowed (or every model is), else the first allowed. */
export const allowedModel = (s: AgentSettings, model: string) => {
	const [first] = s.models;
	return first === undefined || s.models.includes(model) ? model : first;
};

/**
 * The host's AI under the administrator's picks: decisions run on `system1` and every model class (`default fast
 * strong`) on `system2`, each while its provider still lists it; otherwise the host's own. A named model goes as is.
 */
export const AdminAi = Layer.effect(
	Ai,
	Effect.gen(function* () {
		const ai = yield* Ai,
			db = yield* TenantDb;
		// ponytail: one sys_config read per call; cache per generation if decisions get hot
		const picked = (pick: 'system1' | 'system2', listing: typeof ai.catalog) =>
			agentSettings(db).pipe(
				Effect.mapError((error) => new FacilityFailure({ kind: 'upstream', message: error.message })),
				Effect.flatMap((s) => {
					const id = s[pick];
					return id === null
						? Effect.succeed(undefined)
						: listing.pipe(Effect.map((l) => (l.models.some((m) => m.id === id) ? id : undefined)));
				})
			);
		return {
			...ai,
			ask: Ai.hasSystem1(ai)
				? (request, model) =>
						model === undefined
							? picked('system1', ai.deciders).pipe(Effect.flatMap((id) => ai.ask(request, id)))
							: ai.ask(request, model)
				: ai.ask,
			infer: (request) =>
				ai.models.includes(request.model)
					? Stream.unwrap(
							picked('system2', ai.catalog).pipe(
								Effect.map((id) => ai.infer(id === undefined ? request : { ...request, model: id }))
							)
						)
					: ai.infer(request)
		};
	})
);
