// Native engine service contracts: `Context.Service` keys carry decoded activation values and area Shapes.
// Area modules implement these contracts as Layers; `engine/host.ts` composes the engine service graph.
// Effectful operations preserve their typed failure channels. Resources belong to the scope of the acquiring
// Layer or host, and interiors receive decoded values rather than unvalidated boundary data.
//
// Cross-area contracts live here; implementation helpers stay with their owners.
import { Context } from 'effect';
import type { Effect, Option, PubSub, Scope, Stream } from 'effect';
import type { Json } from '../decl/values.ts';
import type { FacilityMember } from '../decl/runtime/facility-members.ts';
import type { FacilityFailure, Unavailable } from '../decl/errors.ts';
import type { Frame, ImportStart, PageResult } from '../protocol/schema.ts';
import type { EffectEvent } from '../protocol/effect-events.ts';
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
	ReconcilePage,
	Invocation,
	NativeWriteConflict,
	Outcome,
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
import type { DeliveryReport, OutboundReference, SendReceipt, SendRefused } from './conversations/status.ts';
import type { DecisionRequest, DecisionResult } from './decision.ts';
import type { GuestProgram } from './guest/runner.ts';
import type { RunView } from './runs/rows.ts';
import type { Commit, RateCharge } from './write/commit.ts';
import type { Chain, ReadGuards } from './write/sql.ts';
import type { Verb } from './write/act.ts';

/** The Shape a service key carries (class-style or function-style). */
export type ShapeOf<K> = K extends Context.Key<infer _I, infer S> ? S : never;

// ── manifest and guest limits ──
/** The decoded manifest of this activation (K3 `decode_manifest`). */
export class Manifest extends Context.Service<Manifest, EngineManifest>()('bolt/Manifest') {}

/** The guest walls the engine holds (E4 reads them; tests override them); CPU is the host's. */
export type GuestLimitsShape = {
	readonly memory_mib: number;
	readonly crossings: {
		readonly sync: number;
		readonly write: number;
		readonly automation: number;
	};
	readonly read_bytes: number;
	readonly crossing_bytes: number;
	readonly args_bytes: number;
	readonly change_set_bytes: number;
};
export const GuestLimits = Context.Reference<GuestLimitsShape>('bolt/GuestLimits', {
	defaultValue: () => ({
		memory_mib: LIMITS.guestMemoryMiB,
		crossings: LIMITS.crossings,
		read_bytes: LIMITS.readBytes,
		crossing_bytes: LIMITS.crossingBytes,
		args_bytes: LIMITS.argsBytes,
		change_set_bytes: LIMITS.changeSetBytes
	})
});

// ── activation: values the host binds for one generation ──
type ActivationShape = {
	readonly scope: string;
	readonly epoch: string;
	readonly release: string;
	readonly public_url: string;
	readonly guest: Option.Option<GuestProgram>;
	/** `HostPorts.overran`: the previous generation stopped past a unit's CPU budget. */
	readonly overran?: string;
};
export class Activation extends Context.Service<Activation, ActivationShape>()('bolt/Activation') {}

