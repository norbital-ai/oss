import {
	Crypto,
	Cause,
	Clock,
	Config,
	ConfigProvider,
	Context,
	Deferred,
	Effect,
	Exit,
	FiberHandle,
	FiberSet,
	Layer,
	Option,
	Predicate,
	PubSub,
	Random,
	Result,
	Redacted,
	Schema,
	Semaphore
} from 'effect';
import * as EffectArray from 'effect/Array';
import type { Json } from '../../decl/values.ts';
const jsonArray = (value: Json | undefined): value is readonly Json[] => Array.isArray(value);
import type { Holder } from '../access/authority.ts';
import { issueAutomationDelegation, delegatedVerbAuthority } from '../access/delegation.ts';
import { Port, type PortFailure } from '../port.ts';
import { AgentHost } from '../agent/index.ts';
import { inferArgsOf, inferFacility, type InferTool } from '../agent/ai.ts';
import { EmbedInputs, ImageOptions, Reference } from '../facilities.ts';
import { readTool } from '../agent/tools.ts';
import { SaidContent, StepContent } from '../agent/schema.ts';
import {
	LIMITS,
	type AiMessage,
	type Authority,
	type CrossAnswer,
	type GuestOutcome
} from '../contracts.ts';
import { isTransient, type EngineError } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import { SqlReadCapture, TenantDb } from '../db/tenant-db.ts';
import { ReadDeps } from '../query/engine.ts';
import { Ai, Drivers, Logs, Transport } from '../ports.ts';
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
	type ActsRequest,
	type FacilityCall,
	type RetrySpec,
	type RunHandler
} from '../services.ts';
import { actorRef } from '../write/commit.ts';
import {
	answer,
	Chain,
	GATED,
	makeReadGuards,
	noticeCaptures,
	noticeInsert
} from '../write/sql.ts';
import { canonical, sha256Hex } from '@norbital-ai/store';
import { pruneHistory } from '../query/history.ts';
import { bindingsAt } from '../query/reader.ts';
import { encodeWire } from '@norbital-ai/std/wire';
import { decodeInput, decodeOutput } from '../callables/decode.ts';
import { isBatchCallable } from '../callables/index.ts';
import { DecisionTrace, readableFile, storedFiles } from '../decisions/index.ts';
import { prepareSend, sendPiece } from '../conversations/outbound.ts';
import { preview, stableId } from '../conversations/store.ts';
import { instanceRequest } from '../integrations/instances.ts';
import { verifiedWebhook, type WebhookRequest } from './webhook.ts';
import { enqueue, nextDue, triggersOf } from './queue.ts';
import { backoffMs, dueAt, iso, offsetMs } from './time.ts';
import { NOTICE_PUSH, noticePush } from './push.ts';
import { GuestParking, PARK_MS } from '../guest/runner.ts';
import { RunJournal, type JournalEntry } from './journal.ts';
import { makeTransactions, transactionFailure } from '../transactions.ts';
import { Audit } from '../audit.ts';
import { audited } from '../audit-operation.ts';
import { NOTIFY, noticeRows, runNotify } from '../notifications/notify.ts';
import { fileSyncHandlers } from '../sync/file.ts';
import { syncTriggers } from '../sync/index.ts';
import { EMBED, embedRun } from '../integrations/embed.ts';
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
			Schema.Struct({ sync: Schema.String, instance: Schema.String })
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
/**
 * An event run's input (`queueTriggered`): one collection's changed ids, and a delete's old images. A run's input by its
 * cause: an event's is this, decoded once as the run is claimed (`Row.event`); any other's is the start's own JSON.
 */
const EventInput = Schema.StructWithRest(
	Schema.Struct({
		collection: Schema.String,
		ids: Schema.Array(Schema.Json),
		rows: Schema.optionalKey(Schema.Array(Schema.Json))
	}),
	[Schema.Record(Schema.String, Schema.Json)]
);
const eventOf = Schema.decodeUnknownOption(EventInput);
type Row = typeof RowSchema.Type & { readonly event: typeof EventInput.Type | undefined };
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
		Schema.Struct({
			code: Schema.String,
			message: Schema.optionalKey(Schema.String),
			field: Schema.optionalKey(Schema.String),
			row: Schema.optionalKey(Schema.Number),
			rows: Schema.optionalKey(Schema.Array(Schema.Number)),
			rule: Schema.optionalKey(Schema.String),
			data: Schema.optionalKey(Schema.Struct({ requestId: Schema.String })),
			records: Schema.optionalKey(
				Schema.Array(
					Schema.Struct({
						collection: Schema.String,
						id: Schema.String,
						fields: Schema.Array(Schema.String)
					})
				)
			),
			invocation: Schema.optionalKey(Schema.String)
		})
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
	error: RunViewRow['error'];
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
/** An infer tool's input as the JSON Schema the model is given, derived from its Schema. */
const jsonSchemaOf = (input: Schema.Top, tool: string) => {
	const document = Schema.toJsonSchemaDocument(input);
	return Schema.decodeUnknownEffect(Schema.Json)({
		...document.schema,
		$defs: document.definitions
	}).pipe(Effect.mapError(Port.failure(tool)));
};
const EVENTS = new Set(['created', 'updated', 'deleted']);
const EFFECTS = new Set([
	'act',
	'acts',
	'schedule',
	'notify',
	'send',
	'request',
	'progress',
	'transactionBegin'
]);
/**
 * What a facility call is to a run's gates, decoded once from its arguments with the shapes the dispatcher takes: the
 * stored files it reads (each must be the run's to read), whether it stores a new one (journalled, then the run's own),
 * and the host tools an inference names. Arguments of another shape gate nothing; the dispatcher refuses them.
 */
