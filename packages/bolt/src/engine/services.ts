// Native engine service contracts: `Context.Service` keys carry decoded activation values and area Shapes.
// Area modules implement these contracts as Layers; `engine/host.ts` composes the engine service graph.
// Effectful operations preserve their typed failure channels. Resources belong to the scope of the acquiring
// Layer or host, and interiors receive decoded values rather than unvalidated boundary data.
//
// Exported helper types define the shared signatures implemented by their owning modules.
import { Context } from 'effect';
import type { Effect, Option, Result, Schema, Scope, Stream } from 'effect';
import type { Json } from '../decl/values.ts';
import type { FacilityFailure, Unavailable } from '../decl/errors.ts';
import type { Frame, ImportStart } from '../protocol/schema.ts';
import type { Pred, Var } from '@norbital-ai/store';
import type { ReadIR } from '../protocol/reads.ts';
import { LIMITS } from './contracts.ts';
import type {
	AiModel,
	Authority,
	Bindings,
	Captured,
	CronEntry,
	CronFired,
	CrossAnswer,
	DriverEvent,
	Invocation,
	Outcome,
	QueuedRun,
	Reader,
	RowData,
	GuestOutcome
} from './contracts.ts';
import type { EngineError, Fenced, IdentityRefusal } from './errors.ts';
import type { BoltError } from '../protocol/errors.ts';
import type { EngineManifest } from './manifest.ts';
import type { Transport } from './ports.ts';
import type { PortFailure } from './port.ts';
import type { Holder } from './access/authority.ts';
import type { As, ConversationRow, MessageRow } from './agent/schema.ts';
import type { ApprovalView, DecideInput, Decision } from './approvals/approvals.ts';
import type { DeliveryReport, SendRefused } from './conversations/status.ts';
import type { DecisionRequest, DecisionResult } from './decisions/index.ts';
import type { GuestProgram } from './guest/runner.ts';
import type { RunView } from './runs/index.ts';
import type { WebhookRequest, WebhookResponse } from './runs/webhook.ts';
import type { Commit, RateCharge } from './write/commit.ts';
import type { Chain, ReadGuards } from './write/sql.ts';
import type { Verb } from './write/act.ts';

/** The Shape a service key carries (class-style or function-style). */
export type ShapeOf<K> = K extends Context.Key<infer _I, infer S> ? S : never;

// ── manifest and guest limits ──
/** The decoded manifest of this activation (K3 `decodeManifest`). */
export class Manifest extends Context.Service<Manifest, EngineManifest>()('bolt/Manifest') {}

/** The guest walls the engine holds (E4 reads them; tests override them); CPU is the host's. */
export type GuestLimitsShape = {
	readonly memoryMiB: number;
	readonly crossings: {
		readonly sync: number;
		readonly write: number;
		readonly automation: number;
	};
	readonly readBytes: number;
	readonly crossingBytes: number;
	readonly argsBytes: number;
};
export const GuestLimits = Context.Reference<GuestLimitsShape>('bolt/GuestLimits', {
	defaultValue: () => ({
		memoryMiB: LIMITS.guestMemoryMiB,
		crossings: LIMITS.crossings,
		readBytes: LIMITS.readBytes,
		crossingBytes: LIMITS.crossingBytes,
		argsBytes: LIMITS.argsBytes
	})
});

// ── activation: values the host binds for one generation ──
export type ActivationShape = {
	readonly scope: string;
	readonly epoch: string;
	readonly release: string;
	readonly publicUrl: string;
	readonly guest: Option.Option<GuestProgram>;
	readonly start: readonly string[];
};
export class Activation extends Context.Service<Activation, ActivationShape>()('bolt/Activation') {}

// ── reads (E3) ──
export type ReadsShape = {
	/** One batch = one crossing and one pipelined round trip; answers in order (rule 12). */
	readonly run: (
		batch: readonly ReadIR[],
		reader: Reader,
		bindings: Bindings,
		/** Host-selected origin for internal declared-query admission; defaults to Client. */
		from?: Entry
	) => Effect.Effect<readonly Json[], EngineError>;
};
export class Reads extends Context.Service<Reads, ReadsShape>()('bolt/Reads') {}