// ── reads (E3) ──
export type ReadsShape = {
	/** One batch = one crossing and one pipelined round trip; answers in order. */
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
/** How an act is judged and where its commit goes, decided once (H7); no hook-only request fields. */
export type ActMode =
	/** A caller's act: a page or Form, the agent, an automation's `ctx.act`, a per-record restore. */
	| { readonly _tag: 'Direct' }
	/**
	 * A remote sync's read page (B6): one act on the sync's own model, judged by no grant. The input is `verb: 'upsert'`,
	 * `on_conflict: 'update'`, rows `{ id, ...fields }`: every row names its id (the id map's record, or one minted
	 * replay-stably for a new remote record), and an id with no stored row is CREATED with that id (this mode only). The
	 * model's `create.transform` / `update.transform` run on the split; lock constraints refuse incoming changes as they do local writes.
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
	/** A generated verb planned into a batch's `sink`; `pending` rows are readable as refs. */
	| {
			readonly _tag: 'Record';
			readonly sink: (planned: PlannedCommit) => void;
			readonly pending: ReadonlyMap<string, RowData>;
			/** The model whose approved write carries these rows (its `on_approved`, planned by the approving decision). */
			readonly carriedBy?: string;
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
	readonly on_conflict?: NativeWriteConflict | undefined;
	/** Rule 38: the persisted buckets this act charges. */
	readonly rate?: readonly RateCharge[] | undefined;
	/** A per-record restore (`history.restore`): the record's revision is recorded as restored from `revision`. */
	readonly restored?: { readonly id: string; readonly revision: number } | undefined;
	/** Native automation read intent; never supplied by authored callable input. */
	readonly readGuards?: ReadGuards | undefined;
};
/** `v`: the live lane sequence the act replies with. */
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
/** A callable name decoded once (`parse_callable`, M3): a generated verb or an automation. */
export type ParsedCallable =
	| { readonly _tag: 'Verb'; readonly model: string; readonly verb: Verb }
	| { readonly _tag: 'Automation'; readonly automation: string };
/** Rule 33a: `Server` is `ctx.act`/`ctx.query` from server code; everything else (`/act`, `/q`, the page client, HTTP, agent) is `Client`. */
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
	readonly outputs?: readonly string[] | undefined;
	readonly retry?: boolean | undefined;
	readonly rate?: readonly import('./write/commit.ts').RateCharge[] | undefined;
	readonly acts: readonly {
		readonly model: string;
		readonly verb: Verb;
		readonly input: Json;
		readonly observed?: Readonly<Record<string, number>> | undefined;
		readonly on_conflict?: NativeWriteConflict | undefined;
	}[];
	readonly key: string;
	readonly issuedAt: string;
};
/** The acts as JSON: an absent `observed` or `on_conflict` is left out, as JSON leaves out an undefined member. */
export const acts_json = (acts: ActsRequest['acts']) =>
	acts.map(({ observed, on_conflict, ...act }) => ({
		...act,
		...(observed === undefined ? {} : { observed }),
		...(on_conflict === undefined ? {} : { on_conflict })
	}));
export type StartRequest = {
	readonly automation: string;
	/** One run per entry, queued together in one statement: a bulk start is one request, not one per record. */
	readonly runs: readonly { readonly id: string; readonly input: Json }[];
	readonly authority: Authority;
	readonly bindings: Bindings;
	/** Norbius started it in this conversation for `authority`'s member (recorded on the run's trigger). */
	readonly agent?: { readonly conversation: string };
};
/** Native manual sync control, separate from authored automation starts and schedules. */
export type SyncControlRequest = Omit<StartRequest, 'automation' | 'runs'> & {
	readonly model: string;
	readonly sync: string;
	readonly id: string;
	readonly input: Json;
};
export type AutomationRequest = {
	readonly automation: string;
	readonly input: Json;
	readonly authority: Authority;
	readonly bindings: Bindings;
	readonly agent?: { readonly conversation: string };
};
/** A re-planned proposal (`guest`: its plan ran guest code), or the outcome that refuses it. */
/** `error`: the cause behind an `unknown` outcome (a guest throw or budget). */
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
	readonly sync_control: (request: SyncControlRequest) => Effect.Effect<Outcome, EngineError>;
	readonly admitAutomation: (request: Omit<AutomationRequest, 'input'> & {
		readonly inputs: readonly Json[];
	}) => Effect.Effect<readonly Json[] | Extract<Outcome, { kind: 'refused' }>, EngineError>;
};
export class Callables extends Context.Service<Callables, CallablesShape>()('bolt/Callables') {}