type CallFacts = {
	readonly reads: readonly string[];
	readonly stores: boolean;
	readonly tools: readonly string[] | undefined;
};
function factsOf(call: FacilityCall): CallFacts {
	// built per call: `facilities.ts` reaches this module through `decisions`, so its schemas are not there at load
	const [first, options] = call.args,
		referenceOf = Schema.decodeUnknownOption(Reference);
	const ids = (refs: readonly (string | { readonly id: string })[]) =>
		refs.flatMap((ref) => (typeof ref === 'string' ? [] : [ref.id]));
	switch (call._tag) {
		case 'files.put':
		case 'ai.speak':
			return { reads: [], stores: true, tools: undefined };
		case 'files.image':
			return {
				reads: ids(Option.toArray(referenceOf(first))),
				stores: Option.exists(
					Schema.decodeUnknownOption(ImageOptions)(options ?? {}),
					(o) => o.jpeg !== undefined
				),
				tools: undefined
			};
		case 'files.meta':
		case 'files.get':
		case 'files.url':
		case 'files.text':
		case 'files.table':
		case 'files.sheet':
		case 'ai.transcribe':
			return { reads: ids(Option.toArray(referenceOf(first))), stores: false, tools: undefined };
		case 'convert.document':
			return {
				reads: ids(
					Option.toArray(
						Schema.decodeUnknownOption(Schema.Struct({ reference: Schema.optionalKey(Reference) }))(
							options
						)
					).flatMap((o) => (o.reference === undefined ? [] : [o.reference]))
				),
				stores: true,
				tools: undefined
			};
		case 'ai.embed':
			return {
				reads: ids(Option.getOrElse(Schema.decodeUnknownOption(EmbedInputs)(first), () => [])),
				stores: false,
				tools: undefined
			};
		case 'ai.sys_2.infer': {
			const a = Option.getOrUndefined(inferArgsOf(first ?? {}));
			return { reads: ids(a?.files ?? []), stores: false, tools: a?.tools };
		}
		default:
			return { reads: [], stores: false, tools: undefined };
	}
}
/** An inference's messages as its transcript rows hold them: a tool step, or a prompt's or reply's words. */
const stepOf = Schema.decodeUnknownOption(StepContent),
	saidOf = Schema.decodeUnknownOption(SaidContent);
const MAX_IDS = 10000,
	DAY = 86400000,
	/** Workspace automations that may run side by side; one automation's own runs stay one at a time. */
	LANES = 4;
const PRUNE = 'bolt.prune';
/**
 * Where a run's row stands. A queued run has its row; a fired cron's run writes it only with its first effect:
 * `record` writes it once and answers false when the slot already ran.
 */
type Ledger = {
	readonly record: Effect.Effect<boolean, EngineError>;
	readonly written: () => boolean;
};
const QUEUED: Ledger = { record: Effect.succeed(true), written: () => true };
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
			Schema.Struct({
				kind: Schema.Literals(['bolt', 'refused']),
				code: Schema.String,
				message: Schema.String
			}),
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
type Failed = Extract<CrossAnswer, { ok: false }>['error'];
/** A failed answer as its journal holds it. */
const failureJson = (error: Failed): Json =>
	error.kind === 'unavailable'
		? { kind: error.kind, facility: error.facility, reason: error.reason }
		: error.kind === 'bolt' || error.kind === 'refused'
			? { kind: error.kind, code: error.code, message: error.message }
			: {
					kind: error.kind,
					message: error.message,
					...(error.status === undefined ? {} : { status: error.status })
				};