// ── writes (E5a) ──
/** The commit an act planned, before its statement runs (a batch recorder or proposal replay takes it). */
export type PlannedCommit = {
	readonly commit: Omit<Commit, 'key' | 'digest' | 'issuedAt' | 'rate'>;
	readonly lock?:
		{ readonly tables: readonly string[]; readonly mode: 'SHARE ROW EXCLUSIVE' } | undefined;
};
/** How an act is judged and where its commit goes, decided once (H7, F20); no hook-only request fields. */
export type ActMode =
	/** A caller's act: a page or Form, the agent, an automation's `ctx.act`, a per-record restore. */
	| { readonly _tag: 'Direct' }
	/**
	 * A remote sync's read page (B6): one act on the sync's own model, judged by no grant. The input is `verb: 'upsert'`,
	 * `onConflict: 'update'`, rows `{ id, ...fields }`: every row names its id (the id map's record, or one minted
	 * replay-stably for a new remote record), and an id with no stored row is CREATED with that id (this mode only). The
	 * model's `create.transform` / `update.transform` run on the split, `delete.check` on `deletes`; per-state `edit` never
	 * refuses it (rule 41).
	 */
	| {
			readonly _tag: 'Sync';
			/** `'<model>.sync.<sync>'`. */
			readonly sync: string;
			/** The `sys_integration` instance the page was read for. */
			readonly instance: string;
			/** The fields this page writes (the fields `read` returned); a row may write no other field. */
			readonly fields: readonly string[];
			/** Stored rows this page deletes (`$deleted`, or a closed snapshot's unseen rows). */
			readonly deletes: readonly string[];
			/** Pieces after `allp`: the cursor compare-and-set, `sys_sync_row` id map and `$version` stamps, inbox marks. */
			readonly pieces: (chain: Chain) => void;
	  }
	/** A generated verb planned into a batch's `sink`; `pending` rows are readable as refs (rule 36). */
	| {
			readonly _tag: 'Record';
			readonly sink: (planned: PlannedCommit) => void;
			readonly pending: ReadonlyMap<string, RowData>;
	  };
export type ActRequest = {
	readonly model: string;
	readonly verb: Verb;
	readonly input: Json;
	readonly mode: ActMode;
	/** Rule 31: the client-minted key, its `issuedAt`, and whether the client marked the request a retry. */
	readonly key: string;
	readonly issuedAt: string;
	readonly retry?: boolean | undefined;
	readonly authority: Authority;
	readonly bindings: Bindings;
	readonly invocationId: string;
	/** Rule 25: the revision the caller last read of each row its input names. */
	readonly observed?: { readonly [id: string]: number } | undefined;
	/** Rule 28: required on `upsert`. */
	readonly onConflict?: 'update' | 'keep' | undefined;
	/** Rule 38: the persisted buckets this act charges. */
	readonly rate?: readonly RateCharge[] | undefined;
	/** A per-record restore (`history.restore`): the record's revision is recorded as restored from `revision`. */
	readonly restored?: { readonly id: string; readonly revision: number } | undefined;
	/** Native automation read intent; never supplied by authored callable input. */
	readonly readGuards?: ReadGuards | undefined;
};
/** `v`: the live lane sequence the act replies with (rule 66). */
export type ActResult = {
	/** Only a fresh commit whose native read guards actually ran may consume its capture generation. */
	readonly readGuardsConsumed?: true;
	readonly outcome: Outcome;
	readonly captured: readonly Captured[];
	readonly v: number;
};
export type WritesShape = {
	readonly act: (request: ActRequest) => Effect.Effect<ActResult, EngineError>;
};
export class Writes extends Context.Service<Writes, WritesShape>()('bolt/Writes') {}

// ── callables (E6) ──
/** A callable name decoded once (`parseCallable`, M3): a generated verb, an automation or a sync (`'<m>.sync.<s>'`). */
export type Callable =
	| { readonly _tag: 'Verb'; readonly model: string; readonly verb: Verb }
	| { readonly _tag: 'Automation'; readonly automation: string }
	| { readonly _tag: 'Sync'; readonly model: string; readonly sync: string };
/** Rule 33a: `Server` is `ctx.act`/`ctx.query` from server code; everything else (`/act`, `/q`, `$bolt`, HTTP, agent) is `Client`. */
export type Entry = 'Client' | 'Server';
export type CallerContext = {
	readonly authority: Authority;
	readonly bindings: Bindings;
	readonly invocationId: string;
	readonly from: Entry;
	readonly observed?: { readonly [id: string]: number } | undefined;
	/** Native automation read intent, outside the guest ABI. */
	readonly readGuards?: ReadGuards | undefined;
};
/** Generated verbs over several models committed as one act. */
export type ActsRequest = CallerContext & {
	readonly name: string;
	readonly acts: readonly {
		readonly model: string;
		readonly verb: Verb;
		readonly input: Json;
		readonly observed?: Readonly<Record<string, number>> | undefined;
		readonly onConflict?: 'update' | 'keep' | undefined;
	}[];
	readonly key: string;
	readonly issuedAt: string;
};
export type StartRequest = {
	readonly automation: string;
	/** One run per entry, queued together in one statement: a bulk start is one request, not one per record. */
	readonly runs: readonly { readonly id: string; readonly input: Json }[];
	readonly authority: Authority;
	readonly bindings: Bindings;
};
/** A re-planned proposal (`guest`: its plan ran guest code), or the outcome that refuses it. */
/** `error`: the cause behind an `unknown` outcome (a guest throw or budget, rule 72a). */
export type CallResult = {
	readonly readGuardsConsumed?: true;
	readonly outcome: Outcome;
	readonly captured: readonly Captured[];
	readonly v: number;
	readonly error?: BoltError | undefined;
};
export type CallablesShape = {
	readonly acts: (request: ActsRequest) => Effect.Effect<CallResult, EngineError>;
	readonly start: (request: StartRequest) => Effect.Effect<Outcome, EngineError>;
};
export class Callables extends Context.Service<Callables, CallablesShape>()('bolt/Callables') {}