/** Execution metadata shared by request calls and durable attempts; it is never a fabricated ledger row. */
export type AutomationExecution = {
	readonly id: string;
	readonly automation: string;
	readonly input: Json;
	readonly cause: string;
	readonly depth: number;
	readonly attempts: number;
	readonly starter: Holder | null;
	readonly trigger?: import('./contracts.ts').RunTrigger | null;
};
export type AutomationJob = {
	/** Decoded effect event from the durable input; absent for automations. */
	readonly event?: EffectEvent;
	readonly ids: readonly string[];
	readonly record: Effect.Effect<boolean, EngineError>;
	readonly halt: import('effect').Deferred.Deferred<void>;
	readonly stopped: () => boolean;
	readonly stop: () => void;
	readonly dues: number[];
	readonly warnings: string[];
};
export type AutomationsShape = {
	readonly park: Effect.Effect<void>;
	readonly call: (request: AutomationRequest) => Effect.Effect<Outcome, EngineError>;
	readonly invoke: (execution: AutomationExecution, holder: Holder, input: Json, job?: AutomationJob) => Effect.Effect<GuestOutcome, EngineError>;
};
export class Automations extends Context.Service<Automations, AutomationsShape>()('bolt/Automations') {}

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
	 * One decision on a request (`bolt.approvals.decide`): `approve`, `reject` or `request_changes` (a reason required for
	 * the last two); a superseder's `approve` supersedes (reason required). `resubmit` is never decided here: it is the
	 * requester's save (`ApprovalHook.resubmit`).
	 */
	readonly decide: (input: DecideInput) => Effect.Effect<Decision, EngineError>;
	readonly view: (
		request_id: string,
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
	/** One `sys_1` call: one `decision.made` event. */
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
	readonly authority: (holder: Holder, key?: string | undefined) => Effect.Effect<Authority, BoltError>;
};
export class Identity extends Context.Service<Identity, IdentityShape>()('bolt/Identity') {}
/** The host's transactional identity operations, shared by shell forms and confirmed agent actions. */
export class HostIdentity extends Context.Service<
	HostIdentity,
	import('./identity/session.ts').IdentityHost
>()('bolt/HostIdentity') {}

