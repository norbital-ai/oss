import {
	Crypto,
	Cause,
	Clock,
	Config,
	ConfigProvider,
	Context,
	Deferred,
	Effect,
	FiberHandle,
	FiberSet,
	Layer,
	Option,
	Predicate,
	PubSub,
	Random,
	Redacted,
	Result,
	Schema,
	Semaphore
} from 'effect';
import type { Json } from '../../decl/values.ts';
import type { Holder } from '../access/authority.ts';
import { issueAutomationDelegation, delegatedVerbAuthority } from '../access/delegation.ts';
import { Port, type PortFailure } from '../port.ts';
import { AgentHost } from '../agent/index.ts';
import { inferFacility, type InferTool } from '../agent/ai.ts';
import { readTool } from '../agent/tools.ts';
import {
	LIMITS,
	type Authority,
	type Bindings,
	type CrossAnswer,
	type GuestOutcome
} from '../contracts.ts';
import { isTransient, type EngineError } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import { withRequestCpu } from '../guest/request-cpu.ts';
import { TenantDb } from '../db/tenant-db.ts';
import { Ai, Drivers, Transport } from '../ports.ts';
import {
	Activation,
	Callables,
	Deadlines,
	Facilities,
	Guest,
	Identity,
	Live,
	Manifest,
	Reads,
	RunHandlers,
	Runs,
	Wake,
	Writes,
	type CrossCall,
	type FacilityCall,
	type RetrySpec,
	type RunHandler
} from '../services.ts';
import { actorRef } from '../write/commit.ts';
import {
	answer,
	canonical,
	Chain,
	GATED,
	noticeCaptures,
	noticeInsert,
	sha256Hex
} from '../write/sql.ts';
import { pruneHistory } from '../query/history.ts';
import { localOf } from '@norbital-ai/std/zone';
import { encodeWire } from '@norbital-ai/std/wire';
import { decodeInput } from '../callables/decode.ts';
import { DecisionTrace, readableFile, storedFiles } from '../decisions/index.ts';
import { prepareSend, sendPiece } from '../conversations/outbound.ts';
import { instanceRequest } from '../integrations/instances.ts';
import { feedsOf } from '../integrations/feeds.ts';
import { verifiedWebhook, type WebhookRequest } from './webhook.ts';
import { nextSlot } from './cron.ts';
import { enqueue, nextDue, triggersOf } from './queue.ts';
import { BUCKET_MS, backoffMs, dueAt, iso, offsetMs } from './time.ts';
import { NOTICE_PUSH, noticePush } from './push.ts';
const Member = Schema.Struct({
	kind: Schema.Literal('member'),
	id: Schema.String,
	email: Schema.NullOr(Schema.String),
	phone: Schema.NullOr(Schema.String),
	external: Schema.Boolean,
	teams: Schema.Array(Schema.String),
	teamPath: Schema.Array(Schema.String),
	admin: Schema.Boolean,
	party: Schema.NullOr(Schema.Struct({ collection: Schema.String, id: Schema.String }))
});
const Actor = Schema.Union([
	Member,
	Schema.Struct({
		kind: Schema.Literal('envoy'),
		envoy: Schema.String,
		instance: Schema.String,
		sender: Schema.String,
		member: Schema.NullOr(Schema.String),
		linked: Schema.optionalKey(Member)
	}),
	Schema.Struct({ kind: Schema.Literal('visitor'), app: Schema.String, visitor: Schema.String }),
	Schema.Struct({ kind: Schema.Literal('apiKey'), key: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal('system'),
		run: Schema.String,
		by: Schema.Union([
			Schema.Struct({ automation: Schema.String }),
			Schema.Struct({ platform: Schema.String }),
			Schema.Struct({ integration: Schema.String, instance: Schema.String, feed: Schema.String }),
			Schema.Struct({
				integration: Schema.String,
				instance: Schema.String,
				outbound: Schema.String
			})
		])
	})
]);
const HolderSchema = Schema.Struct({
	actor: Actor,
	policies: Schema.Array(Schema.String),
	admin: Schema.Boolean,
	platform: Schema.optionalKey(Schema.Boolean),
	teamTree: Schema.optionalKey(Schema.Array(Schema.String)),
	scopes: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String)))
});
const RowSchema = Schema.Struct({
	id: Schema.String,
	automation: Schema.String,
	input: Schema.Json,
	due_at: Schema.String,
	run_key: Schema.NullOr(Schema.String),
	cause: Schema.String,
	depth: Schema.Number,
	attempts: Schema.Number,
	leases: Schema.Number,
	actor: Schema.NullOr(Schema.String),
	starter: Schema.NullOr(HolderSchema)
});
type Row = typeof RowSchema.Type;
export const RunViewRow = Schema.Struct({
	id: Schema.String,
	automation: Schema.String,
	cause: Schema.String,
	state: Schema.String,
	due_at: Schema.String,
	started: Schema.NullOr(Schema.String),
	progress: Schema.Json,
	output: Schema.Json,
	error: Schema.NullOr(
		Schema.Struct({ code: Schema.String, message: Schema.optionalKey(Schema.String) })
	),
	attempts: Schema.Number,
	results: Schema.Json,
	input: Schema.Json,
	actor: Schema.NullOr(Schema.String),
	starter: Schema.NullOr(HolderSchema)
});
export type RunViewRow = typeof RunViewRow.Type;
/** Actual output and authorization columns for a stored automation-file candidate. */
export const RunOutputRow = Schema.Struct({
	id: Schema.String,
	automation: Schema.String,
	output: Schema.Json,
	starter: Schema.NullOr(HolderSchema)
});
export function readsRunResult(
	authority: Authority,
	row: Pick<typeof RunOutputRow.Type, 'automation' | 'starter'>
): boolean {
	const starter = row.starter?.actor;
	return (
		authority.admin ||
		authority.automations.includes(row.automation) ||
		(starter !== undefined && canonical(starter) === canonical(authority.actor))
	);
}
export type RunView = {
	id: string;
	automation: string;
	cause: string;
	status: string;
	due_at: string;
	started: string | null;
	progress: Json;
	error: {
		code: string;
		message?: string | undefined;
	} | null;
	attempt_count: number;
	result?: Json;
	input?: Json;
	attempts?: Json;
};
export const RUN_VIEW_COLUMNS = `id, automation, cause, state, due_at::text AS due_at, started_at::text AS started, progress, output, error, attempts, results, input, actor, starter`;
export function runView(authority: Authority, row: RunViewRow): RunView | null {
	const base = {
		id: row.id,
		automation: row.automation,
		cause: row.cause,
		status: row.state,
		due_at: row.due_at,
		started: row.started,
		progress: row.progress,
		attempt_count: row.attempts
	};
	if (readsRunResult(authority, row))
		return {
			...base,
			error: row.error,
			...(row.output === null ? {} : { result: row.output }),
			input: row.input,
			attempts: row.results
		};
	return row.actor === actorRef(authority.actor)
		? { ...base, error: row.error === null ? null : { code: row.error.code } }
		: null;
}
/** `web_read` in an automation's infer: a public document as plain text, one window per call. */
const WEB_READ_WINDOW = 20_000;
const WebReadInput = Schema.Struct({
	url: Schema.String,
	from: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
	find: Schema.optionalKey(Schema.String)
});
const WebReadPage = Schema.Struct({
	url: Schema.String,
	title: Schema.NullOr(Schema.String),
	text: Schema.String,
	pages: Schema.optionalKey(Schema.Number)
});
/** The text from `from`, or with `find` the passages around any of its words, at most one window; `next` reads on. */
export const webReadWindow = (
	page: typeof WebReadPage.Type,
	from = 0,
	find?: string
): { [key: string]: Json } => {
	const words = (find ?? '')
		.toLowerCase()
		.split(/\s+/)
		.filter((word) => word !== '');
	const lower = page.text.toLowerCase();
	const spans: [number, number][] = [];
	if (words.length > 0)
		for (const word of words)
			for (
				let at = lower.indexOf(word, from);
				at !== -1;
				at = lower.indexOf(word, at + word.length)
			)
				spans.push([Math.max(from, at - 400), Math.min(page.text.length, at + word.length + 400)]);
	spans.sort((a, b) => a[0] - b[0]);
	const merged = spans.reduce<[number, number][]>((all, span) => {
		const last = all.at(-1);
		if (last !== undefined && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
		else all.push([...span]);
		return all;
	}, []);
	let text = '',
		next: number | undefined;
	for (const [start, end] of words.length > 0
		? merged
		: [[from, page.text.length] as [number, number]]) {
		const room = WEB_READ_WINDOW - text.length;
		if (room <= 0) {
			next = start;
			break;
		}
		text += (text === '' ? '' : '\n…\n') + page.text.slice(start, Math.min(end, start + room));
		if (end - start > room) {
			next = start + room;
			break;
		}
	}
	return {
		url: page.url,
		title: page.title,
		characters: page.text.length,
		...(page.pages === undefined ? {} : { pages: page.pages }),
		text: words.length > 0 && text === '' ? '(no passage has any of those words)' : text,
		...(next === undefined ? {} : { next })
	};
};
const EVENTS = new Set(['created', 'updated', 'deleted']);
const MAX_IDS = 10000,
	DAY = 86400000,
	LANES = 1;
const PRUNE = 'bolt.prune';
export class Nudges extends Context.Service<Nudges, PubSub.PubSub<number>>()('bolt/Nudges') {}
export const WakeLive = Layer.effect(
	Wake,
	Effect.gen(function* () {
		const deadlines = yield* Deadlines,
			nudges = yield* Nudges;
		return {
			at: (at: string) =>
				deadlines
					.announce(at)
					.pipe(Effect.andThen(PubSub.publish(nudges, Date.parse(at))), Effect.asVoid)
		};
	})
).pipe(Layer.provideMerge(Layer.effect(Nudges, PubSub.unbounded<number>())));
export const EventRetention = Context.Reference<number>('bolt/EventRetention', {
	defaultValue: () => 72
});
export const RunHandlersLive = Layer.sync(RunHandlers, () => {
	const handlers = new Map<string, RunHandler>(),
		retries = new Map<string, RetrySpec>();
	return {
		register: (
			next: {
				readonly [name: string]: RunHandler;
			},
			policy: {
				readonly [name: string]: RetrySpec;
			} = {}
		) =>
			Effect.sync(() => {
				for (const [name, handler] of Object.entries(next)) handlers.set(name, handler);
				for (const [name, retry] of Object.entries(policy)) retries.set(name, retry);
			}),
		handler: (name: string) => Effect.sync(() => Option.fromNullishOr(handlers.get(name))),
		retry: (name: string) => Effect.sync(() => Option.fromNullishOr(retries.get(name)))
	};
});
const fail = (code: string, message: string): CrossAnswer => ({
	ok: false,
	error: { kind: 'bolt', code, message }
});
const failure = (error: EngineError): CrossAnswer =>
	fail(error._tag === 'BoltError' ? error.code : 'internal', error.message);
const JournalAnswer = Schema.Union([
	Schema.Struct({
		ok: Schema.Literal(true),
		value: Schema.Json,
		journal: Schema.optionalKey(Schema.Boolean)
	}),
	Schema.Struct({
		ok: Schema.Literal(false),
		error: Schema.Union([
			Schema.Struct({ kind: Schema.Literal('bolt'), code: Schema.String, message: Schema.String }),
			Schema.Struct({
				kind: Schema.Literal('unavailable'),
				facility: Schema.String,
				reason: Schema.String
			}),
			Schema.Struct({
				kind: Schema.Literals([
					'invalid',
					'tooLarge',
					'unsupported',
					'rateLimited',
					'upstream',
					'timeout'
				]),
				message: Schema.String,
				status: Schema.optionalKey(Schema.Number)
			})
		]),
		journal: Schema.optionalKey(Schema.Boolean)
	})
]);
const Notices = Schema.Array(
	Schema.Struct({
		to: Schema.Json,
		title: Schema.Json,
		body: Schema.optionalKey(Schema.Json),
		link: Schema.optionalKey(Schema.Json),
		once: Schema.optionalKey(Schema.String)
	})
);
const CreatedFile = Schema.Struct({
	id: Schema.String.check(Schema.isUUID()),
	name: Schema.String,
	mime: Schema.String,
	bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
});
export const RunsLive = Layer.effect(
	Runs,
	Effect.gen(function* () {
		const m = yield* Manifest,
			db = yield* TenantDb,
			activation = yield* Activation,
			guest = yield* Guest,
			reads = yield* Reads,
			writes = yield* Writes,
			calls = yield* Callables,
			identity = yield* Identity,
			live = yield* Live,
			facilities = yield* Facilities,
			registry = yield* RunHandlers,
			deadlines = yield* Deadlines,
			nudges = yield* Nudges,
			drivers = yield* Drivers;
		const ai = yield* Ai,
			agentHost = yield* AgentHost;
		const crypto = yield* Crypto.Crypto;
		const uuid = crypto.randomUUIDv4.pipe(
			Effect.mapError((error) =>
				BoltError.make('unavailable', 'facility', 'Secure random UUID generation failed.', error)
			)
		);
		const crons = triggersOf(m).crons.filter((trigger) => {
			if (drivers.available) return true;
			const feed = feedsOf(m).get(trigger.automation);
			return (
				feed?.from !== 'read' ||
				trigger.key !== `feed:${feed.run}:${feed.spec.cron}@${m.workspace.tz}`
			);
		});
		const retention = yield* EventRetention,
			tenant = yield* ConfigProvider.ConfigProvider;
		const stopping = new Set<string>();
		/** A running run's stop signal: `stop` completes it, which ends the crossing in flight (an inference can run 30 min). */
		const halts = new Map<string, Deferred.Deferred<void>>();
		const lanes = yield* Semaphore.make(LANES),
			tickPermit = yield* Semaphore.make(1);
		let prunedDay = -1;
		yield* registry.register({ [NOTICE_PUSH]: yield* noticePush });
		const bindingsAt = (now: number): Bindings => ({
			now: iso(now),
			today: localOf(now, m.workspace.tz).date,
			tz: m.workspace.tz,
			params: {}
		});
		const announce = (at: string) =>
			deadlines
				.announce(at)
				.pipe(Effect.andThen(PubSub.publish(nudges, Date.parse(at))), Effect.asVoid);
		const slotDue = (trigger: ReturnType<typeof triggersOf>['crons'][number], after: number) => {
			const slot = nextSlot(trigger.cron, after, trigger.tz);
			return trigger.bucket ? Math.ceil(slot / BUCKET_MS) * BUCKET_MS : slot;
		};
		const boot = (recover = true) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis,
					c = new Chain();
				c.cte(
					'lost',
					`UPDATE sys_run SET leases = leases + 1, due_at = ${c.p(iso(now))}::timestamptz, state = CASE WHEN leases < 3 THEN 'queued' ELSE 'failed' END, error = CASE WHEN leases < 3 THEN error ELSE '{"code":"lostLease","message":"The run lost its lease 3 times."}'::jsonb END WHERE state = 'running' AND ${c.p(recover)} RETURNING id, state, due_at`
				);
				c.cte(
					'gone',
					`DELETE FROM sys_run WHERE state = 'queued' AND cause = 'cron' AND NOT (jsonb_build_array(automation, key) IN (SELECT e.value FROM jsonb_array_elements(${c.p(crons.map((trigger) => [trigger.automation, trigger.key]))}::jsonb) e)) RETURNING id`
				);
				const slots = enqueue(
					c,
					{
						select:
							crons.length === 0
								? `SELECT NULL::text AS automation WHERE false`
								: `SELECT gen_random_uuid()::text AS id, v.automation, '{}'::jsonb AS input, v.due::timestamptz AS due_at, v.key, 'cron'::text AS cause, 0 AS depth FROM jsonb_to_recordset(${c.p(crons.map((trigger) => ({ automation: trigger.automation, key: trigger.key, due: iso(slotDue(trigger, now)) })))}::jsonb) v(automation text,key text,due text) WHERE NOT EXISTS (SELECT 1 FROM sys_run r WHERE r.automation = v.automation AND (r.key = v.key OR (r.run_key = v.key AND r.state = 'running')))`
					},
					{ conflict: 'keep' }
				);
				if (activation.start.length > 0) {
					c.cte(
						'admitted',
						`INSERT INTO bolt_run_admitted (at) SELECT ${c.p(iso(now))}::timestamptz WHERE NOT EXISTS (SELECT 1 FROM bolt_run_admitted) RETURNING at`
					);
					enqueue(c, {
						select: `SELECT a AS automation, '{}'::jsonb AS input, x.at AS due_at, 'start'::text AS cause, 0 AS depth FROM admitted x, jsonb_array_elements_text(${c.p(activation.start)}::jsonb) a`
					});
				}
				const rows = yield* db.returning(
					Schema.Struct({ next: Schema.NullOr(Schema.String) }),
					c.sql(
						`least((SELECT min(due_at) FROM sys_run WHERE state = 'queued' AND id NOT IN (SELECT id FROM gone)), (SELECT min(due_at) FROM ${slots}), (SELECT min(due_at) FROM lost WHERE state = 'queued'), ${nextDue(c)})::text AS next`
					)
				);
				yield* deadlines.settle(rows[0]?.next ?? null);
			});
		const claim = (now: number, pruned = false, custom = false) =>
			Effect.gen(function* () {
				const c = new Chain(),
					automations = c.p(Object.keys(m.automations)),
					due = c.p(iso(now)),
					eligible = `r.state = 'queued' AND r.due_at <= ${due}::timestamptz AND (NOT ${c.p(pruned)} OR r.automation <> ${c.p(PRUNE)}) AND NOT EXISTS (SELECT 1 FROM sys_run x WHERE x.automation = r.automation AND x.state = 'running')`;
				if (custom) {
					c.cte(
						'head',
						`SELECT r.* FROM sys_run r WHERE ${eligible} AND r.automation IN (SELECT jsonb_array_elements_text(${automations}::jsonb)) ORDER BY r.due_at, r.id LIMIT 1 FOR UPDATE SKIP LOCKED`
					);
					c.cte(
						'pending',
						`SELECT r.* FROM sys_run r, head h WHERE ${eligible} AND r.automation = h.automation AND (r.id = h.id OR (h.cause IN ('created', 'updated', 'deleted') AND r.cause = h.cause AND (r.input->>'collection') IS NOT DISTINCT FROM (h.input->>'collection'))) ORDER BY r.due_at, r.id LIMIT 1000`
					);
				}
				// The batch must be computed once, rather than rescanned for every queued candidate.
				const batch = custom
					? `WITH batch AS MATERIALIZED (SELECT id, row_number() OVER (ORDER BY due_at, id) AS position, sum(CASE WHEN jsonb_typeof(input->'ids') = 'array' THEN jsonb_array_length(input->'ids') ELSE 0 END) OVER (ORDER BY due_at, id) AS ids FROM pending)`
					: '';
				c.cte(
					'claimed',
					`${batch} UPDATE sys_run s SET state = 'running', attempts = s.attempts + 1, started_at = ${due}::timestamptz, run_key = coalesce(s.key, s.run_key), key = CASE WHEN s.cause = 'cron' OR s.automation IN (SELECT jsonb_array_elements_text(${automations}::jsonb)) THEN NULL ELSE s.key END WHERE s.state = 'queued' AND s.id IN (SELECT r.id FROM sys_run r WHERE ${eligible} AND ${custom ? `r.id IN (SELECT id FROM batch WHERE position = 1 OR ids <= ${c.p(MAX_IDS)})` : `r.automation NOT IN (SELECT jsonb_array_elements_text(${automations}::jsonb))`} ORDER BY r.due_at, r.id LIMIT 1000 FOR UPDATE SKIP LOCKED) RETURNING s.*`
				);
				const rows = yield* db.returning(
					Schema.Struct({ runs: Schema.Array(RowSchema), next: Schema.NullOr(Schema.String) }),
					c.sql(
						`(SELECT coalesce(jsonb_agg(to_jsonb(x) || jsonb_build_object('due_at', x.due_at::text) ORDER BY x.due_at, x.id), '[]'::jsonb) FROM claimed x) AS runs, (SELECT min(due_at)::text FROM sys_run WHERE state = 'queued' AND id NOT IN (SELECT id FROM claimed)) AS next`
					)
				);
				return rows[0] ?? { runs: [], next: null };
			});
		const batches = (rows: readonly Row[]): Row[][] => {
			const out: Row[][] = [];
			for (const group of Map.groupBy(
				rows,
				(row) =>
					`${row.automation}\u0000${EVENTS.has(row.cause) ? `${row.cause}\u0000${Predicate.isObject(row.input) ? String(row.input['collection'] ?? '') : ''}` : row.id}`
			).values()) {
				let batch: Row[] = [],
					count = 0;
				for (const row of group) {
					const size =
						Predicate.isObject(row.input) && Array.isArray(row.input['ids'])
							? row.input['ids'].length
							: 0;
					if (batch.length > 0 && count + size > MAX_IDS) {
						out.push(batch);
						batch = [];
						count = 0;
					}
					batch.push(row);
					count += size;
				}
				if (batch.length > 0) out.push(batch);
			}
			return out;
		};
		const prune = Effect.fn('Runs.prune')(function* (
			now: number
		): Effect.fn.Return<{ deleted: number; continued?: number }, EngineError> {
			const aged = {
				sys_run: `state IN ('succeeded', 'failed', 'stopped', 'skipped') AND finished_at < $1::timestamptz - interval '90 days'`,
				// a pruned run's journal goes with it, in this pass or (past the cap) as an orphan in a later one
				bolt_idem: `(run IS NOT NULL AND (run IN (SELECT id FROM sel_sys_run) OR NOT EXISTS (SELECT 1 FROM sys_run r WHERE r.id = bolt_idem.run)))
				OR (run IS NULL AND issued_at < $1::timestamptz - interval '24 hours')`,
				sys_event: `at < $1::timestamptz - make_interval(hours => $2::int)`,
				bolt_rate: `window_start < $1::timestamptz - interval '1 day'`,
				sys_notification: `(read_at < $1::timestamptz - interval '90 days') OR at < $1::timestamptz - interval '365 days'`, // L-BOLT-354
				bolt_host_nonce: `at < $1::timestamptz - CASE WHEN key LIKE 'nonce:%' THEN interval '10 minutes' ELSE interval '30 days' END`
			};
			const tables = Object.keys(aged);
			const ctes = Object.entries(aged).map(
				([
					t,
					where
				]) => `sel_${t} AS (SELECT ctid${t === 'sys_run' ? ', id' : ''} FROM ${t} WHERE ${where} LIMIT ${MAX_IDS}),
			del_${t} AS (DELETE FROM ${t} WHERE ctid IN (SELECT ctid FROM sel_${t}) RETURNING 1)`
			);
			const counts = tables.map(
				(t) =>
					`(SELECT count(*) FROM sel_${t})::int AS "sel_${t}", (SELECT count(*) FROM del_${t})::int AS "del_${t}"`
			);
			const [r] = (yield* db.write({
				text: `WITH ${ctes.join(',\n')} SELECT ${counts.join(', ')}`,
				params: [iso(now), retention]
			})).rows;
			const selected = tables.reduce((n, t) => n + Number(r?.[`sel_${t}`] ?? 0), 0),
				deleted = tables.reduce((n, t) => n + Number(r?.[`del_${t}`] ?? 0), 0);
			// the history horizon (rule 17, L-BOLT-182): 256 revisions per row, never an open restore point or an erased revision
			// ponytail: uncapped by rule 25a's 10,000; cap it with a ctid select if a backlog ever makes this pass long
			const pruned = yield* pruneHistory(db);
			if (selected > 0 && deleted === 0)
				return yield* Effect.fail(
					BoltError.make(
						'noProgress',
						'commit',
						`bolt.prune: a pass selected ${selected} rows and deleted 0; it stops (rule 25a)`
					)
				);
			if (!tables.some((t) => Number(r?.[`sel_${t}`] ?? 0) >= MAX_IDS))
				return { deleted: deleted + pruned };
			const c = new Chain();
			enqueue(c, [{ automation: PRUNE, input: {}, dueAt: iso(now), cause: 'continue', depth: 0 }], {
				when: `NOT EXISTS (SELECT 1 FROM sys_run WHERE automation = ${c.p(PRUNE)} AND state = 'queued')`
			});
			yield* db.write(c.sql('NULL AS outcome'));
			return { deleted: deleted + pruned, continued: now };
		});
		const invoke = (
			run: Row,
			ids: readonly string[],
			holder: Holder,
			input: Json,
			dues: number[],
			warnings: string[]
		) =>
			Effect.gen(function* () {
				const cause = yield* Schema.decodeUnknownEffect(
					Schema.Literals([
						'cron',
						'webhook',
						'created',
						'updated',
						'deleted',
						'schedule',
						'start',
						'retry'
					])
				)(run.cause).pipe(
					Effect.mapError(() =>
						BoltError.make('invalidInput', 'admission', 'The automation run has an unknown cause.')
					)
				);
				const now = yield* Clock.currentTimeMillis,
					b = bindingsAt(now),
					authority = yield* identity.authority(holder);
				const delegation = issueAutomationDelegation(m, authority, run.id, run.automation);
				const replaying = run.attempts > 1 || run.leases > 0;
				const journal = new Map<string, Json>();
				const createdFiles = new Set<string>();
				const halt = yield* Deferred.make<void>();
				halts.set(run.id, halt);
				if (replaying) {
					const rows = yield* db.rows(Schema.Struct({ key: Schema.String, outcome: Schema.Json }), {
						text: `SELECT i.key, o.outcome FROM bolt_idem i JOIN bolt_idem_outcome o USING (key) WHERE i.run = $1`,
						params: [run.id]
					});
					for (const row of rows) journal.set(row.key, row.outcome);
				}
				const seen = new Map<string, number>();
				const keyOf = (kind: string, target: string, args: Json) => {
					const digest = sha256Hex(canonical([kind, target, args])),
						ordinal = seen.get(digest) ?? 0;
					seen.set(digest, ordinal + 1);
					return { key: `${run.id}:${digest}:${ordinal}`, digest };
				};
				const hit = (key: string) => {
					const value = journal.get(key);
					journal.delete(key);
					return value;
				};
				const journalled = (
					key: string,
					digest: string,
					pieces: (c: Chain) => void,
					outcome: (c: Chain) => string
				) =>
					Effect.gen(function* () {
						const c = new Chain();
						c.cte(
							'idem',
							`INSERT INTO bolt_idem (key, digest, issued_at, run) VALUES (${c.p(key)}, ${c.p(digest)}, ${c.p(b.now)}::timestamptz, ${c.p(run.id)}) ON CONFLICT (key) DO NOTHING RETURNING key`
						);
						pieces(c);
						const rows = yield* db.returning(
							Schema.Struct({
								outcome: Schema.Json,
								notices: Schema.Array(
									Schema.Struct({
										collection: Schema.String,
										id: Schema.String,
										op: Schema.Literals(['create', 'update', 'delete']),
										revision: Schema.Number,
										old: Schema.NullOr(Schema.Record(Schema.String, Schema.Json)),
										new: Schema.NullOr(Schema.Record(Schema.String, Schema.Json)),
										cause: Schema.Literals(['direct', 'derived', 'cascade', 'erased'])
									})
								),
								next_due: Schema.NullOr(Schema.String)
							}),
							c.sql(
								`${answer(c, key, digest, outcome(c))}, ${noticeCaptures(c)} AS notices, (${nextDue(c)})::text AS next_due`
							)
						);
						const result = rows[0];
						if (result === undefined)
							return yield* Effect.fail(
								BoltError.make('internal', 'commit', 'a journal statement returned no answer')
							);
						live.publish(result.notices);
						if (result.next_due !== null) yield* announce(result.next_due);
						return result.outcome;
					});
				const replayAnswer = (value: Json): Effect.Effect<CrossAnswer, BoltError> =>
					Schema.decodeUnknownEffect(JournalAnswer)(value).pipe(
						Effect.map((answer): CrossAnswer => ({ ...answer, journal: true })),
						Effect.mapError(() =>
							BoltError.make('corrupt', 'guest', 'a run journal contains an invalid answer')
						)
					);
				const rememberFile = (call: FacilityCall, answer: CrossAnswer) =>
					Effect.gen(function* () {
						if (
							!answer.ok ||
							!(
								call._tag === 'files.put' ||
								call._tag === 'convert.document' ||
								call._tag === 'ai.speak' ||
								(call._tag === 'files.image' &&
									Predicate.isObject(call.args[1]) &&
									call.args[1]['jpeg'] !== undefined)
							)
						)
							return;
						const file = yield* Schema.decodeUnknownEffect(CreatedFile)(answer.value).pipe(
							Effect.mapError(() =>
								BoltError.make('corrupt', 'guest', 'a file creation answered an invalid FileRef')
							)
						);
						createdFiles.add(file.id);
					});
				const checkFiles = (call: FacilityCall) =>
					Effect.gen(function* () {
						const refs: string[] = [];
						const collect = (value: Json | undefined) => {
							if (Predicate.isObject(value) && typeof value['id'] === 'string')
								refs.push(value['id']);
						};
						if (
							(call._tag.startsWith('files.') && call._tag !== 'files.put') ||
							call._tag === 'ai.transcribe'
						)
							collect(call.args[0]);
						if (call._tag === 'convert.document') {
							const options = call.args[1];
							if (Predicate.isObject(options)) collect(options['reference']);
						}
						if (call._tag === 'ai.embed' && Array.isArray(call.args[0]))
							for (const value of call.args[0]) collect(value);
						if (
							call._tag === 'ai.sys_2.infer' &&
							Predicate.isObject(call.args[0]) &&
							Array.isArray(call.args[0]['files'])
						)
							for (const value of call.args[0]['files']) collect(value);
						for (const id of refs) {
							const found = yield* db.one(Schema.Struct({ field: Schema.String }), {
								text: `SELECT coalesce(field, '') AS field FROM sys_file WHERE id = $1`,
								params: [id]
							});
							if (Option.isNone(found)) return false;
							if (createdFiles.has(id)) continue;
							const field = found.value.field;
							const allowed = field.includes('.')
								? yield* readableFile(
										{ manifest: m, db, read: reads.run, authority, bindings: b },
										id,
										field
									)
								: authority.admin ||
									field === run.automation ||
									authority.automations.includes(field);
							if (!allowed) return false;
						}
						return true;
					});
				const facility = (call: FacilityCall) =>
					Effect.gen(function* (): Effect.fn.Return<CrossAnswer, PortFailure> {
						if (call._tag === 'ai.sys_1.decide')
							return yield* facilities.dispatch(call).pipe(
								Effect.provideService(DecisionTrace, {
									invocation: `${run.id}:${run.attempts}`,
									run: run.id,
									automation: run.automation
								})
							);
						if (
							call._tag !== 'ai.sys_2.infer' ||
							!Predicate.isObject(call.args[0]) ||
							!Array.isArray(call.args[0]['tools'])
						)
							return yield* facilities.dispatch(call);
						const names = [...new Set(call.args[0]['tools'].map(String))];
						const hostTools = agentHost.hostTools;
						const hosted =
							typeof hostTools === 'function'
								? yield* Port.attempt('hostTools', () => hostTools(authority, run.id))
								: (hostTools ?? []);
						// `read`: workspace records as the run's `runAs` policies, through the agent's own read tool (rule 58)
						const reader =
							names.includes('read') && m.automations[run.automation]?.runAs !== 'trigger'
								? readTool({
										engine: { manifest: m, read: reads.run, calls },
										authority,
										bindings: b,
										turn: run.id,
										queries: false,
										inApp: false
									})
								: undefined;
						const missing = names.find((name) =>
							name === 'read'
								? reader === undefined
								: !(authority.admin || authority.capabilities.tools.includes(name)) ||
									(name !== 'web_read' && !hosted.some((tool) => tool.name === name))
						);
						if (missing !== undefined)
							return {
								ok: false,
								error: {
									kind: 'unavailable',
									facility: `tool ${missing}`,
									reason:
										missing === 'read'
											? "'read' needs runAs policies that grant a read"
											: `'${missing}' is not a host tool this run's policies name`
								}
							} satisfies CrossAnswer;
						const records: InferTool[] = [];
						if (reader !== undefined) {
							const document = Schema.toJsonSchemaDocument(reader.input);
							records.push({
								name: reader.name,
								description: reader.description,
								input: yield* Schema.decodeUnknownEffect(Schema.Json)({
									...document.schema,
									$defs: document.definitions
								}).pipe(Effect.mapError(Port.failure('tool read'))),
								call: (input) =>
									Effect.gen(function* () {
										const callId = yield* crypto.randomUUIDv4.pipe(
											Effect.mapError(Port.failure('tool read'))
										);
										const answer = yield* reader.run(input, callId);
										return 'result' in answer ? answer.result : { error: 'confirmation needed' };
									})
							});
						}
						// `web_read`: the workspace's own web facility (HTML, PDF and office text), for documents a browser cannot show
						if (names.includes('web_read'))
							records.push({
								name: 'web_read',
								description:
									'Read a public http(s) document as plain text: a web page, or a PDF, Word or spreadsheet file that the browser shows as empty. Answers up to 20,000 characters from `from` (default 0) and `next` when more remain; `find` answers only the passages around any of its words.',
								input: {
									type: 'object',
									properties: {
										url: { type: 'string' },
										from: { type: 'integer', minimum: 0 },
										find: { type: 'string' }
									},
									required: ['url'],
									additionalProperties: false
								},
								call: (input) =>
									Effect.gen(function* () {
										const wanted = Schema.decodeUnknownOption(WebReadInput)(input);
										if (Option.isNone(wanted))
											return { error: 'give url, and optionally from and find' };
										const answer = yield* facilities.dispatch({
											_tag: 'web.read',
											args: [wanted.value.url]
										});
										if (!answer.ok)
											return {
												error:
													'message' in answer.error ? answer.error.message : answer.error.reason
											};
										const page = Schema.decodeUnknownOption(WebReadPage)(answer.value);
										return Option.isNone(page)
											? { error: 'the document did not decode' }
											: webReadWindow(page.value, wanted.value.from, wanted.value.find);
									})
							});
						const tools: InferTool[] = hosted
							.filter((tool) => names.includes(tool.name))
							.map((tool) => ({
								name: tool.name,
								description: tool.description,
								input: tool.input,
								call: (input) =>
									Effect.gen(function* () {
										const callId = yield* crypto.randomUUIDv4.pipe(
											Effect.mapError(Port.failure(`tool ${tool.name}`))
										);
										return yield* Port.attempt(`tool ${tool.name}`, (signal) =>
											tool.call(
												input,
												{
													actor: authority.actor,
													conversation: run.id,
													turn: run.id,
													callId,
													attach: () => {}
												},
												signal
											)
										);
									})
							}));
						// each tool step is one `infer.tool` event on the run (what it read, searched or opened), as `decision.made`
						// traces a sys_1 call: the run's own record of the research it did
						const traced = (tool: InferTool): InferTool => ({
							...tool,
							call: (input) =>
								Effect.gen(function* () {
									const result = yield* Effect.result(tool.call(input));
									yield* db
										.write({
											text: "INSERT INTO sys_event (at, severity, event, invocation, run, attributes) VALUES ($1::timestamptz, $2, 'infer.tool', $3, $4, $5::jsonb)",
											params: [
												new Date(yield* Clock.currentTimeMillis).toISOString(),
												Result.isSuccess(result) ? 'info' : 'warn',
												`${run.id}:${run.attempts}`,
												run.id,
												{
													automation: run.automation,
													tool: tool.name,
													input: JSON.stringify(input).slice(0, 500),
													...(Result.isSuccess(result) ? {} : { error: result.failure.message })
												}
											]
										})
										.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
									if (Result.isFailure(result)) return yield* Effect.fail(result.failure);
									return result.success;
								})
						});
						return yield* inferFacility(ai, { load: facilities.fileLoader })(
							call,
							[...records, ...tools].map(traced)
						);
					}).pipe(
						Effect.catch((error) =>
							Effect.succeed({
								ok: false,
								error:
									error._tag === 'Unavailable'
										? { kind: 'unavailable', facility: error.facility, reason: error.reason }
										: { kind: error.kind, message: error.message }
							} satisfies CrossAnswer)
						)
					);
				const crossing = (
					call: Exclude<
						CrossCall,
						{
							_tag: 'read';
						}
					>
				): Effect.Effect<CrossAnswer, EngineError> =>
					Effect.gen(function* (): Effect.fn.Return<CrossAnswer, EngineError> {
						if (stopping.has(run.id)) return fail('stopped', 'The run was stopped.');
						switch (call._tag) {
							case 'prepareCreate':
								return fail(
									'unsupported',
									'native create preparation is available only inside a collection transform'
								);
							case 'progress': {
								const decoded = yield* Schema.decodeUnknownEffect(
									Schema.Struct({
										ratio: Schema.optionalKey(
											Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
										),
										text: Schema.optionalKey(Schema.String)
									})
								)(call.progress).pipe(
									Effect.mapError(() =>
										BoltError.make(
											'invalidInput',
											'guest',
											'progress takes { ratio?: 0..1, text?: string }'
										)
									)
								);
								const result = yield* db.returning(Schema.Struct({ state: Schema.String }), {
									text: `UPDATE sys_run SET progress = CASE WHEN state = 'running' THEN $2::jsonb ELSE progress END WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb)) RETURNING state`,
									params: [
										JSON.stringify(ids),
										JSON.stringify({
											ratio: decoded.ratio ?? null,
											text: decoded.text?.slice(0, 500) ?? null
										})
									]
								});
								if (result[0]?.state === 'stopped') {
									stopping.add(run.id);
									return fail('stopped', 'The run was stopped.');
								}
								return { ok: true, value: null };
							}
							case 'act': {
								const name =
									call.callable._tag === 'Verb'
										? `${call.callable.collection}.${call.callable.verb}`
										: call.callable._tag === 'Action'
											? `${call.callable.collection}.${call.callable.action}`
											: '';
								const { key } = keyOf(
									'act',
									name,
									call.options?.observed === undefined
										? call.input
										: { input: call.input, observed: call.options.observed }
								);
								const k = call.options?.once === undefined ? key : `once:${call.options.once}`;
								if (call.callable._tag === 'Action') {
									const result = yield* calls.action({
										collection: call.callable.collection,
										action: call.callable.action,
										input: call.input,
										key: k,
										issuedAt: b.now,
										retry: replaying,
										authority,
										bindings: b,
										invocationId: k,
										from: 'Server',
										...(call.options?.observed === undefined
											? {}
											: { observed: call.options.observed })
									});
									// a body failure settles `unknown` for a client; the automation gets the failure itself
									if (result.error !== undefined)
										return fail(result.error.code, result.error.message);
									return { ok: true, value: result.outcome };
								}
								if (call.callable._tag !== 'Verb')
									return fail('invalidInput', 'ctx.act takes a collection verb or action');
								const result = yield* writes.act({
									collection: call.callable.collection,
									verb: call.callable.verb,
									input: call.input,
									mode: { _tag: 'Direct' },
									key: k,
									issuedAt: b.now,
									retry: replaying,
									authority: delegatedVerbAuthority(m, authority, delegation, name),
									bindings: b,
									invocationId: k,
									...(call.options?.observed === undefined
										? {}
										: { observed: call.options.observed }),
									...(call.options?.onConflict === undefined
										? {}
										: { onConflict: call.options.onConflict })
								});
								return { ok: true, value: result.outcome };
							}
							case 'acts': {
								const acts = [];
								for (const act of call.acts) {
									if (act.callable._tag !== 'Verb')
										return fail('invalidInput', 'act.many takes generated verbs');
									acts.push({
										collection: act.callable.collection,
										verb: act.callable.verb,
										input: act.input
									});
								}
								const { key } = keyOf('acts', 'acts', acts);
								const result = yield* calls.acts({
									name: 'act.many',
									acts,
									key,
									issuedAt: b.now,
									authority,
									bindings: b,
									invocationId: key,
									from: 'Server'
								});
								return { ok: true, value: result.outcome };
							}
							case 'schedule': {
								const target = m.automations[call.automation];
								if (target === undefined)
									return fail('invalidInput', `no automation '${call.automation}'`);
								const self = call.automation === run.automation;
								if (self && call.at === undefined && canonical(call.input) === canonical(run.input))
									return fail(
										'hotLoop',
										'A run cannot schedule itself at once with the same input.'
									);
								const depth = self ? run.depth : run.depth + 1;
								if (depth > LIMITS.writeDepth)
									return fail('depth', `Runs chain at most ${LIMITS.writeDepth} deep.`);
								const at =
									call.at === undefined
										? now
										: typeof call.at === 'string'
											? Date.parse(call.at)
											: now + offsetMs(call.at.now);
								if (!Number.isFinite(at))
									return fail('invalidInput', 'schedule: at is not an instant');
								const { key, digest } = keyOf('schedule', call.automation, [
									call.input,
									call.at ?? null,
									call.key ?? null
								]);
								const previous = hit(key);
								if (previous !== undefined) return { ok: true, value: previous, journal: true };
								const due = iso(dueAt(now, at)),
									runKey =
										call.key === undefined
											? undefined
											: target.runAs === 'trigger'
												? `${actorRef(holder.actor)}:${call.key}`
												: call.key;
								const value = yield* journalled(
									key,
									digest,
									(c) => {
										const queued = enqueue(
											c,
											[
												{
													automation: call.automation,
													input: call.input,
													dueAt: due,
													...(runKey === undefined ? {} : { key: runKey }),
													cause: 'schedule',
													depth,
													actor: actorRef(holder.actor),
													...(target.runAs === 'trigger' ? { starter: holder } : {})
												}
											],
											{ when: GATED, conflict: 'replace' }
										);
										c.cte('scheduled', `SELECT id FROM ${queued}`);
									},
									(c) =>
										`jsonb_build_object('id', (SELECT id FROM scheduled), 'automation', ${c.p(call.automation)}::text)`
								);
								dues.push(Date.parse(due));
								return { ok: true, value };
							}
							case 'notify': {
								const notices = yield* Schema.decodeUnknownEffect(Notices)(
									Array.isArray(call.notices) ? call.notices : [call.notices]
								).pipe(
									Effect.mapError(() =>
										BoltError.make('invalidInput', 'guest', 'notify takes notices')
									)
								);
								if (
									notices.some(
										(notice) =>
											notice.to === null || (Array.isArray(notice.to) && notice.to.length === 0)
									)
								)
									return fail('invalidInput', 'notify: a notice names at least one recipient');
								const { key, digest } = keyOf('notify', '', call.notices),
									previous = hit(key);
								const report = (value: Json) => {
									if (Predicate.isObject(value) && Array.isArray(value['unaddressed']))
										for (const title of value['unaddressed'])
											warnings.push(`notify: '${String(title)}' reached no member`);
								};
								if (previous !== undefined) {
									report(previous);
									return { ok: true, value: null, journal: true };
								}
								const rows = yield* Effect.forEach(notices, (notice) =>
									Effect.map(uuid, (id) => ({
										id,
										to: notice.to,
										title:
											typeof notice.title === 'string'
												? notice.title
												: JSON.stringify(notice.title),
										body:
											notice.body === undefined
												? null
												: typeof notice.body === 'string'
													? notice.body
													: JSON.stringify(notice.body),
										link: notice.link ?? null,
										once: notice.once ?? null
									}))
								);
								report(
									yield* journalled(
										key,
										digest,
										(c) =>
											noticeInsert(
												c,
												'n',
												rows,
												b.now,
												undefined,
												m.teams,
												m.workspace.signup?.policies
											),
										() =>
											`jsonb_build_object('unaddressed', (SELECT coalesce(jsonb_agg(title), '[]'::jsonb) FROM n_to WHERE member IS NULL AND coalesce("to"->>'channel', 'inbox') = 'inbox'))`
									)
								);
								return { ok: true, value: null };
							}
							case 'send': {
								const prepared = yield* prepareSend(m, db, call.to, call.message, crypto);
								if ('error' in prepared) return fail('invalidInput', prepared.error);
								const { key, digest } = keyOf('send', call.to, call.message),
									previous = hit(key);
								if (previous !== undefined) return { ok: true, value: previous, journal: true };
								const id = yield* uuid;
								const value = yield* journalled(
									key,
									digest,
									(c) => {
										const sent = sendPiece(c, { ...prepared, id }, b.now, true);
										c.cte('sent', `SELECT id FROM ${sent}`);
									},
									() => 'to_jsonb((SELECT id FROM sent))'
								);
								return { ok: true, value };
							}
							case 'request': {
								if (call.to === null)
									return fail('invalidInput', 'ctx.request names its connection or instance');
								const { key, digest } = keyOf('request', call.to, call.operation),
									previous = hit(key);
								if (previous !== undefined) return yield* replayAnswer(previous);
								const got = yield* instanceRequest(
									{ manifest: m, db, links: drivers },
									call.to,
									call.operation
								);
								if (got.ok)
									yield* journalled(
										key,
										digest,
										() => {},
										(c) => `${c.p({ ok: true, value: got.value })}::jsonb`
									);
								return got;
							}
							default: {
								if (!(yield* checkFiles(call)))
									return {
										ok: false,
										error: { kind: 'invalid', message: 'this run cannot read file' }
									};
								const effecting =
									call._tag.startsWith('ai.') ||
									call._tag === 'convert.document' ||
									call._tag === 'files.put' ||
									(call._tag === 'files.image' &&
										Predicate.isObject(call.args[1]) &&
										call.args[1]['jpeg'] !== undefined);
								if (!effecting) return yield* facility(call);
								const stored =
									call._tag === 'ai.embed' ? yield* storedFiles(db, call.args[0]) : new Map();
								const digests = [...stored].map(([id, row]) => [id, row.sha256]).sort();
								const { key, digest } = keyOf(call._tag, '', [...call.args, digests]),
									previous = hit(key);
								if (previous !== undefined) {
									const got = yield* replayAnswer(previous);
									yield* rememberFile(call, got);
									return got;
								}
								const got = yield* facility(call);
								if (got.ok) {
									yield* rememberFile(call, got);
									yield* journalled(
										key,
										digest,
										() => {},
										(c) => `${c.p({ ok: true, value: got.value })}::jsonb`
									);
								}
								return got;
							}
						}
					});
				return yield* guest
					.invoke(
						{
							id: `${run.id}:${run.attempts}`,
							run: run.id,
							kind: 'automation',
							target: run.automation,
							input,
							ctx: {
								actor: holder.actor,
								now: b.now,
								today: b.today,
								tz: b.tz,
								seed: run.id,
								cause
							},
							budget: {
								cpuMs: LIMITS.guestCpuMs,
								crossings: LIMITS.crossings.automation,
								readBytes: LIMITS.readBytes
							}
						},
						{
							cross: (batch) =>
								Effect.gen(function* () {
									const requests = batch.flatMap((call) =>
										call._tag === 'read' ? [call.read] : []
									);
									const answers =
										requests.length === 0
											? []
											: yield* reads.run(requests, { as: 'caller', authority }, b).pipe(
													Effect.map((values) =>
														values.map((value): CrossAnswer => ({ ok: true, value }))
													),
													Effect.catch((error) =>
														Effect.succeed(requests.map(() => failure(error)))
													)
												);
									let index = 0;
									return yield* Effect.forEach(batch, (call) =>
										call._tag === 'read'
											? Effect.succeed(
													answers[index++] ?? fail('internal', 'the read returned no answer')
												)
											: crossing(call).pipe(
													Effect.catch((error) => Effect.succeed(failure(error))),
													Effect.raceFirst(
														Deferred.await(halt).pipe(
															Effect.as(fail('stopped', 'The run was stopped.'))
														)
													)
												)
									);
								})
						}
					)
					.pipe(Effect.ensuring(Effect.sync(() => halts.delete(run.id))));
			});
		const interrupted = (rows: readonly Row[], message: string) =>
			db
				.write({
					text: `UPDATE sys_run r SET error = $2::jsonb WHERE r.state = 'running' AND EXISTS (SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS x(id text, attempts int) WHERE x.id = r.id AND x.attempts = r.attempts)`,
					params: [
						JSON.stringify(rows.map((row) => ({ id: row.id, attempts: row.attempts }))),
						JSON.stringify({ code: 'interrupted', message })
					]
				})
				.pipe(Effect.asVoid);
		const execute = (rows: readonly Row[]) =>
			Effect.gen(function* () {
				const head = rows[0];
				if (head === undefined) return [];
				const now = yield* Clock.currentTimeMillis,
					spec = m.automations[head.automation],
					dues: number[] = [],
					warnings: string[] = [];
				let input: Json = head.input;
				const eventInput = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))(
					head.input
				);
				if (EVENTS.has(head.cause) && Option.isSome(eventInput))
					input = {
						...eventInput.value,
						ids: rows.flatMap((row) =>
							Predicate.isObject(row.input) && Array.isArray(row.input['ids'])
								? row.input['ids']
								: []
						),
						...(head.cause === 'deleted'
							? {
									rows: rows.flatMap((row) =>
										Predicate.isObject(row.input) && Array.isArray(row.input['rows'])
											? row.input['rows']
											: []
									)
								}
							: {})
					};
				const decoded =
					spec?.input === undefined || EVENTS.has(head.cause)
						? undefined
						: decodeInput(spec.input, input);
				let outcome: GuestOutcome;
				const handler =
					head.automation === PRUNE
						? Option.some<RunHandler>(() =>
								prune(now).pipe(Effect.map((result): Json => ({ ...result })))
							)
						: yield* registry.handler(head.automation);
				if (spec === undefined && Option.isSome(handler))
					outcome = yield* handler.value(input, head).pipe(
						Effect.map((output): GuestOutcome => ({ kind: 'ok', output, cpuMs: 0 })),
						Effect.catch((error) =>
							Effect.succeed({
								kind: 'failed',
								error:
									error._tag === 'BoltError'
										? error
										: BoltError.make('internal', 'guest', error.message, error),
								cpuMs: 0
							} satisfies GuestOutcome)
						)
					);
				else if (spec === undefined)
					outcome = {
						kind: 'failed',
						error: BoltError.make(
							'unknownAutomation',
							'admission',
							`no automation '${head.automation}'`
						),
						cpuMs: 0
					};
				else if (decoded !== undefined && decoded.problems.length > 0)
					outcome = {
						kind: 'failed',
						error: BoltError.make('invalidInput', 'decode', 'The run input did not decode.'),
						cpuMs: 0
					};
				else {
					if (decoded?.value !== undefined) input = encodeWire(decoded.value);
					const holder: Holder | undefined =
						spec.runAs === 'trigger'
							? (head.starter ?? undefined)
							: {
									actor: { kind: 'system', run: head.id, by: { automation: head.automation } },
									policies: spec.runAs,
									admin: false
								};
					if (holder === undefined)
						outcome = {
							kind: 'failed',
							error: BoltError.make('noTrigger', 'admission', 'the run has no starter'),
							cpuMs: 0
						};
					else {
						if (Predicate.isObject(input) && Array.isArray(input['rows']) && !holder.admin) {
							const authority = yield* identity.authority(holder),
								collection = typeof input['collection'] === 'string' ? input['collection'] : '';
							const arms = authority.collections[collection]?.read ?? [],
								all = arms.some((arm) => arm.fields === 'all'),
								keep = new Set([
									'id',
									'revision',
									...arms.flatMap((arm) => (arm.fields === 'all' ? [] : arm.fields))
								]);
							input = {
								...input,
								rows:
									arms.length === 0
										? []
										: all
											? input['rows']
											: input['rows'].map((row) =>
													Predicate.isObject(row)
														? Object.fromEntries(
																Object.entries(row).filter(([field]) => keep.has(field))
															)
														: row
												)
							};
						}
						outcome = yield* invoke(
							head,
							rows.map((row) => row.id),
							holder,
							input,
							dues,
							warnings
						);
					}
				}
				if (outcome.kind === 'failed' && outcome.error.code === 'interrupted') {
					yield* interrupted(rows, outcome.error.message);
					return dues;
				}
				for (const row of rows) stopping.delete(row.id);
				const platformRetry = yield* registry.retry(head.automation),
					policy = spec?.retry ?? Option.getOrUndefined(platformRetry);
				const retry =
					outcome.kind === 'failed' &&
					isTransient(outcome.error) &&
					head.attempts < (policy?.attempts ?? 1);
				const at = yield* Clock.currentTimeMillis,
					jitter = 0.5 + (yield* Random.next);
				const wait = backoffMs(policy?.backoff ?? '10s', head.attempts) * jitter,
					due = retry ? dueAt(at, at + wait) : null;
				if (due !== null) dues.push(due);
				const state = retry ? 'queued' : outcome.kind === 'ok' ? 'succeeded' : 'failed';
				const error =
					outcome.kind === 'ok'
						? null
						: outcome.kind === 'refused'
							? { code: 'refused', message: outcome.message }
							: { code: outcome.error.code, message: outcome.error.message };
				const result = {
					attempt: head.attempts,
					at: iso(at),
					state,
					...(outcome.kind === 'ok' ? { output: outcome.output } : { error }),
					...(warnings.length === 0 ? {} : { warnings }),
					...(head.cause === 'cron' && now - Date.parse(head.due_at) > 60_000
						? { missed: true }
						: {})
				};
				const c = new Chain();
				c.cte(
					'done',
					`UPDATE sys_run s SET state = ${c.p(state)}, output = ${c.p(outcome.kind === 'ok' ? JSON.stringify(outcome.output) : null)}::jsonb, error = ${c.p(error)}::jsonb, finished_at = ${state === 'queued' ? 'NULL' : `${c.p(iso(at))}::timestamptz`}, due_at = coalesce(${c.p(due === null ? null : iso(due))}::timestamptz, s.due_at), results = s.results || jsonb_build_array(${c.p(result)}::jsonb) WHERE s.id IN (SELECT jsonb_array_elements_text(${c.p(rows.map((row) => row.id))}::jsonb)) AND s.state <> 'stopped' RETURNING s.id`
				);
				const cron =
					head.cause === 'cron' && !retry
						? crons.find(
								(trigger) => trigger.automation === head.automation && trigger.key === head.run_key
							)
						: undefined;
				const next = cron === undefined ? undefined : slotDue(cron, at);
				if (cron !== undefined && next !== undefined) {
					dues.push(next);
					enqueue(
						c,
						[
							{
								automation: cron.automation,
								input: {},
								dueAt: iso(next),
								key: cron.key,
								cause: 'cron',
								depth: 0
							}
						],
						{ conflict: 'keep' }
					);
				}
				yield* db.write(c.sql(`(SELECT count(*) FROM done)::int AS n`));
				// The open tick's nudge fiber claims the next slot; `dues` alone waits for every inflight run to end.
				if (next !== undefined) yield* PubSub.publish(nudges, next);
				return dues;
			}).pipe(
				withRequestCpu,
				Effect.onInterrupt(() =>
					interrupted(rows, 'The run was interrupted while its generation was draining (rule 71a).')
				)
			);
		const tick = tickPermit.withPermit(
			Effect.scoped(
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis,
						inflight = yield* FiberSet.make<void, never>(),
						timer = yield* FiberHandle.make<void, never>(),
						subscription = yield* PubSub.subscribe(nudges);
					let errors: Cause.Cause<EngineError> = Cause.empty,
						pruned = false;
					const dues: number[] = [];
					const track = (work: Effect.Effect<void, EngineError>) =>
						FiberSet.run(
							inflight,
							work.pipe(
								Effect.catchCause((cause) =>
									Effect.sync(() => {
										errors = Cause.combine(errors, cause);
									})
								)
							)
						).pipe(Effect.asVoid);
					const run = (group: readonly Row[]) =>
						execute(group).pipe(
							Effect.tap((times) =>
								Effect.sync(() => {
									dues.push(...times);
								})
							),
							Effect.asVoid
						);
					const custom = Effect.gen(function* () {
						while (true) {
							const admitted = yield* lanes.withPermitsIfAvailable(1)(
								Effect.uninterruptibleMask((restore) =>
									Effect.gen(function* () {
										const claimed = yield* claim(yield* Clock.currentTimeMillis, pruned, true);
										if (claimed.runs.length === 0) return false;
										yield* restore(run(claimed.runs)).pipe(
											Effect.onInterrupt(() =>
												interrupted(
													claimed.runs,
													'The admitted run was interrupted before its lane drained.'
												)
											)
										);
										return true;
									})
								)
							);
							if (Option.isNone(admitted) || !admitted.value) return;
						}
					});
					const start = (claimed: readonly Row[]) => {
						if (claimed.some((row) => row.automation === PRUNE)) pruned = true;
						return Effect.forEach(
							[...Map.groupBy(batches(claimed), (group) => group[0]?.automation ?? '')],
							([, groups]) => track(Effect.forEach(groups, run, { discard: true })),
							{ discard: true }
						).pipe(Effect.andThen(track(custom)));
					};
					if (Math.floor(now / DAY) !== prunedDay) {
						prunedDay = Math.floor(now / DAY);
						const pass = yield* prune(now).pipe(
							Effect.catchTag('BoltError', (error): Effect.Effect<undefined, EngineError> =>
								error.code !== 'noProgress'
									? Effect.fail(error)
									: db
											.write({
												text: `INSERT INTO sys_event (at, severity, event, invocation, attributes) VALUES ($1::timestamptz, 'warn', 'prune.noProgress', $2, $3::jsonb)`,
												params: [
													iso(now),
													PRUNE,
													JSON.stringify({ code: error.code, message: error.message })
												]
											})
											.pipe(Effect.as(undefined))
							)
						);
						pruned = pass !== undefined;
						if (pass?.continued !== undefined) dues.push(pass.continued);
					}
					let armed = Infinity;
					yield* Effect.forkScoped(
						Effect.forever(
							Effect.gen(function* () {
								const at = yield* PubSub.take(subscription);
								if (at >= armed) return;
								armed = at;
								const current = yield* Clock.currentTimeMillis;
								yield* FiberHandle.run(
									timer,
									Effect.sleep(Math.max(0, at - current)).pipe(
										Effect.andThen(
											Effect.sync(() => {
												armed = Infinity;
											})
										),
										Effect.andThen(
											track(
												Effect.gen(function* () {
													const claimed = yield* claim(yield* Clock.currentTimeMillis, pruned);
													yield* start(claimed.runs);
												})
											)
										)
									)
								);
							})
						)
					);
					const first = yield* claim(now, pruned);
					yield* start(first.runs);
					yield* FiberSet.awaitEmpty(inflight);
					if (errors.reasons.length > 0) return yield* Effect.failCause(errors);
					const next = yield* db.value(Schema.NullOr(Schema.String), {
						text: `SELECT min(due_at)::text AS next FROM sys_run WHERE state = 'queued'`,
						params: []
					});
					const earliest = Math.min(...dues, next === null ? Infinity : Date.parse(next));
					yield* deadlines.settle(Number.isFinite(earliest) ? iso(earliest) : null);
				})
			)
		);
		const view = (authority: Authority, id: string) =>
			db
				.one(RunViewRow, {
					text: `SELECT ${RUN_VIEW_COLUMNS} FROM sys_run WHERE id = $1`,
					params: [id]
				})
				.pipe(
					Effect.map((row) =>
						Option.flatMap(row, (value) => Option.fromNullishOr(runView(authority, value)))
					)
				);
		const stop = (authority: Authority, id: string) =>
			Effect.gen(function* () {
				const found = yield* db.one(RunViewRow, {
					text: `SELECT ${RUN_VIEW_COLUMNS} FROM sys_run WHERE id = $1`,
					params: [id]
				});
				if (Option.isNone(found) || runView(authority, found.value)?.input === undefined)
					return Option.none();
				const rows = yield* db.returning(RunViewRow, {
					text: `UPDATE sys_run SET state = 'stopped', key = NULL, finished_at = $2::timestamptz, error = jsonb_build_object('code', 'stopped', 'message', 'The run was stopped.') WHERE id = $1 AND state IN ('queued', 'running') RETURNING ${RUN_VIEW_COLUMNS}`,
					params: [id, iso(yield* Clock.currentTimeMillis)]
				});
				if (rows.length > 0 && found.value.state === 'running') stopping.add(id);
				const halt = halts.get(id);
				if (rows.length > 0 && halt !== undefined) yield* Deferred.succeed(halt, undefined);
				return Option.fromNullishOr(runView(authority, rows[0] ?? found.value));
			});
		const webhook = (path: string, request: WebhookRequest) =>
			Effect.gen(function* () {
				const trigger = triggersOf(m).webhooks.find((candidate) => candidate.path === path);
				if (trigger === undefined) return { status: 404 };
				const configured = yield* Config.option(Config.redacted(trigger.secret))
					.parse(tenant)
					.pipe(
						Effect.mapError((error) =>
							BoltError.make('unavailable', 'facility', 'the webhook secret is unavailable', error)
						)
					);
				if (Option.isNone(configured)) return { status: 401 };
				const secret = Redacted.value(configured.value);
				if (secret === '') return { status: 401 };
				const now = yield* Clock.currentTimeMillis,
					verified = verifiedWebhook(trigger.scheme, secret, request, now);
				if ('answer' in verified) return verified.answer;
				const spec = m.automations[trigger.automation],
					decoded =
						verified.body === undefined || spec?.input === undefined
							? undefined
							: decodeInput(spec.input, verified.body),
					refused =
						verified.body === undefined || (decoded !== undefined && decoded.problems.length > 0);
				const key = `webhook:${trigger.automation}:${verified.delivery}`,
					due = iso(now),
					c = new Chain(),
					id = yield* uuid;
				c.cte(
					'idem',
					`INSERT INTO bolt_idem (key, digest, issued_at, run) VALUES (${c.p(key)}, '', ${c.p(due)}::timestamptz, ${c.p(id)}) ON CONFLICT (key) DO NOTHING RETURNING key`
				);
				enqueue(c, {
					select: `SELECT ${c.p(id)}::text AS id, ${c.p(trigger.automation)}::text AS automation, ${c.p(verified.body ?? {})}::jsonb AS input, ${c.p(due)}::timestamptz AS due_at, 'webhook'::text AS cause, 0 AS depth, ${refused ? `'failed'::text AS state, '{"code":"invalidInput","message":"The body did not decode."}'::jsonb AS error, ${c.p(due)}::timestamptz AS finished_at` : `'queued'::text AS state, NULL::jsonb AS error, NULL::timestamptz AS finished_at`} WHERE ${GATED}`
				});
				yield* db.write(c.sql(answer(c, key, '', `'null'::jsonb`)));
				if (refused) return { status: 400 };
				yield* announce(due);
				return { status: 200 };
			});
		return {
			boot: boot(),
			reconfigure: boot(false),
			tick,
			nudge: (at: string) => PubSub.publish(nudges, Date.parse(at)).pipe(Effect.asVoid),
			view,
			stop,
			webhook
		};
	})
);