// ── approvals (E6) ──
export type ApprovalFilter = {
	readonly ids?: readonly string[] | undefined;
	readonly model?: string | undefined;
	readonly records?: readonly string[] | undefined;
	readonly all?: boolean | undefined;
};
/** Whether the caller may read the referenced record (the approval view's reader). */
export type Readable = (model: string, id: string) => Effect.Effect<boolean, EngineError>;
export type ApprovalsShape = {
	/**
	 * One decision on a request (`bolt.approvals.decide`): `approve`, `reject` or `requestChanges` (a reason required for
	 * the last two); a superseder's `approve` supersedes (reason required). `resubmit` is never decided here: it is the
	 * requester's save (`ApprovalHook.resubmit`).
	 */
	readonly decide: (input: DecideInput) => Effect.Effect<Decision, EngineError>;
	readonly view: (
		requestId: string,
		authority: Authority,
		readable: Readable
	) => Effect.Effect<Option.Option<ApprovalView>, EngineError>;
	readonly list: (
		filter: ApprovalFilter,
		authority: Authority,
		readable: Readable
	) => Effect.Effect<readonly ApprovalView[], EngineError>;
};
export class Approvals extends Context.Service<Approvals, ApprovalsShape>()('bolt/Approvals') {}

// ── decisions (E6) ──
export type DecisionUse = 'triage' | 'filter' | 'author';
export type DecisionsShape = {
	/** One `sys_1` call: one `decision.made` event (§5.12). */
	readonly decide: (
		use: DecisionUse,
		request: DecisionRequest
	) => Effect.Effect<DecisionResult, FacilityFailure | Unavailable>;
};
export class Decisions extends Context.Service<Decisions, DecisionsShape>()('bolt/Decisions') {}

// ── identity (E7) ──
/** A resolved session. */
export type Authenticated = {
	readonly user: string;
	readonly session: string;
	readonly impersonatedBy: string | null;
	/** Minted for the agent's browser: the conversation it acts in (`Authority.agent`). */
	readonly agent: NonNullable<Authority['agent']> | null;
	readonly expiresAt: number;
};
export type IdentityShape = {
	/** A session token (cached, `Cache.make`); no live session fails `IdentityRefusal`. */
	readonly authenticate: (token: string) => Effect.Effect<Authenticated, IdentityRefusal>;
	/** Rule 37: compiled once per `key` = (actor, affiliation revision, source release). */
	readonly authority: (holder: Holder, key?: string | undefined) => Effect.Effect<Authority>;
};
export class Identity extends Context.Service<Identity, IdentityShape>()('bolt/Identity') {}

// ── live (E8) ──
/** One registered view: its read (re-answered when a commit touches what it read). */
export type LiveView = {
	readonly read: ReadIR;
};
export type LiveShape = {
	/** Rule 66: routes one commit's RETURNING set through the commit lane; synchronous (`Queue.offerUnsafe`); answers the lane `v`. */
	readonly publish: (captured: readonly Captured[]) => number;
	/** Re-reads views after native metadata commits (no domain captures); synchronous like `publish`. */
	readonly syncChanged: (model: string, records?: readonly string[] | undefined) => number;
	/** The lane sequence of the last commit. */
	readonly v: Effect.Effect<number>;
	/** One connection's frames; its first is `hello` (the connection id). Ending the stream (its scope) disconnects. */
	readonly connect: (authority: Authority) => Stream.Stream<Frame>;
	/** Registers a view and sends its first answer; a refusal fails and leaves the stream as it was. */
	readonly register: (
		conn: string,
		view: string,
		read: LiveView
	) => Effect.Effect<void, EngineError>;
	readonly drop: (conn: string, view: string) => Effect.Effect<void>;
	/** Rule 66: an authority change re-answers the connection's views. */
	readonly authorize: (conn: string, authority: Authority) => Effect.Effect<void, EngineError>;
	readonly authorityOf: (conn: string) => Effect.Effect<Option.Option<Authority>>;
	/** Rule 66: a generation change closes every connection with `{ release }`. */
	readonly close: (release: string) => Effect.Effect<void>;
	/** Every published commit and metadata invalidation has been routed. */
	readonly settled: Effect.Effect<void>;
	readonly sweep: Effect.Effect<{
		readonly conservative: number;
		readonly views: readonly string[];
	}>;
	readonly retained: Effect.Effect<number>;
};
export class Live extends Context.Service<Live, LiveShape>()('bolt/Live') {}