// ── live (E8) ──
/** One registered view: its read (re-answered when a commit touches what it read). */
export type LiveView = {
	readonly read: ReadIR;
};
export type LiveShape = {
	/** Rule 66: routes one commit's RETURNING set through the commit lane; synchronous (`Queue.offerUnsafe`); answers the lane `v`. */
	readonly publish: (captured: readonly Captured[]) => number;
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
	/** Every published commit has been routed. */
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
/** A platform run's handler (`bolt.embed`, a sync's read, …), run as the workspace's own work. */
export type RunHandler = (
	input: Json,
	run: {
		readonly id: string;
		readonly starter: Holder | null;
		readonly cause?: string;
		readonly attempts?: number;
	}
) => Effect.Effect<Json, EngineError>;
/** When a platform cron with nothing to do at `now` next has something; `undefined`: its slot runs. */
export type RunRest = (now: number) => Effect.Effect<number | undefined, EngineError>;
type RunRestOf = (name: string, now: number) => Effect.Effect<number | undefined, EngineError>;
export type RunHandlersShape = {
	/** Areas register their platform runs once, at layer build. */
	readonly register: (
		handlers: { readonly [name: string]: RunHandler },
		retries?: { readonly [name: string]: RetrySpec } | undefined,
		rests?: { readonly [name: string]: RunRest } | undefined
	) => Effect.Effect<void>;
	readonly handler: (name: string) => Effect.Effect<Option.Option<RunHandler>>;
	readonly resting: RunRestOf;
	readonly retry: (name: string) => Effect.Effect<Option.Option<RetrySpec>>;
};
/** The bottom service that breaks the runs ↔ areas cycle (D4). */
export class RunHandlers extends Context.Service<RunHandlers, RunHandlersShape>()(
	'bolt/RunHandlers'
) {}

export type RunsShape = {
	/**
	 * A generation's recovery, run as it activates: the runs the previous one left `running` rerun (up to 3
	 * leases), or fail `cpu_budget` with `overran` when it stopped past a unit's CPU budget; then `settle`.
	 */
	readonly boot: (overran?: string) => Effect.Effect<readonly string[], EngineError>;
	/** One wake: claim every due run, run them, settle with the next due time. */
	readonly tick: Effect.Effect<void, EngineError>;
	/** A due notification for an existing wake; false leaves it for the host's next wake. */
	readonly pulse: Effect.Effect<boolean>;
	/** A planned close: no run starts from now on; answers once the running automations ended. */
	readonly park: Effect.Effect<void>;
	readonly view: (
		authority: Authority,
		id: string
	) => Effect.Effect<Option.Option<RunView>, EngineError>;
	/** Stops a queued or running run for a viewer who reads it in full. */
	readonly stop: (
		authority: Authority,
		id: string
	) => Effect.Effect<Option.Option<RunView>, EngineError>;
	/** Every cron the manifest declares (automations' and remote syncs' periodic reads); the host's clock computes their slots. */
	readonly crons: Effect.Effect<readonly CronEntry[]>;
	/** Runs cron `id` for `slot` (an ISO minute), keyed by `(id, slot)`; the run writes its `sys_run` row only with its first effect. */
	readonly fire: (id: string, slot: string) => Effect.Effect<CronFired, EngineError>;
};
export class Runs extends Context.Service<Runs, RunsShape>()('bolt/Runs') {}

/** This activation's deadline scope: one next-due instant held by the host. */
export type DeadlinesShape = {
	readonly announce: (notLaterThan: string) => Effect.Effect<void>;
	readonly settle: (nextDue: string | null) => Effect.Effect<void>;
};
export class Deadlines extends Context.Service<Deadlines, DeadlinesShape>()('bolt/Deadlines') {}

/** The bottom service every area wakes the queue through: the host's deadline and the open tick's nudge. */
export type WakeShape = { readonly at: (at: string) => Effect.Effect<void> };
export class Wake extends Context.Service<Wake, WakeShape>()('bolt/Wake') {}
/**
 * The ids of runs that reached an end (succeeded, failed, stopped), published as each end is written: what an agent's run
 * job waits on instead of polling the ledger.
 */
export class RunEnds extends Context.Service<RunEnds, PubSub.PubSub<readonly string[]>>()(
	'bolt/RunEnds'
) {}

// ── conversations, envoys, turns (E11) ──
export type ConversationsShape = {
	/** Inbound messages and delivery reports an instance's link hands over. */
	readonly receive: (
		instance: string,
		event: Exclude<DriverEvent, { kind: 'invalidate' }>,
		expectedImportStart?: ImportStart | null
	) => Effect.Effect<void, EngineError>;
	/** The threads a reconcile walks (`Link.reconcile`), newest first, and the instant it asks each one from. */
	readonly recent: (
		instance: string
	) => Effect.Effect<{ readonly since: string; readonly threads: readonly string[] }, EngineError>;
	/** Makes one thread's stored rows match the platform's view; a view that differs in nothing writes nothing. */
	readonly repair: (
		instance: string,
		thread: string,
		since: string,
		page: ReconcilePage,
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
	/** The admission run of one inbound message. */
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
	/** Releases a conversation held by triage. */
	readonly release: (conversation: string) => Effect.Effect<void, EngineError>;
};
export class Turns extends Context.Service<Turns, TurnsShape>()('bolt/Turns') {}

// ── agents (E12a) ──
/** One turn's drain: whether it ran, and the reply it settled. */
export type TurnResult = { readonly ran: boolean; readonly reply: MessageRow | null };
export type AgentsShape = {
	/** A planned close: every turn holds at its next step; answers once none is inside one. */
	readonly park: Effect.Effect<void>;
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
		readonly question?: string | undefined;
		readonly author?: string | null | undefined;
		readonly files?: readonly Json[] | undefined;
		readonly mode?: 'agent' | 'plan' | 'compact' | undefined;
		readonly supersedes?: string | undefined;
		readonly tz?: string | undefined;
	}) => Effect.Effect<MessageRow, EngineError>;
	/** Runs the conversation once its running turn (if any) ends, so input that landed as it finished is not left queued. */
	readonly kick: (id: string) => Effect.Effect<void>;
	/** Each conversation whose turn no run will finish says so: `Runs.boot` released them. */
	readonly gaveUp: (conversations: readonly string[]) => Effect.Effect<void, EngineError>;
	/** Append a system note (an approved or rejected request) and wake the conversation's turn. */
	readonly notify: (o: {
		readonly conversation: string;
		readonly text: string;
		readonly as?: As | null | undefined;
	}) => Effect.Effect<void, EngineError>;
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
	readonly set_model: (id: string, model: string) => Effect.Effect<void, EngineError>;
	readonly set_agent: (id: string, agent: string) => Effect.Effect<void, EngineError>;
	/** A queued input is edited in place (`none`); a consumed one is superseded by a new queued input (its id). */
	readonly revise: (
		messageId: string,
		text: string,
		by?: Authority | undefined,
		attachments?: readonly Json[] | undefined
	) => Effect.Effect<Option.Option<string>, EngineError>;
	/** An independent snapshot before the chosen input, plus that input for the new composer. */
	readonly restart: (message: string, by: Authority) => Effect.Effect<{
		readonly conversation: string;
		readonly message: MessageRow;
	}, EngineError>;
	readonly dequeue: (
		messageId: string,
		by?: Authority | undefined
	) => Effect.Effect<void, EngineError>;
	readonly reorder: (
		conversation: string,
		ids: readonly string[],
		by?: Authority | undefined
	) => Effect.Effect<void, EngineError>;
	readonly execute_plan: (id: string, as: As) => Effect.Effect<TurnResult, EngineError>;
	readonly discard_plan: (id: string) => Effect.Effect<void, EngineError>;
	readonly file: (
		messageId: string,
		about: { readonly model: string; readonly id: string } | null
	) => Effect.Effect<void, EngineError>;
	readonly mark_read: (id: string, member: string) => Effect.Effect<void, EngineError>;
	/** The active tab wrote back whether it performed a page action: the tool step's durable result. */
	readonly page_result: (messageId: string, result: PageResult) => Effect.Effect<void, EngineError>;
	/** The first tab to claim a page action owns it; every other tab sees false and stays silent. */
	readonly claim_page_action: (messageId: string) => Effect.Effect<boolean, EngineError>;
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
	/** A link's durable status onto the instance row, when it changed. */
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
		SendReceipt,
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
	/** The instance's link connected: what waits for it is due now. */
	readonly resume: (instance: string) => Effect.Effect<void, EngineError>;
	/** Durably correlate an in-flight send before the provider contacts its recipient. */
	readonly reference: (instance: string, reference: OutboundReference) => Effect.Effect<void, EngineError>;
	readonly delivered: (
		instance: string,
		provider_id: string,
		report: DeliveryReport
	) => Effect.Effect<void, EngineError>;
	/** Records the environment's epoch. */
	readonly activate: Effect.Effect<void, EngineError>;
	readonly handlers: { readonly [name: string]: RunHandler };
};
export class Outbound extends Context.Service<Outbound, OutboundShape>()('bolt/Outbound') {}

// ── guest crossings (E4) ──
/** Bytes of a crossing ride `bins`, referenced from `args` as `{ "$bin": n }`. */
type Bins = { readonly bins?: readonly Uint8Array[] | undefined };
/** One facility member's call; E4's `lower()` decodes `args` per member. */
type FacilityArm<T extends string> = { readonly _tag: T; readonly args: readonly Json[] } & Bins;
export type FacilityCall = { [K in FacilityMember]: FacilityArm<K> }[FacilityMember];
/** A guest request to the host, decoded once at the crossing (M2); calls issued before the microtask queue drains cross together. */
export type CrossCall =
	| { readonly _tag: 'run'; readonly automation: string; readonly input: Json }
	| {
			readonly _tag: 'read';
			readonly read: ReadIR;
	  }
	| {
			readonly _tag: 'act';
			readonly acts: ActsRequest['acts'];
			readonly outputs: readonly string[];
			readonly options: { readonly key?: string | undefined };
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
	/** `ctx.approvals.withdraw`: the run's identity takes back a request it asked for. */
	| { readonly _tag: 'withdraw'; readonly request_id: string; readonly reason?: string | undefined }
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
	/** One invocation's events, each written to the host's runtime log as it happens. */
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