/** What one execution leaves in its run's journal: whether there is one to delete, and whether it filled. */
type Durability = { touched: boolean; full: boolean };
const JOURNAL_FULL = "The run's journal is full: its AI, infer and HTTP answers are over 64 MiB.";
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
			audit = yield* Audit,
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
			logs = yield* Logs,
			agentHost = yield* AgentHost;
		const hostJournal = yield* Effect.serviceOption(RunJournal);
		const runJournal = Option.isSome(hostJournal) ? hostJournal.value : yield* RunJournal.memory;
		/** A completed run's journal goes; one left behind is the host's to expire. */
		const forget = (durability: Durability, run: string) =>
			durability.touched
				? runJournal.clear(run).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)
				: Effect.void;
		const crypto = yield* Crypto.Crypto;
		const uuid = crypto.randomUUIDv4.pipe(
			Effect.mapError((error) =>
				BoltError.make('unavailable', 'facility', 'Secure random UUID generation failed.', error)
			)
		);
		const crons = [...triggersOf(m).crons, ...(drivers.available ? syncTriggers(m) : [])];
		const tenant = yield* ConfigProvider.ConfigProvider;
		const stopping = new Set<string>();
		/** A running run's stop signal: `stop` completes it, which ends the crossing in flight (an inference has no time limit). */
		const halts = new Map<string, Deferred.Deferred<void>>();
		// A lane's claim commits before the next one checks the automation's remaining capacity.
		const lanes = yield* Semaphore.make(LANES),
			claims = yield* Semaphore.make(1),
			tickPermit = yield* Semaphore.make(1);
		const capacities: Record<string, number> = {};
		for (const [name, automation] of Object.entries(m.automations))
			capacities[name] = automation.concurrency?.max ?? 1;
		// Local permits match native admission; undeclared platform handlers keep one permit.
		const locks = new Map<string, Semaphore.Semaphore>();
		const lock = (automation: string) => {
			let held = locks.get(automation);
			if (held === undefined)
				locks.set(automation, (held = Semaphore.makeUnsafe(capacities[automation] ?? 1)));
			return held;
		};
		let prunedDay = -1;
		yield* registry.register({
			[NOTICE_PUSH]: yield* noticePush,
			[NOTIFY]: yield* runNotify,
			[EMBED]: yield* embedRun,
			...(yield* fileSyncHandlers)
		});
		const announce = (at: string) =>
			deadlines
				.announce(at)
				.pipe(Effect.andThen(PubSub.publish(nudges, Date.parse(at))), Effect.asVoid);
		const boot = Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis,
				c = new Chain();
			c.cte(
				'lost',
				// a handed-off request's work lived in its generation's memory: it is not run again (the person asks again)
				`UPDATE sys_run SET leases = leases + 1, due_at = ${c.p(iso(now))}::timestamptz, state = CASE WHEN cause = 'handoff' OR leases >= 3 THEN 'failed' ELSE 'queued' END, error = CASE WHEN cause = 'handoff' THEN '{"code":"lostLease","message":"The host was lost before the request answered."}'::jsonb WHEN leases < 3 THEN error ELSE '{"code":"lostLease","message":"The run lost its lease 3 times."}'::jsonb END WHERE state = 'running' RETURNING id, state, due_at`
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
					`least((SELECT min(due_at) FROM sys_run WHERE state = 'queued'), (SELECT min(due_at) FROM lost WHERE state = 'queued'), ${nextDue(c)})::text AS next`
				)
			);
			yield* deadlines.settle(rows[0]?.next ?? null);
		});
		const claim = (now: number, pruned = false, custom = false) =>
			Effect.gen(function* () {
				const c = new Chain(),
					automations = c.p(Object.keys(m.automations)),
					capacity = c.p(capacities),
					due = c.p(iso(now)),
					eligible = `r.state = 'queued' AND r.due_at <= ${due}::timestamptz AND (NOT ${c.p(pruned)} OR r.automation <> ${c.p(PRUNE)}) AND (SELECT count(*) FROM sys_run x WHERE x.automation = r.automation AND x.state = 'running') < coalesce((${capacity}::jsonb ->> r.automation)::int, 1)`;
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
					`${batch} UPDATE sys_run s SET state = 'running', attempts = s.attempts + 1, started_at = ${due}::timestamptz, run_key = coalesce(s.key, s.run_key), key = CASE WHEN s.automation IN (SELECT jsonb_array_elements_text(${automations}::jsonb)) THEN NULL ELSE s.key END WHERE s.state = 'queued' AND s.id IN (SELECT r.id FROM sys_run r WHERE ${eligible} AND ${custom ? `r.id IN (SELECT id FROM batch WHERE position = 1 OR ids <= ${c.p(MAX_IDS)})` : `r.automation NOT IN (SELECT jsonb_array_elements_text(${automations}::jsonb))`} ORDER BY r.due_at, r.id LIMIT 1000 FOR UPDATE SKIP LOCKED) RETURNING s.*`
				);
				const rows = yield* db.returning(
					Schema.Struct({ runs: Schema.Array(RowSchema), next: Schema.NullOr(Schema.String) }),
					c.sql(
						`(SELECT coalesce(jsonb_agg(to_jsonb(x) || jsonb_build_object('due_at', x.due_at::text) ORDER BY x.due_at, x.id), '[]'::jsonb) FROM claimed x) AS runs, (SELECT min(due_at)::text FROM sys_run WHERE state = 'queued' AND id NOT IN (SELECT id FROM claimed)) AS next`
					),
					// Taken before the statement snapshot: separate runtimes must see the previous claim.
					{ advisory: ['bolt:runs:claim'] }
				);
				const claimed = rows[0];
				return {
					runs: (claimed?.runs ?? []).map((row): Row => ({
						...row,
						event: EVENTS.has(row.cause) ? Option.getOrUndefined(eventOf(row.input)) : undefined
					})),
					next: claimed?.next ?? null
				};
			});
		const batches = (rows: readonly Row[]): Row[][] => {
			const out: Row[][] = [];
			for (const group of Map.groupBy(
				rows,
				(row) =>
					`${row.automation}\u0000${row.event === undefined ? row.id : `${row.cause}\u0000${row.event.collection}`}`
			).values()) {
				let batch: Row[] = [],
					count = 0;
				for (const row of group) {
					const size = row.event?.ids.length ?? 0;
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
				bolt_idem: `((run IS NOT NULL AND (run IN (SELECT id FROM sel_sys_run) OR NOT EXISTS (SELECT 1 FROM sys_run r WHERE r.id = bolt_idem.run)))
				OR (run IS NULL AND issued_at < $1::timestamptz - interval '24 hours'))
				AND NOT EXISTS (SELECT 1 FROM bolt_audit_receipt a WHERE a.outcome_key=bolt_idem.key AND a.acknowledged_at IS NULL AND a.expired_at IS NULL)`,
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
				params: [iso(now)]
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
		/** A crossing that writes, sends, schedules or reports: a fired cron's run writes its row before the first. */
		const effecting = (call: Exclude<CrossCall, { _tag: 'read' }>) =>
			EFFECTS.has(call._tag) ||
			call._tag.startsWith('ai.') ||
			call._tag === 'convert.document' ||
			call._tag === 'files.put' ||
			(call._tag === 'files.image' &&
				Option.exists(
					Schema.decodeUnknownOption(ImageOptions)(call.args[1] ?? {}),
					(o) => o.jpeg !== undefined
				));
		/** The first wake or fire of a day prunes (rule 56); `undefined` once it ran today, or when it made no progress. */
		const daily = (now: number) =>
			Effect.suspend(
				(): Effect.Effect<{ deleted: number; continued?: number } | undefined, EngineError> => {
					if (Math.floor(now / DAY) === prunedDay) return Effect.succeed(undefined);
					prunedDay = Math.floor(now / DAY);
					return prune(now).pipe(
						Effect.catchTag('BoltError', (error): Effect.Effect<undefined, EngineError> =>
							error.code !== 'noProgress'
								? Effect.fail(error)
								: logs
										.write({
											at: iso(now),
											severity: 'warn',
											event: 'prune.noProgress',
											invocation: PRUNE,
											run: null,
											conversation: null,
											turn: null,
											attributes: { code: error.code, message: error.message }
										})
										.pipe(Effect.as(undefined))
						)
					);
				}
			);
		const invoke = (
			run: Row,
			ids: readonly string[],
			holder: Holder,
			input: Json,
			dues: number[],
			warnings: string[],
			record: Ledger['record'],
			durability: Durability
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
					b = bindingsAt(now, m.workspace.tz),
					authority = yield* identity.authority(holder);
				const delegation = issueAutomationDelegation(m, authority, run.id, run.automation);
				// One optimistic read boundary per confirmed commit, retained across failures within this attempt.
				const priorReads = makeReadGuards(activation.release);
				// Only native write admission is sequenced; inference and other facilities remain parallel.
				const writeLane = yield* Semaphore.make(1);
				const transactions = yield* makeTransactions({
					audit,
					db,
					manifest: m,
					reads,
					writes,
					authority,
					authorityForVerb: (name) => delegatedVerbAuthority(m, authority, delegation, name),
					bindings: b,
					sourceEpoch: activation.release,
					invocationId: run.id,
					input
				});
				let transactionOpen = false;
				let transactionReadGeneration: number | undefined;
				let transactionInvocationId = run.id;
				const nativeTables = new Set([
					...Object.keys(m.models),
					'bolt_schema',
					'bolt_history',
					'bolt_seq',
					'bolt_idem',
					'bolt_idem_outcome',
					'bolt_rate',
					'bolt_push_subscriptions',
					'bolt_host_nonce',
					'bolt_credential',
					'bolt_approvals',
					'bolt_run_admitted'
				]);
				let replaying = run.attempts > 1 || run.leases > 0;
				const journal = new Map<string, Json>();
				const createdFiles = new Set<string>();
				const halt = yield* Deferred.make<void>();
				halts.set(run.id, halt);
				/** The side effects' outcomes this run already committed (`bolt_idem`), for a replay. */
				const committed = db
					.rows(Schema.Struct({ key: Schema.String, outcome: Schema.Json }), {
						text: `SELECT i.key, o.outcome FROM bolt_idem i JOIN bolt_idem_outcome o USING (key) WHERE i.run = $1`,
						params: [run.id]
					})
					.pipe(
						Effect.map((rows) => {
							journal.clear();
							for (const row of rows) journal.set(row.key, row.outcome);
						})
					);
				if (replaying) yield* committed;
				/** The run's own journal of AI, infer and HTTP answers, read once per pass at its first such call. */
				const readJournal = Effect.cached(
					runJournal.read(run.id).pipe(
						Effect.map((entries) => {
							if (entries.length > 0) durability.touched = true;
							return new Map(entries.map((entry): [string, JournalEntry] => [entry.key, entry]));
						})
					)
				);
				let stored = yield* readJournal;
				/** Journals one answer: past its cap the run ends `journalFull`; another failed write only costs durability. */
				const note = (key: string, answer: Json) =>
					runJournal.write(run.id, { key, attempt: run.attempts, answer }).pipe(
						Effect.andThen(
							Effect.sync(() => {
								durability.touched = true;
							})
						),
						Effect.catch((error) =>
							error.code === 'journalFull'
								? Effect.sync(() => {
										durability.full = true;
									})
								: Effect.logWarning(error)
						)
					);
				/** An AI, infer or HTTP call: its journalled answer when it already answered, else live and then journalled. */
				const durably = (key: string, live: Effect.Effect<CrossAnswer, EngineError>) =>
					Effect.gen(function* (): Effect.fn.Return<CrossAnswer, EngineError> {
						if (durability.full) return fail('journalFull', JOURNAL_FULL);
						const entry = (yield* stored).get(key);
						if (entry !== undefined) {
							const replayed = yield* replayAnswer(entry.answer);
							// a failure stands only for the attempt that met it: a retry asks again
							if (replayed.ok || entry.attempt === run.attempts) return replayed;
						}
						const got = yield* live;
						// bytes ride no journal: such an answer is asked again on a replay
						if (got.ok && (got.bins?.length ?? 0) > 0) return got;
						yield* note(
							key,
							got.ok ? { ok: true, value: got.value } : { ok: false, error: failureJson(got.error) }
						);
						return got;
					});
				/** A parked run's next pass: a fresh isolate replays from the start, effects and answers from their journals. */
				const resume = Effect.gen(function* () {
					replaying = true;
					seen.clear();
					yield* committed;
					stored = yield* readJournal;
				}).pipe(
					Effect.mapError((error) =>
						error._tag === 'BoltError'
							? error
							: BoltError.make('internal', 'guest', 'the parked run could not resume', error)
					)
				);
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
				const rememberFile = (facts: CallFacts, answer: CrossAnswer) =>
					Effect.gen(function* () {
						if (!answer.ok || !facts.stores) return;
						const file = yield* Schema.decodeUnknownEffect(CreatedFile)(answer.value).pipe(
							Effect.mapError(() =>
								BoltError.make('corrupt', 'guest', 'a file creation answered an invalid FileRef')
							)
						);
						createdFiles.add(file.id);
					});
				const checkFiles = (facts: CallFacts) =>
					Effect.gen(function* () {
						for (const id of facts.reads) {
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
				/** A facility call, gated by its `facts`; `key` names an infer's own steps in the run's journal. */
				const facility = (call: FacilityCall, facts: CallFacts, key: string) =>
					Effect.gen(function* (): Effect.fn.Return<CrossAnswer, PortFailure> {
						if (call._tag === 'ai.sys_1.decide')
							return yield* facilities.dispatch(call).pipe(
								Effect.provideService(DecisionTrace, {
									invocation: `${run.id}:${run.attempts}`,
									run: run.id,
									automation: run.automation
								})
							);
						if (call._tag !== 'ai.sys_2.infer') return yield* facilities.dispatch(call);
						const names = [...new Set(facts.tools ?? [])];
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
						const records: InferTool[] = [];
						if (reader !== undefined) {
							records.push({
								name: reader.name,
								description: reader.description,
								input: yield* jsonSchemaOf(reader.input, 'tool read'),
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
						const missing = names.find((name) =>
							name === 'read'
								? reader === undefined
								: !(authority.admin || authority.capabilities.tools.includes(name)) ||
									![...records, ...hosted].some((tool) => tool.name === name)
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
						// one browsing session per inference: inferences side by side in one run never share a page
						const session = stableId('infer', key);
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
													conversation: `${run.id}:${session}`,
													turn: run.id,
													callId,
													attach: () => {}
												},
												signal
											)
										);
									})
							}));
						// each tool step is one `infer.tool` event on the run (what it read, searched, opened or edited), as
						// `decision.made` traces a sys_1 call: the run's own record of the research it did
						const recorded = (name: string, input: Json, error?: string) =>
							Effect.gen(function* () {
								yield* logs.write({
									at: new Date(yield* Clock.currentTimeMillis).toISOString(),
									severity: error === undefined ? 'info' : 'warn',
									event: 'infer.tool',
									invocation: `${run.id}:${run.attempts}`,
									run: run.id,
									conversation: null,
									turn: null,
									attributes: {
										automation: run.automation,
										tool: name,
										input: JSON.stringify(input).slice(0, 500),
										...(error === undefined ? {} : { error })
									}
								});
							}).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
						const traced = (tool: InferTool): InferTool => ({
							...tool,
							call: (input) =>
								tool
									.call(input)
									.pipe(
										Effect.onExit((exit) =>
											recorded(
												tool.name,
												input,
												Exit.isFailure(exit)
													? Option.getOrUndefined(Cause.findErrorOption(exit.cause))?.message
													: undefined
											)
										)
									)
						});
						// the inference's whole transcript is a conversation of its own, as an agent's is: labelled, read-only, for
						// administrators (the run's own `session` names it)
						const named = Schema.decodeUnknownOption(
							Schema.Struct({
								label: Schema.optionalKey(Schema.String),
								model: Schema.optionalKey(Schema.String)
							})
						)(call.args[0]);
						const label = Option.isSome(named) ? named.value.label : undefined;
						yield* db
							.write({
								text: "INSERT INTO sys_conversation (id, title, run, status, model) VALUES ($1, $2, $3, 'running', $4) ON CONFLICT (id) DO UPDATE SET status = 'running', updated_at = now()",
								params: [
									session,
									label === undefined ? run.automation : `${run.automation} · ${label}`,
									run.id,
									(Option.isSome(named) ? named.value.model : undefined) ?? 'default'
								]
							})
							.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
						// a tool row carries the call's input as the panel shows a step (its query, address or path), as an
						// agent's does; the model's own messages keep it once, in its call
						const asked = new Map<string, string>();
						const transcribe = (message: AiMessage, index: number) => {
							// the message's content decoded as a transcript row's, by its role
							const step =
									message.role === 'tool'
										? Option.getOrUndefined(stepOf(message.content))
										: undefined,
								words =
									message.role === 'tool'
										? undefined
										: Option.getOrUndefined(saidOf(message.content));
							if (typeof words === 'object' && words !== null)
								for (const c of words.toolCalls ?? []) asked.set(c.id, JSON.stringify(c.input));
							const args = step === undefined ? undefined : asked.get(step.id);
							const content: Json =
								step !== undefined && args !== undefined ? { ...step, args } : message.content;
							const text =
								typeof words === 'string'
									? words
									: typeof words === 'object' && words?.text !== undefined
										? words.text
										: JSON.stringify(content);
							return db
								.write({
									text: "INSERT INTO sys_message (id, conversation, role, content, text, preview, mode, author) VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'agent', $7) ON CONFLICT (id) DO NOTHING",
									// the automation asked: its prompt is written by it, as a member writes theirs
									params: [
										stableId(session, String(index)),
										session,
										message.role,
										// a prompt is a bare string: encoded, it is JSON like every other content
										JSON.stringify(content),
										text,
										preview(text),
										message.role === 'user' ? run.automation : null
									]
								})
								.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
						};
						// each step the inference persists is in the journal under its call's key: a lost host costs one step
						const prefix = `${key}#step:`;
						// `durably` read the journal before this live call: a failed read resumes nothing
						const entries = yield* stored.pipe(
							Effect.orElseSucceed(() => new Map<string, JournalEntry>())
						);
						const steps = [...entries.values()]
							.flatMap((entry) =>
								entry.key.startsWith(prefix)
									? [[Number(entry.key.slice(prefix.length)), entry.answer] as const]
									: []
							)
							.sort(([a], [b]) => a - b)
							.map(([, step]) => step);
						return yield* inferFacility(ai, {
							load: facilities.fileLoader,
							onDraft: recorded,
							onMessage: transcribe,
							onResume: () =>
								db
									.write({
										text: 'DELETE FROM sys_message WHERE conversation = $1',
										params: [session]
									})
									.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore),
							steps: { done: steps, persist: (index, step) => note(`${prefix}${index}`, step) }
						})(call, [...records, ...tools].map(traced)).pipe(
							Effect.ensuring(
								db
									.write({
										text: "UPDATE sys_conversation SET status = 'idle', updated_at = now() WHERE id = $1",
										params: [session]
									})
									.pipe(Effect.ignore)
							)
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
				): Effect.Effect<CrossAnswer, EngineError> => {
					const work = Effect.gen(function* (): Effect.fn.Return<CrossAnswer, EngineError> {
						if (stopping.has(run.id)) return fail('stopped', 'The run was stopped.');
						if (transactionOpen && !call._tag.startsWith('transaction')) {
							yield* transactions.abort();
							transactionOpen = false;
							return fail('invalidInput', 'Only tx.query and tx.act may run inside a transaction.');
						}
						if (effecting(call) && !(yield* record))
							return fail('stopped', 'This cron slot already ran.');
						switch (call._tag) {
							case 'transactionBegin': {
								const { key } = keyOf('transaction', 'transaction', null);
								transactionInvocationId = key;
								const snapshot = priorReads.snapshot();
								const begun = yield* transactions.begin({
									key,
									issuedAt: b.now,
									readGuards: snapshot.guards
								});
								transactionOpen = !begun.cached;
								transactionReadGeneration = begun.cached ? undefined : snapshot.generation;
								return {
									ok: true,
									value: begun.cached
										? { cached: true, outcome: encodeWire(begun.outcome) }
										: { cached: false }
								};
							}
							case 'transactionRead':
								return {
									ok: true,
									value: { value: yield* transactions.read(call.reads, call.keys) }
								};
							case 'transactionAct':
								return { ok: true, value: yield* transactions.act(call) };
							case 'transactionFinish': {
								const result = yield* transactions.finish(call);
								transactionOpen = false;
								if (result.readGuardsConsumed === true && transactionReadGeneration !== undefined)
									priorReads.consume(transactionReadGeneration);
								transactionReadGeneration = undefined;
								return { ok: true, value: encodeWire(result.outcome) };
							}
							case 'transactionAbort':
								yield* transactions.abort();
								transactionOpen = false;
								transactionReadGeneration = undefined;
								return { ok: true, value: null };
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
										: '';
								const { key } = keyOf(
									'act',
									name,
									call.options?.observed === undefined
										? call.input
										: { input: call.input, observed: call.options.observed }
								);
								const k = call.options?.once === undefined ? key : `once:${call.options.once}`;
								if (call.callable._tag !== 'Verb')
									return fail('invalidInput', 'ctx.act takes a generated collection verb');
								const observedRead = priorReads.snapshot();
								const guards = observedRead.guards;
								const result = yield* writes.act({
									collection: call.callable.collection,
									verb: call.callable.verb,
									input: call.input,
									mode: { _tag: 'Direct' },
									...(guards.fingerprints.length === 0 && guards.inconsistent !== true
										? {}
										: { readGuards: guards }),
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
								if (result.readGuardsConsumed === true) priorReads.consume(observedRead.generation);
								return { ok: true, value: result.outcome };
							}
							case 'acts': {
								const acts: ActsRequest['acts'][number][] = [];
								for (const act of call.acts) {
									if (!isBatchCallable(act.callable))
										return fail(
											'invalidInput',
											'An act batch takes create, update, upsert or delete.'
										);
									acts.push({
										collection: act.callable.collection,
										verb: act.callable.verb,
										input: act.input,
										...(act.observed === undefined ? {} : { observed: act.observed }),
										...(act.onConflict === undefined ? {} : { onConflict: act.onConflict })
									});
								}
								const { key } = keyOf('acts', 'acts', encodeWire(acts));
								const observedRead = priorReads.snapshot();
								const guards = observedRead.guards;
								const result = yield* calls.acts({
									name: 'act.many',
									acts,
									...(guards.fingerprints.length === 0 && guards.inconsistent !== true
										? {}
										: { readGuards: guards }),
									key,
									issuedAt: b.now,
									authority,
									bindings: b,
									invocationId: key,
									from: 'Server'
								});
								if (result.readGuardsConsumed === true) priorReads.consume(observedRead.generation);
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
								const { key, digest } = keyOf('notify', '', call.notices),
									previous = hit(key);
								const report = (value: Json) => {
									if (Predicate.isObject(value) && EffectArray.isArray(value['unaddressed']))
										for (const title of value['unaddressed'])
											warnings.push(`notify: '${String(title)}' reached no member`);
								};
								if (previous !== undefined) {
									report(previous);
									return { ok: true, value: null, journal: true };
								}
								const rows = yield* noticeRows(call.notices, { manifest: m, id: key });
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
								if (call.to === null)
									return fail('invalidInput', 'ctx.send names its connection or instance');
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
								const { key } = keyOf('request', call.to, call.operation);
								return yield* durably(
									key,
									instanceRequest({ manifest: m, db, links: drivers }, call.to, call.operation)
								);
							}
							default: {
								const facts = factsOf(call);
								if (!(yield* checkFiles(facts)))
									return {
										ok: false,
										error: { kind: 'invalid', message: 'this run cannot read file' }
									};
								// AI and web answers are slow, costly or unrepeatable: the run's journal keeps them (§3 "Durable steps")
								const durable = call._tag.startsWith('ai.') || call._tag === 'web.read';
								if (!durable && !effecting(call)) return yield* facility(call, facts, '');
								const files: Effect.Success<ReturnType<typeof storedFiles>> =
									call._tag === 'ai.embed' ? yield* storedFiles(db, call.args[0]) : new Map();
								const digests = [...files].map(([id, row]) => [id, row.sha256]).sort();
								const { key, digest } = keyOf(call._tag, '', [...call.args, digests]);
								if (durable) {
									const got = yield* durably(key, facility(call, facts, key));
									yield* rememberFile(facts, got);
									return got;
								}
								const previous = hit(key);
								if (previous !== undefined) {
									const got = yield* replayAnswer(previous);
									yield* rememberFile(facts, got);
									return got;
								}
								const got = yield* facility(call, facts, key);
								if (got.ok) {
									yield* rememberFile(facts, got);
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
					return call._tag === 'act' || call._tag === 'acts' || call._tag.startsWith('transaction')
						? writeLane.withPermit(work)
						: work;
				};
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
								crossings: LIMITS.crossings.automation,
								readBytes: LIMITS.readBytes
							}
						},
						{
							cross: (batch) =>
								Effect.gen(function* () {
									if (
										(batch.length !== 1 &&
											batch.some((call) => call._tag.startsWith('transaction'))) ||
										(transactionOpen && batch.some((call) => !call._tag.startsWith('transaction')))
									) {
										const aborted = yield* Effect.result(transactions.abort());
										transactionOpen = false;
										transactionReadGeneration = undefined;
										return batch.map(() =>
											Result.isFailure(aborted)
												? failure(aborted.failure)
												: fail(
														'invalidInput',
														'A transaction admits one native operation at a time.'
													)
										);
									}
									const requests = batch.flatMap((call) =>
										call._tag === 'read' ? [call.read] : []
									);
									const tables = new Set<string>();
									const observation = priorReads.begin(tables);
									const capture = {
										read: (
											statements: Parameters<typeof observation.capture.read>[0],
											execute: Parameters<typeof observation.capture.read>[1]
										) => {
											// Native SQL may also read approval, history, sync or agent metadata outside the business IR.
											// Restrict conservative identifier matches to existing native tables; no authored SQL is admitted.
											for (const statement of statements)
												for (const match of statement.text.matchAll(
													/\b(?:FROM|JOIN)\s+(?:"((?:[^"]|"")*)"|([a-z_][a-z0-9_]*))/gi
												)) {
													const table =
														match[1] === undefined
															? match[2]?.toLowerCase()
															: match[1].replaceAll('""', '"');
													if (table !== undefined && nativeTables.has(table)) tables.add(table);
												}
											return observation.capture.read(statements, execute);
										}
									};
									const answers =
										requests.length === 0
											? []
											: yield* reads.run(requests, { as: 'caller', authority }, b, 'Server').pipe(
													Effect.provideService(SqlReadCapture, capture),
													Effect.provideService(ReadDeps, tables),
													Effect.tap(() =>
														Effect.try({
															try: observation.finish,
															catch: (error) =>
																error instanceof BoltError
																	? error
																	: BoltError.make('internal', 'admission', String(error), error)
														})
													),
													Effect.map((values) =>
														values.map((value): CrossAnswer => ({ ok: true, value }))
													),
													Effect.catch((error): Effect.Effect<readonly CrossAnswer[]> =>
														Effect.succeed(requests.map(() => failure(error)))
													)
												);
									let index = 0;
									return yield* Effect.forEach(batch, (call): Effect.Effect<CrossAnswer> =>
										call._tag === 'read'
											? Effect.succeed(
													answers[index++] ?? fail('internal', 'the read returned no answer')
												)
											: crossing(call).pipe(
													Effect.catch((error): Effect.Effect<CrossAnswer> =>
														call._tag.startsWith('transaction')
															? transactions.abort().pipe(
																	Effect.catch(() => Effect.void),
																	Effect.andThen(
																		Effect.sync((): CrossAnswer => {
																			transactionOpen = false;
																			transactionReadGeneration = undefined;
																			return {
																				ok: true,
																				value: encodeWire(
																					transactionFailure(error, transactionInvocationId)
																				)
																			} satisfies CrossAnswer;
																		})
																	)
																)
															: Effect.succeed(failure(error))
													),
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
					.pipe(
						// a wait past PARK_MS parks the run: no isolate while it waits, a fresh one replays when it answers
						Effect.provideService(GuestParking, { afterMs: PARK_MS, resume }),
						Effect.map((outcome): GuestOutcome =>
							durability.full
								? { kind: 'failed', error: BoltError.make('journalFull', 'guest', JOURNAL_FULL) }
								: outcome
						),
						Effect.ensuring(Effect.sync(() => halts.delete(run.id)))
					);
			}).pipe(Effect.scoped);
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
		const execute = (rows: readonly Row[], ledger = QUEUED) =>
			Effect.gen(function* () {
				const head = rows[0];
				if (head === undefined) return [];
				const now = yield* Clock.currentTimeMillis,
					spec = m.automations[head.automation],
					dues: number[] = [],
					warnings: string[] = [],
					durability: Durability = { touched: false, full: false };
				let input: Json = head.input;
				if (head.event !== undefined)
					input = {
						...head.event,
						ids: rows.flatMap((row) => row.event?.ids ?? []),
						...(head.cause === 'deleted'
							? { rows: rows.flatMap((row) => row.event?.rows ?? []) }
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
				if (spec === undefined && Option.isSome(handler)) {
					// Platform handlers own their I/O and page statements, so claim a fired slot before handing them control.
					// A queued attempt already has its lease; a repeated cron slot must never enter the handler again.
					if (!ledger.written() && !(yield* ledger.record)) return dues;
					outcome = yield* handler.value(input, head).pipe(
						Effect.map((output): GuestOutcome => ({ kind: 'ok', output })),
						Effect.catch((error) =>
							Effect.succeed({
								kind: 'failed',
								error:
									error._tag === 'BoltError'
										? error
										: BoltError.make('internal', 'guest', error.message, error)
							} satisfies GuestOutcome)
						)
					);
				} else if (spec === undefined)
					outcome = {
						kind: 'failed',
						error: BoltError.make(
							'unknownAutomation',
							'admission',
							`no automation '${head.automation}'`
						)
					};
				else if (decoded !== undefined && decoded.problems.length > 0)
					outcome = {
						kind: 'failed',
						error: BoltError.make('invalidInput', 'decode', 'The run input did not decode.')
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
							error: BoltError.make('noTrigger', 'admission', 'the run has no starter')
						};
					else {
						const removedRows = Predicate.isObject(input) ? input['rows'] : undefined;
						if (
							head.cause === 'deleted' &&
							head.event !== undefined &&
							Predicate.isObject(input) &&
							jsonArray(removedRows) &&
							!holder.admin
						) {
							const authority = yield* identity.authority(holder),
								collection = head.event.collection;
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
											? removedRows
											: removedRows.map((row) =>
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
							warnings,
							ledger.record,
							durability
						);
					}
				}
				if (outcome.kind === 'ok' && spec?.output !== undefined) {
					const decoded = yield* Effect.result(decodeOutput(m, spec.output, outcome.output));
					outcome =
						decoded._tag === 'Success'
							? { ...outcome, output: decoded.success }
							: { kind: 'failed', error: decoded.failure };
				}
				if (outcome.kind === 'failed' && outcome.error.code === 'interrupted') {
					yield* interrupted(rows, outcome.error.message);
					return dues;
				}
				if (!ledger.written()) {
					// An authored cron that only read writes nothing; platform handlers claimed their slot before I/O.
					const idle =
						outcome.kind === 'ok' &&
						(spec !== undefined ||
							(Predicate.isObject(outcome.output) && outcome.output['pages'] === 0));
					if (idle || !(yield* ledger.record)) {
						yield* forget(durability, head.id);
						return dues;
					}
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
							? {
									code: outcome.code ?? 'refused',
									message: outcome.message,
									...(outcome.field === undefined ? {} : { field: outcome.field }),
									...(outcome.row === undefined ? {} : { row: outcome.row }),
									...(outcome.rows === undefined ? {} : { rows: outcome.rows }),
									...(outcome.rule === undefined ? {} : { rule: outcome.rule }),
									...(outcome.data === undefined ? {} : { data: outcome.data }),
									...(outcome.records === undefined ? {} : { records: outcome.records }),
									...(outcome.invocation === undefined ? {} : { invocation: outcome.invocation })
								}
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
				yield* audited(
					db,
					{
						category: 'automation',
						action: 'finish',
						actor: { kind: 'system', id: head.id, label: null },
						run: head.id,
						payload: encodeWire({
							automation: head.automation,
							runIds: rows.map((row) => row.id),
							result
						})
					},
					db.write(c.sql(`(SELECT count(*) FROM done)::int AS n`))
				).pipe(Effect.provideService(Audit, audit));
				if (state !== 'queued') yield* forget(durability, head.id);
				return dues;
			}).pipe(
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
						lock(group[0]?.automation ?? '')
							.withPermit(execute(group))
							.pipe(
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
										const claimed = yield* claims.withPermit(
											claim(yield* Clock.currentTimeMillis, pruned, true)
										);
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
						).pipe(
							Effect.andThen(
								Effect.forEach(Array.from({ length: LANES }), () => track(custom), {
									discard: true
								})
							)
						);
					};
					const pass = yield* daily(now);
					pruned = pass !== undefined;
					if (pass?.continued !== undefined) dues.push(pass.continued);
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
		/** Cron `id` at `slot`: the run id is their digest, so a repeat meets the row its first effect wrote. */
		const fire = Effect.fn('Runs.fire')(function* (id: string, slot: string) {
			const at = Date.parse(slot);
			if (!crons.some((entry) => entry.id === id) || !Number.isFinite(at))
				return yield* Effect.fail(
					BoltError.make('invalidInput', 'admission', `no cron '${id}' fires at '${slot}'`)
				);
			const now = yield* Clock.currentTimeMillis;
			const pass = yield* daily(now);
			if (pass?.continued !== undefined) yield* announce(iso(pass.continued));
			const run: Row = {
				id: sha256Hex(canonical(['cron', id, iso(at)])).slice(0, 32),
				automation: id,
				input: {},
				due_at: iso(at),
				run_key: null,
				cause: 'cron',
				depth: 0,
				attempts: 1,
				leases: 0,
				actor: null,
				starter: null,
				event: undefined
			};
			let written = false;
			const record = yield* Effect.cached(
				Effect.gen(function* () {
					const c = new Chain();
					const inserted = enqueue(
						c,
						{
							select: `SELECT ${c.p(run.id)}::text AS id, ${c.p(run.automation)}::text AS automation, ${c.p(run.due_at)}::timestamptz AS due_at, 'cron'::text AS cause, 0 AS depth, 'running'::text AS state, 1 AS attempts, ${c.p(iso(now))}::timestamptz AS started_at`
						},
						{ conflict: 'keep' }
					);
					const rows = yield* db.returning(
						Schema.Struct({ n: Schema.Number }),
						c.sql(`(SELECT count(*) FROM ${inserted})::int AS n`)
					);
					written = (rows[0]?.n ?? 0) > 0;
					return written;
				})
			);
			const dues = yield* lock(run.automation).withPermit(
				execute([run], { record, written: () => written })
			);
			if (dues.length > 0) yield* announce(iso(Math.min(...dues)));
			return { ran: written };
		});
		return {
			boot,
			tick,
			nudge: (at: string) => PubSub.publish(nudges, Date.parse(at)).pipe(Effect.asVoid),
			view,
			stop,
			webhook,
			crons: Effect.succeed(crons),
			fire
		};
	})
);