// ── runs, run handlers, deadlines, wake (E9) ──
export type RetrySpec = { readonly attempts: number; readonly backoff: string };
/** A platform run's handler (`bolt.notify`, `bolt.embed`, a sync's read, …), run as the workspace's own work. */
export type RunHandler = (
	input: Json,
	run: { readonly id: string; readonly starter: Holder | null }
) => Effect.Effect<Json, EngineError>;
export type RunHandlersShape = {
	/** Areas register their platform runs once, at layer build. */
	readonly register: (
		handlers: { readonly [name: string]: RunHandler },
		retries?: { readonly [name: string]: RetrySpec } | undefined
	) => Effect.Effect<void>;
	readonly handler: (name: string) => Effect.Effect<Option.Option<RunHandler>>;
	readonly retry: (name: string) => Effect.Effect<Option.Option<RetrySpec>>;
};
/** The bottom service that breaks the runs ↔ areas cycle (D4). */
export class RunHandlers extends Context.Service<RunHandlers, RunHandlersShape>()(
	'bolt/RunHandlers'
) {}

export type RunsShape = {
	/** Restart recovery and release install: one statement, then `settle` (rule 52a). */
	readonly boot: Effect.Effect<void, EngineError>;
	/** One wake: claim every due run, run them, settle with the next due time. */
	readonly tick: Effect.Effect<void, EngineError>;
	/** A run queued for `at`: an open wake claims it when due. */
	readonly nudge: (at: string) => Effect.Effect<void>;
	readonly view: (
		authority: Authority,
		id: string
	) => Effect.Effect<Option.Option<RunView>, EngineError>;
	/** Stops a queued or running run for a viewer who reads it in full (rule 56). */
	readonly stop: (
		authority: Authority,
		id: string
	) => Effect.Effect<Option.Option<RunView>, EngineError>;
	readonly webhook: (
		path: string,
		request: WebhookRequest
	) => Effect.Effect<WebhookResponse, EngineError>;
	/** Every cron the manifest declares (automations' and remote syncs' periodic reads); the host's clock computes their slots. */
	readonly crons: Effect.Effect<readonly CronEntry[]>;
	/** Runs cron `id` for `slot` (an ISO minute), keyed by `(id, slot)`; the run writes its `sys_run` row only with its first effect. */
	readonly fire: (id: string, slot: string) => Effect.Effect<CronFired, EngineError>;
};
export class Runs extends Context.Service<Runs, RunsShape>()('bolt/Runs') {}

/** This activation's deadline scope (rule 52a): one next-due instant held by the host. */
export type DeadlinesShape = {
	readonly announce: (notLaterThan: string) => Effect.Effect<void>;
	readonly settle: (nextDue: string | null) => Effect.Effect<void>;
};
export class Deadlines extends Context.Service<Deadlines, DeadlinesShape>()('bolt/Deadlines') {}

/** The bottom service every area wakes the queue through: the host's deadline and the open tick's nudge. */
export type WakeShape = { readonly at: (at: string) => Effect.Effect<void> };
export class Wake extends Context.Service<Wake, WakeShape>()('bolt/Wake') {}

// ── conversations, envoys, turns (E11) ──
export type ConversationsShape = {
	/** Inbound messages and delivery reports an instance's link hands over (§4.5). */
	readonly receive: (
		instance: string,
		event: Exclude<DriverEvent, { kind: 'invalidate' }>,
		expectedImportStart?: ImportStart | null
	) => Effect.Effect<void, EngineError>;
	/** `ctx.send(to, message)`: answers the queued message's id. */
	readonly send: (
		to: string,
		message: Json,
		options: { readonly kind?: 'dm' | 'group' | undefined; readonly id?: string | undefined }
	) => Effect.Effect<string, EngineError>;
	readonly handlers: { readonly [name: string]: RunHandler };
};
export class Conversations extends Context.Service<Conversations, ConversationsShape>()(
	'bolt/Conversations'
) {}

export type EnvoysShape = {
	/** The admission run of one inbound message (FINAL §4.3). */
	readonly admit: (input: Json) => Effect.Effect<Json, EngineError>;
	readonly drain: (
		conversation: string
	) => Effect.Effect<{ readonly ran: boolean; readonly sent: number }, EngineError>;
	/** Every envoy turn started so far has finished and shipped its replies (`FiberSet.awaitEmpty`). */
	readonly settled: Effect.Effect<void>;
	readonly handlers: { readonly [name: string]: RunHandler };
	readonly retries: { readonly [name: string]: RetrySpec };
};
export class Envoys extends Context.Service<Envoys, EnvoysShape>()('bolt/Envoys') {}

/** Who runs a conversation's turn: the in-app agent, or the envoy on its instance. */
export type TurnVia = 'Agent' | 'Envoy';
/** The bottom service that breaks triage ↔ envoys ↔ agents (D4). */
export type TurnsShape = {
	readonly drain: (
		conversation: string,
		via: TurnVia
	) => Effect.Effect<{ readonly ran: boolean }, EngineError>;
	/** Releases a conversation held by triage (rule 60a). */
	readonly release: (conversation: string) => Effect.Effect<void, EngineError>;
};
export class Turns extends Context.Service<Turns, TurnsShape>()('bolt/Turns') {}

// ── agents (E12a) ──
/** One turn's drain: whether it ran, and the reply it settled. */
export type TurnResult = { readonly ran: boolean; readonly reply: MessageRow | null };
export type AgentsShape = {
	readonly start: (o: {
		readonly owner?: string | null | undefined;
		readonly envoy?: string | null | undefined;
		readonly integration?: string | null | undefined;
		readonly parent?: string | null | undefined;
		readonly title?: string | null | undefined;
		readonly model?: string | undefined;
	}) => Effect.Effect<string, EngineError>;
	readonly post: (o: {
		readonly conversation: string;
		readonly as: As;
		readonly text: string;
		readonly author?: string | null | undefined;
		readonly files?: readonly Json[] | undefined;
		readonly mode?: 'agent' | 'plan' | 'compact' | undefined;
		readonly supersedes?: string | undefined;
		readonly tz?: string | undefined;
	}) => Effect.Effect<MessageRow, EngineError>;
	readonly drain: (conversation: string) => Effect.Effect<TurnResult, EngineError>;
	readonly conversation: (id: string) => Effect.Effect<ConversationRow, EngineError>;
	readonly transcript: (
		id: string,
		page?:
			{ readonly from: number } | { readonly before: number; readonly limit: number } | undefined
	) => Effect.Effect<readonly MessageRow[], EngineError>;
	/** The member's own panel uploads as stored `FileRef`s; a refused set fails with the reason. */
	readonly attachments: (
		member: string,
		refs: readonly Json[]
	) => Effect.Effect<readonly Json[], EngineError>;
	/** Stop interrupts the turn's fiber (the in-flight model call included). */
	readonly stop: (id: string) => Effect.Effect<void, EngineError>;
	/** A stopped conversation recalls its stopped objective, then drains. */
	readonly resume: (id: string) => Effect.Effect<TurnResult, EngineError>;
	readonly setModel: (id: string, model: string) => Effect.Effect<void, EngineError>;
	readonly setAgent: (id: string, agent: string) => Effect.Effect<void, EngineError>;
	/** A queued input is edited in place (`none`); a consumed one is superseded by a new queued input (its id). */
	readonly revise: (
		messageId: string,
		text: string,
		by?: Authority | undefined
	) => Effect.Effect<Option.Option<string>, EngineError>;
	readonly dequeue: (
		messageId: string,
		by?: Authority | undefined
	) => Effect.Effect<void, EngineError>;
	readonly reorder: (
		conversation: string,
		ids: readonly string[],
		by?: Authority | undefined
	) => Effect.Effect<void, EngineError>;
	readonly executePlan: (id: string, as: As) => Effect.Effect<TurnResult, EngineError>;
	readonly discardPlan: (id: string) => Effect.Effect<void, EngineError>;
	readonly file: (
		messageId: string,
		about: { readonly model: string; readonly id: string } | null
	) => Effect.Effect<void, EngineError>;
	readonly markRead: (id: string, member: string) => Effect.Effect<void, EngineError>;
	readonly confirm: (
		messageId: string,
		approve: boolean,
		by: Authority
	) => Effect.Effect<TurnResult, EngineError>;
	readonly models: Effect.Effect<
		{ readonly models: readonly AiModel[]; readonly default: string },
		EngineError
	>;
	readonly exportTranscript: (id: string) => Effect.Effect<string, EngineError>;
	readonly handlers: { readonly [name: string]: RunHandler };
};
export class Agents extends Context.Service<Agents, AgentsShape>()('bolt/Agents') {}

// ── links (E10a) ──
export type OutboundFile = {
	readonly id: string;
	readonly name: string;
	readonly mime: string;
	readonly bytes: Uint8Array;
	readonly url?: ((expiresInS: number) => Effect.Effect<string, PortFailure>) | undefined;
};
export type LinksShape = {
	/** Opens (or joins) the instance's held link (`RcMap`, `acquireRelease(open, close)`). */
	readonly open: (instance: string) => Effect.Effect<void, EngineError>;
	readonly close: (instance: string) => Effect.Effect<void>;
	/** A committed change of what the instance's link opened with (configuration, pause, delete): close, then reopen as the row is now. */
	readonly changed: (instance: string) => Effect.Effect<void>;
	readonly typing: (
		instance: string,
		to: string,
		on: boolean
	) => Effect.Effect<void, FacilityFailure | Unavailable>;
	/** A link's durable status onto the instance row, when it changed (§3). */
	readonly status: (
		instance: string,
		patch: { readonly [key: string]: Json }
	) => Effect.Effect<void, EngineError>;
	/** A provider's refusal of the message is `SendRefused` (permanent or retried). */
	readonly send: (
		instance: string,
		message: Json,
		attachments: readonly OutboundFile[]
	) => Effect.Effect<
		{ readonly providerId: string; readonly presumeAfterMs?: number | undefined },
		FacilityFailure | Unavailable | SendRefused | Fenced
	>;
	readonly request: (
		instance: string,
		operation: Json
	) => Effect.Effect<Json, FacilityFailure | Unavailable | Fenced>;
};
export class Links extends Context.Service<Links, LinksShape>()('bolt/Links') {}

// ── outbound conversation messages (E10b) ──
export type OutboundShape = {
	/** One delivery pass over the queued outbound rows. */
	readonly deliver: Effect.Effect<{ readonly sent: number; readonly failed: number }, EngineError>;
	readonly delivered: (
		instance: string,
		providerId: string,
		report: DeliveryReport
	) => Effect.Effect<Option.Option<Outcome>, EngineError>;
	readonly replied: (
		instance: string,
		refs: readonly string[],
		reply: { row: string; at: string; auto: boolean; message: Json }
	) => Effect.Effect<Option.Option<Outcome>, EngineError>;
	/** Records the environment's epoch (rule 61). */
	readonly activate: Effect.Effect<void, EngineError>;
	readonly handlers: { readonly [name: string]: RunHandler };
};
export class Outbound extends Context.Service<Outbound, OutboundShape>()('bolt/Outbound') {}

// ── guest crossings (E4) ──
/** Bytes of a crossing ride `bins`, referenced from `args` as `{ "$bin": n }` (§5.8.1). */
type Bins = { readonly bins?: readonly Uint8Array[] | undefined };
/** One facility member's call; E4's `lower()` decodes `args` per member. */
type FacilityArm<T extends string> = { readonly _tag: T; readonly args: readonly Json[] } & Bins;
export type FacilityCall =
	| FacilityArm<'web.read'>
	| FacilityArm<'files.meta'>
	| FacilityArm<'files.get'>
	| FacilityArm<'files.url'>
	| FacilityArm<'files.text'>
	| FacilityArm<'files.table'>
	| FacilityArm<'files.sheet'>
	| FacilityArm<'files.image'>
	| FacilityArm<'files.put'>
	| FacilityArm<'convert.document'>
	| FacilityArm<'ai.sys_1.decide'>
	| FacilityArm<'ai.sys_2.infer'>
	| FacilityArm<'ai.embed'>
	| FacilityArm<'ai.transcribe'>
	| FacilityArm<'ai.speak'>
	| FacilityArm<'geo.search'>
	| FacilityArm<'geo.reverse'>;
export type ActOptions = {
	readonly key?: string | undefined;
	readonly once?: string | undefined;
	readonly onConflict?: 'update' | 'keep' | undefined;
	readonly observed?: { readonly [id: string]: number } | undefined;
};
/** A guest request to the host, decoded once at the crossing (M2); calls issued before the microtask queue drains cross together (rule 12). */
export type CrossCall =
	| { readonly _tag: 'transactionBegin' }
	| {
			readonly _tag: 'transactionRead';
			readonly reads: readonly ReadIR[];
			readonly keys?: readonly string[];
	  }
	| {
			readonly _tag: 'transactionAct';
			readonly callable: Extract<Callable, { readonly _tag: 'Verb' }>;
			readonly input: Json;
			readonly onConflict?: 'update' | 'keep';
	  }
	| { readonly _tag: 'transactionFinish'; readonly output: Json; readonly omitted: boolean }
	| { readonly _tag: 'transactionAbort' }
	| {
			readonly _tag: 'read';
			readonly read: ReadIR;
	  }
	| {
			readonly _tag: 'act';
			readonly callable: Callable;
			readonly input: Json;
			readonly options?: ActOptions | undefined;
	  }
	| {
			readonly _tag: 'acts';
			readonly acts: readonly {
				readonly callable: Callable;
				readonly input: Json;
				readonly observed?: Readonly<Record<string, number>> | undefined;
				readonly onConflict?: 'update' | 'keep' | undefined;
			}[];
	  }
	| {
			readonly _tag: 'schedule';
			readonly automation: string;
			readonly input: Json;
			readonly at?: string | { readonly var: string } | undefined;
			readonly key?: string | undefined;
	  }
	| { readonly _tag: 'notify'; readonly notices: Json }
	/** `ctx.send`: `to` is an automation's addressee, `null` in a sync body (its instance's conversation driver). */
	| { readonly _tag: 'send'; readonly to: string | null; readonly message: Json }
	/** `ctx.request`: `to` is the automation's target, `null` in a sync or integration body (its instance). */
	| { readonly _tag: 'request'; readonly to: string | null; readonly operation: Json }
	/** `ctx.progress` (automations only). */
	| { readonly _tag: 'progress'; readonly progress: Json }
	| FacilityCall;
/** The host half of a crossing: answers in call order. Interrupting it ends the crossing (no signal). */
export type Bridge = {
	readonly cross: (calls: readonly CrossCall[]) => Effect.Effect<readonly CrossAnswer[]>;
};
export type GuestShape = {
	/** One fresh-isolate run of one body; a budget, a throw or a bad answer is a `failed` outcome, never a failure of this Effect. */
	readonly invoke: (invocation: Invocation, bridge: Bridge) => Effect.Effect<GuestOutcome>;
	/** Runs a host-selected source program through the same generation, isolate ownership and cumulative budgets. */
	readonly invokeProgram: (
		program: GuestProgram,
		invocation: Invocation,
		bridge: Bridge
	) => Effect.Effect<GuestOutcome>;
};
export class Guest extends Context.Service<Guest, GuestShape>()('bolt/Guest') {}

export type EventIds = {
	readonly invocation: string;
	readonly run?: string | undefined;
	readonly conversation?: string | undefined;
	readonly turn?: string | undefined;
};
export type InvocationEvents = {
	readonly emit: (
		severity: 'info' | 'warn' | 'error',
		event: string,
		attributes: { readonly [key: string]: Json }
	) => Effect.Effect<void>;
};
export type TelemetryShape = {
	/** One invocation's events (§5.12), each written to the host's runtime log as it happens. */
	readonly open: (ids: EventIds) => Effect.Effect<InvocationEvents, never, Scope.Scope>;
};
export class Telemetry extends Context.Service<Telemetry, TelemetryShape>()('bolt/Telemetry') {}

// ── facilities (E10b, `engine/facilities.ts`, shared by every host) ──
export type FacilitiesShape = {
	/** One facility crossing by its `_tag`, through the host's ports; a failure is the answer, never a failure of this Effect. */
	readonly dispatch: (call: FacilityCall) => Effect.Effect<CrossAnswer>;
	/** A stored file's bytes by id: the `sys_file` row, then the files port. */
	readonly fileLoader: (
		fileId: string
	) => Effect.Effect<
		{ readonly mime: string; readonly bytes: Uint8Array },
		FacilityFailure | Unavailable
	>;
	/** A transport that logs each send as one line (dev hosts and tests). */
	readonly loggedTransport: (
		kind: string,
		log: (line: string) => void
	) => ShapeOf<typeof Transport>;
};
export class Facilities extends Context.Service<Facilities, FacilitiesShape>()('bolt/Facilities') {}

// ── pinned helper signatures ──
/** E2, `runs/queue.ts` `enqueue`: the sole `sys_run` writer; adds its CTE to `chain` and answers the CTE's name. */
export type Enqueue = (
	chain: Chain,
	rows: readonly QueuedRun[] | { readonly select: string }
) => string;
/** E2, `runs/time.ts`: the one duration, offset, due and backoff arithmetic (M4). */
export type RunTime = {
	/** A `Duration` literal (`'15min'`, `'7d'`) in milliseconds. */
	readonly duration: (d: string) => number;
	/** `'+30d'`, `'-1h'`, `''` in milliseconds. */
	readonly offsetMs: (o: string) => number;
	/** Rule 52a: exact when less than `BUCKET_MS` ahead, else rounded up to the bucket (epoch ms). */
	readonly dueAt: (now: number, at: number) => number;
	/** Rule 54: the delay before attempt `attempt + 1` of a `backoff` spec, capped at an hour; jitter is the caller's. */
	readonly backoffMs: (backoff: string, attempt: number) => number;
	readonly BUCKET_MS: number;
};
/** A `sys_message` row as a piece builder writes it. */
export type MessageInsert = {
	readonly conversation: string;
	readonly role: MessageRow['role'];
	readonly content: Json;
	readonly text?: string | null | undefined;
	readonly state?: MessageRow['state'] | undefined;
	readonly mode?: MessageRow['mode'] | undefined;
	readonly as?: As | null | undefined;
	readonly author?: string | null | undefined;
	readonly meta?: Json | undefined;
	readonly files?: Json | undefined;
	readonly turn?: string | null | undefined;
	readonly supersedes?: string | null | undefined;
};
/** E2, `conversations/store.ts`: the sole `sys_message` writers; each adds its CTE to `chain` and answers its name. */
export type MessageStore = {
	readonly post: (chain: Chain, message: MessageInsert) => string;
	/** A turn takes the conversation's pending inputs (`consumed`, `turn` set). */
	readonly claim: (chain: Chain, conversation: string, turn: string) => string;
	/** A streaming reply's text so far. */
	readonly stream: (chain: Chain, message: string, text: string) => string;
	/** A row's final content and state. */
	readonly settle: (
		chain: Chain,
		message: string,
		patch: Pick<MessageInsert, 'content' | 'text' | 'state' | 'meta'>
	) => string;
	/** A turn's queued inputs cancelled (`turn` null: every queued input). */
	readonly cancel: (chain: Chain, conversation: string, turn: string | null) => string;
	/** An outbound row's provider id and send time, once its link answered. */
	readonly deliver: (
		chain: Chain,
		message: string,
		delivery: { readonly providerId: string; readonly sentAt: string }
	) => string;
	/** A member's read mark or filing (`about`) on a message. */
	readonly mark: (
		chain: Chain,
		message: string,
		mark:
			| { readonly readBy: string }
			| { readonly about: { readonly model: string; readonly id: string } | null }
	) => string;
};
/** E6, `callables/index.ts` `parseCallable` and `VERBS` (M3). */
export type ParseCallable = (
	callable: string,
	manifest: EngineManifest
) => Result.Result<Callable, BoltError>;
export type Verbs = readonly Verb[];
/** E7, `access/*`: one evaluator over compiled grant arms. */
export type Admits = (
	arms: readonly {
		readonly policy: string;
		readonly where: Pred;
		readonly fields: readonly string[] | 'all';
	}[],
	field: string
) => boolean;
export type WritableColumns = (
	authority: Authority,
	model: string,
	verb: 'create' | 'update'
) => ReadonlySet<string> | 'all';
export type VisitorMayRead = (authority: Authority, model: string) => boolean;
export type OperandValue = (operand: Var, authority: Authority) => Json;
/** Who may open an app or kiosk: a signed-in audience, no authentication (`none`), or a public app's policies. */
export type Audience =
	| 'members'
	| 'external'
	| 'all'
	| 'none'
	| { readonly public: readonly string[]; readonly challenge?: 'turnstile' | undefined };
/** R4a, `decl/runtime/kiosk.ts` (pure): kiosk lookup and audience admission, for rules, the shell server and nav. */
export type KioskOf = (
	manifest: EngineManifest,
	kiosk: string
) => Option.Option<{ readonly auth: Audience; readonly policies: readonly string[] }>;
export type AudienceAdmits = (audience: Audience, authority: Authority) => boolean;
export type CanOpenKiosk = (
	manifest: EngineManifest,
	kiosk: string,
	authority: Authority
) => boolean;
/** E5b, `write/sql.ts`: a row's own predicate over `row` (its alias) as SQL; `twoValued` compiles NULL as false (DDL checks, H5). */
export type OwnPredSql = (pred: Pred, row: string, chain: Chain, twoValued: boolean) => string;
/** E12a, `agent/callables.ts`: the OWN agent and conversation callables by name, each with its input Schema. */
export type AgentCallables = {
	readonly [name: string]: {
		readonly input: Schema.Codec<unknown, Json>;
		readonly run: (input: unknown, authority: Authority) => Effect.Effect<Json, EngineError>;
	};
};
