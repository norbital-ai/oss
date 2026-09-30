// The engine contracts (§2.3, §3.3.10 `/engine`, §11.1 P2): the only coupling between the engine areas. Types plus the
// few runtime values every area shares (budgets, `BoltError`, the port-call wrapper, the manifest projection).
//
// Ownership: who implements what is declared here.
//   EngineManifest, engineManifest ....... P1 compiler (A2, C1); consumed by every area
//   TenantDb ............................. PGlite adapter here in bolt (P2); Postgres adapter in bolt-server (P5)
//   Pred, ReadIR, SelectIR, ReadEngine ... query compiler (A4, `engine/query`): Where literal → Pred, Pred → SQL and JS
//   ChangeSet, Change, Captured .......... write compiler (A5, `engine/write`): flattening, the one statement, RETURNING
//   Authority ............................ access (A6, `engine/access`): compiled per (actor, revisions, release), rule 37
//   GuestPort, Bridge, CrossCall ......... guest runtime (A10, `engine/guest`): isolate runner, walls, crossings
//   HostPorts and every *Port ............ host adapters (bolt-server self-host, P5; any other host); the engine only
//                                          calls them, through `callPort` (A10) — `deadlines` is driven by runs (A8),
//                                          `membership`/`secrets`/`tenancy` by identity (§5.11), `ai` by agents (A11)
//   Outcome .............................. write compiler (A5) builds it; protocol (A9) maps it to HTTP (rule 32)
// Bolt never names a host (P18): every port below is generic.
import type { Manifest } from '../compiler/load.ts';
import type { CollectionSpec } from '../decl/collection.ts';
import type { Refused, Unknown } from '../decl/ctx.ts';
import type { ModelSpec } from '../decl/model.ts';
import type { RelationshipSpec } from '../decl/names.ts';
import type { ConvertTarget, FacilityError, GeoHit, WebPage } from '../decl/runtime/facilities.ts';
import type { Json, Offset, Point, Rate } from '../decl/values.ts';
import type { Operand, Shape } from '../decl/where.ts';

// ── budgets (rule 72; §4.9) ──
const MiB = 1024 * 1024;
/** Every wall and cap as one table; each overrun is a typed `BoltError`, never a clamp (rule 9). */
export const LIMITS = {
	guestCpuMs: 2_000, guestMemoryMiB: 256,
	/** Per facility call, never per invocation (X-28). */
	callMs: { database: 60_000, ai: 60_000, tool: 60_000, http: 30_000, web: 30_000, image: 30_000, other: 5_000 },
	crossings: { sync: 40, automation: 10_000 }, readBytes: 32 * MiB, crossingBytes: 4 * MiB, argsBytes: 4 * MiB,
	changeSetBytes: 16 * MiB, changesPerAct: 10_000, expandedRowsPerStatement: 100_000, writeDepth: 8,
	page: { max: 10_000, all: 50_000, allBytes: 8 * MiB, relationArm: 10_000 },
	statement: { shapes: 500, params: 30_000 },
	fileBytes: 4 * MiB, storedFileBytes: 20 * MiB,
} as const;

// ── failures (rule 72a) ──
export type Phase = 'decode' | 'admission' | 'guest' | 'derive' | 'commit' | 'facility' | 'deliver';
const PHASE_SENTENCE: Record<Phase, string> = {
	decode: 'The input could not be decoded.', admission: 'The request was not admitted.', guest: 'Workspace code failed.',
	derive: 'Deriving the write failed.', commit: 'The commit failed.', facility: 'A facility call failed.', deliver: 'Delivery failed.',
};
/** Every engine failure. Construction never throws: a bad message becomes the phase's sentence, so `cause` survives. */
export class BoltError extends Error {
	readonly code: string;
	readonly phase: Phase;
	constructor(code: string, phase: Phase, message: unknown, cause?: unknown) {
		let text: string;
		try {
			text = typeof message === 'string' && message.trim() !== '' ? message : PHASE_SENTENCE[phase];
		} catch {
			text = PHASE_SENTENCE[phase];
		}
		super(text, cause === undefined ? undefined : { cause });
		this.name = 'BoltError';
		this.code = code;
		this.phase = phase;
	}
}
/** What a Postgres adapter throws: the SQLSTATE and constraint the write compiler maps to a refusal (rule 20). */
export class DbError extends Error {
	readonly sqlstate: string;
	readonly constraint: string | undefined;
	constructor(sqlstate: string, message: string, constraint?: string) {
		super(message);
		this.name = 'DbError';
		this.sqlstate = sqlstate;
		this.constraint = constraint;
	}
}

// ── the manifest the engine consumes (C1) ──
type Data = { readonly [key: string]: unknown };
export type PolicyData = {
	description: string; grants: { readonly [collection: string]: Data }; automations?: readonly string[];
	capabilities?: { readonly [kind: string]: readonly string[] }; limits?: { readonly [key: string]: unknown };
};
export type AutomationData = {
	description: string; input?: Data; output?: Data; on?: Data | readonly Data[]; runAs: readonly string[] | 'trigger';
	retry?: { attempts: number; backoff?: string }; concurrency?: { max: number }; agent?: string;
};
export type WorkspaceData = { tz: string; locale: string; currency?: string; env?: Data; ai?: Data; apps?: readonly string[];
	agent?: { triage?: false } }; // hook:triage
/** Pure data: declaration literals by path-derived name, bodies stripped (they run in the guest). */
export type EngineManifest = {
	workspace: WorkspaceData;
	models: { readonly [model: string]: ModelSpec };
	relationships: { readonly [key: string]: RelationshipSpec };
	collections: { readonly [collection: string]: CollectionSpec };
	integrations: { readonly [collection: string]: Data & { direction: 'one_way' | 'two_way' } };
	pipelines: { readonly [collection: string]: Data };
	policies: { readonly [policy: string]: PolicyData };
	teams: { readonly [team: string]: readonly string[] };
	automations: { readonly [automation: string]: AutomationData };
	channels: { readonly [channel: string]: Data };
	connections: { readonly [connection: string]: Data };
	envoys: { readonly [envoy: string]: Data };
	mcp: { readonly [server: string]: Data };
	apps: { readonly [app: string]: Data };
	/** `+group.ts` literals: nav groups of apps. */ // hook:shell
	groups?: { readonly [group: string]: Data };
	customFields: { readonly [field: string]: Data };
	/** `+agent.md`, `+agent.external.md` and skills, as text. */
	agent: { internal?: string; external?: string; skills: { readonly [skill: string]: string } };
};

/** Projects P1's loaded manifest into the engine's: `{ name, spec }` and automation wrappers give their literal. */
export function engineManifest(m: Manifest): EngineManifest {
	const specs = <T>(part: Record<string, unknown>) => Object.fromEntries(Object.entries(part).map(([k, v]) =>
		[k, (v !== null && typeof v === 'object' && 'spec' in v ? v.spec : v) as T]));
	const one = (part: Record<string, unknown>) => part[''];
	return {
		workspace: one(m.workspace) as WorkspaceData,
		models: specs(m.model), relationships: (one(m.relationship) ?? {}) as EngineManifest['relationships'],
		collections: specs(m.collection), integrations: specs(m.integration), pipelines: specs(m.pipeline),
		policies: specs(m.policy), teams: (one(m.team) ?? {}) as EngineManifest['teams'], automations: specs(m.automation),
		channels: specs(m.channel), connections: specs(m.connection), envoys: specs(m.envoy), mcp: specs(m.mcp),
		apps: specs(m.app), groups: specs(m.group), customFields: specs(m.custom_field), // hook:shell (groups)
		agent: { ...(m.agent[''] === undefined ? {} : { internal: m.agent[''] as string }),
			...(m.agent_external[''] === undefined ? {} : { external: m.agent_external[''] as string }), skills: specs(m.skill) },
	};
}

// ── the tenant database (C11 per activation; memory `pod-db-adapters-must-emit-json`) ──
/** One statement with positional parameters (`$1…`); values are JSON (numeric, timestamps and dates as strings). */
export type Sql = { readonly text: string; readonly params: readonly Json[] };
export type Rows = { readonly rows: readonly { readonly [column: string]: Json }[]; readonly affected: number };
/** Taken before the statement, in sorted order; advisory keys are hashed by the adapter (`pg_advisory_xact_lock`). */
export type Lock = { tables?: readonly string[]; mode?: 'SHARE ROW EXCLUSIVE'; advisory?: readonly string[] };
export interface TenantTx {
	query(statement: Sql): Promise<Rows>;
}
/**
 * Every call is one round trip bounded by `LIMITS.callMs.database`; failures throw `DbError`. No connection is held
 * while guest code runs (rule 20): the engine never keeps a transaction open across a crossing.
 */
export interface TenantDb {
	/** Reads, pipelined in one round trip; results in order (rule 12). */
	read(statements: readonly Sql[], signal?: AbortSignal): Promise<readonly Rows[]>;
	/** An act's one write statement: `BEGIN; LOCK …; <statement>; COMMIT` in one round trip (rule 20, 26). */
	write(statement: Sql, lock?: Lock, signal?: AbortSignal): Promise<Rows>;
	/** Several statements atomically: schema apply, seed restore, approval restore (rules 47, 69, 70). */
	transaction<T>(body: (tx: TenantTx) => Promise<T>, lock?: Lock): Promise<T>;
}

// ── the query IR (A4) ──
/** A value position: a literal, or an operand resolved at execution (params, clock, actor, a same-row field). */
export type Arg = { readonly lit: Json } | Operand;
export type Cmp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
/** The normalized `Where` (K3): one evaluator in SQL, one in JS (live routing), equal by a randomized test. */
export type Pred =
	| { t: 'const'; value: boolean }
	| { t: 'and' | 'or'; of: readonly Pred[] }
	| { t: 'not'; of: Pred }
	| { t: 'cmp'; field: string; op: Cmp; arg: Arg }
	| { t: 'like'; field: string; pattern: string }
	| { t: 'in'; field: string; negated: boolean; args: readonly Json[] | Operand }
	| { t: 'null'; field: string; is: boolean }
	| { t: 'list'; field: string; op: 'has' | 'hasAny' | 'hasAll' | 'isEmpty'; arg: Json }
	| { t: 'period'; field: string; op: 'contains' | 'overlaps' | 'within'; arg: Arg }
	| { t: 'geo'; field: string; near?: readonly [Point, number]; within?: Shape }
	/** A one-relation `is`; on a polymorphic ref, one arm (`target`). */
	| { t: 'one'; rel: string; target: string; pred: Pred }
	| { t: 'many'; rel: string; target: string; q: 'some' | 'none' | 'every'; pred: Pred }
	| { t: 'count'; rel: string; target: string; op: Cmp; n: number }
	// hook:query — child aggregates and json containment (P34, §3.3.9)
	| { t: 'agg'; rel: string; target: string; fn: 'sum' | 'min' | 'max' | 'avg'; of: string; op: Cmp; arg: Json }
	| { t: 'json'; field: string; contains: Json }
	| { t: 'json'; field: string; isEmpty: boolean }; // hook:codec — a json list is empty (null counts as empty)
/** Rule 9: a limit or everything, never a default. `after` is bound to the query's AST hash (rule 11). */
export type PageIR = { limit: number; after?: string } | { all: true };
export type Order = readonly { field: string; dir: 'asc' | 'desc' }[];
/** `null` fields = the list's default projection (X-33: no `json`, `custom`, `file` values). */
export type SelectIR = { fields: readonly string[] | null; relations: { readonly [rel: string]: RelSelectIR } };
export type RelSelectIR = { target: string; many: boolean; select: SelectIR; where?: Pred; order?: Order; page?: PageIR };
export type Bucket = { field: string; unit?: 'day' | 'week' | 'month' | 'quarter' | 'year' };
export type ReadIR =
	| { kind: 'read'; collection: string; where?: Pred; select: SelectIR; order?: Order; search?: string; page: PageIR }
	| { kind: 'get'; collection: string; id: string; select: SelectIR }
	| { kind: 'aggregate'; collection: string; where?: Pred; by: readonly Bucket[]; count?: true;
		sum?: readonly string[]; avg?: readonly string[]; min?: readonly string[]; max?: readonly string[]; page?: PageIR }
	/** `where` and `select` are the caller's options (§3.5), beside the probe's own `where`. */
	| { kind: 'similar'; collection: string; similarity: string; input: Json; limit: number; where?: Pred; select?: SelectIR }
	| { kind: 'history'; collection: string; id: string; at?: { instant: string } | { revision: number } | { before: string }; /** `get(c, id, { revision })`: the folded record. */ full?: true }
	/** A collection query: a guest invocation reading as its caller. */
	| { kind: 'query'; collection: string; query: string; input: Json }
	/** The transform's `db.after`: stored rows overlaid with this batch (PH GAP-5). */
	| { kind: 'after'; collection: string; where: Pred }
	/** The in-app agent panel's messages of one conversation in `seq` order; `thread`: a channel thread keeps its ambient rows;
	 * `from`: only messages from that `seq` on (the panel's latest window; older ones are read once, by page). */
	| { kind: 'transcript'; collection: 'sys_message'; conversation: string; thread: boolean; from?: number }
	/** The shell inbox (L-BOLT-354): one member's own notices, newest first. */
	| { kind: 'inbox'; collection: 'sys_notification'; member: string }
	/** The agent panel's conversation list: one member's own in-app conversations, most recently active first. */
	| { kind: 'conversations'; collection: 'sys_conversation'; member: string };
/** What operands resolve against, fixed per invocation (rule 26: a replay keeps `now` and `today`). */
export type Bindings = { now: string; today: string; tz: string; params: { readonly [name: string]: Json } };
/** Who reads (rule 15): a caller's Authority (scoped, masked), or the workspace (the transform: unscoped). */
export type Reader = { as: 'caller'; authority: Authority } | { as: 'workspace' };
export interface ReadEngine {
	/** One batch = one crossing and one pipelined round trip; answers in order. Relative operands (`Offset`) resolve here. */
	run(batch: readonly ReadIR[], reader: Reader, bindings: Bindings): Promise<readonly Json[]>;
}

// ── the ChangeSet: everything one act's statement writes besides the engine's bookkeeping (A5) ──
/** A row's stored values in wire form (tagged JSON: `$dec`, `$t`, `$d`). */
export type RowData = { readonly [field: string]: Json };
/** Where a change came from in the caller's input, for `refused { field, row }` (rule 32). */
export type InputPath = readonly (string | number)[];
/** One write per row (rule 21); relation actions are already flattened (`link`/`unlink` are FK updates). */
export type Change = { collection: string; id: string; path: InputPath } & (
	| { op: 'create'; values: RowData }
	| { op: 'upsert'; values: RowData; on: readonly string[]; onConflict: 'update' | 'keep' }
	/** `revision` is the one the caller observed (rule 25); `null` writes blind. */
	| { op: 'update'; set: RowData; revision: number | null }
	| { op: 'delete'; revision: number | null });
export type QueuedRun = { automation: string; input: Json; dueAt: string; key?: string; cause: string; depth: number };
export type NoticeRow = { to: Json; title: string; body?: string; link?: { collection: string; id: string }; once?: string };
export type OutboxRow = { channel: string; message: Json; record?: { collection: string; id: string } };
/** ≤ `LIMITS.changesPerAct` changes and `LIMITS.changeSetBytes` encoded; over either is a typed refusal, never a split. */
export type ChangeSet = { changes: readonly Change[]; runs: readonly QueuedRun[]; notices: readonly NoticeRow[]; outbox: readonly OutboxRow[] };
/** One committed row change from `RETURNING old.*, new.*`: the input of triggers (rule 50) and live routing (A9). */
export type Captured = { collection: string; id: string; op: 'create' | 'update' | 'delete'; revision: number;
	old: RowData | null; new: RowData | null; cause: 'direct' | 'cascade' | 'derived' };

// ── outcomes (rule 32): the author types of decl/ctx with names erased ──
export type Written = readonly { collection: string; id: string; revision: number }[];
export type Outcome = { kind: 'committed'; output: Json; records: Written } | { kind: 'pendingApproval'; requestId: string; records: Written } | Refused
	| { kind: 'conflict'; records: readonly { collection: string; id: string; fields: readonly string[] }[] } | Unknown;

// ── actors and authority (A6) ──
/** The decl `Actor` with names erased: one engine serves any workspace. */
export type MemberActor = { kind: 'member'; id: string; email: string | null; phone: string | null; external: boolean; teams: readonly string[]; teamPath: readonly string[];
	admin: boolean; party: { collection: string; id: string } | null };
export type EngineActor =
	| MemberActor
	/** hook:envoys — P32: `member` names the linked sender (either audience); `linked` is set on a DM, whose authority joins the envoy's, and scopes `actor` operands. */
	| { kind: 'envoy'; envoy: string; channel: string; sender: string; member: string | null; linked?: MemberActor }
	| { kind: 'visitor'; app: string; visitor: string }
	| { kind: 'apiKey'; key: string }
	| { kind: 'system'; run: string; by: { automation: string } | { integration: string } | { platform: string } };
export type ApprovalRoute = { match?: Data; steps: readonly (readonly string[])[]; superceded_by?: readonly string[] };
/** One grant arm; arms of every held policy union (rule 35). `fields: 'all'` = no field narrowing. */
export type Arm = { policy: string; where: Pred; fields: readonly string[] | 'all' };
export type WriteArm = Arm & { previous?: Pred; approval: readonly ApprovalRoute[] };
export type CollectionAuthority = {
	read: readonly Arm[]; history: readonly Arm[]; create: readonly WriteArm[]; update: readonly WriteArm[]; delete: readonly WriteArm[];
	queries: readonly string[]; actions: readonly string[];
	moves: { readonly [stateField: string]: 'all' | readonly string[] };
	/** Field → the predicate of the arms that admit it (rule 14); absent = unmasked for this caller. */
	masks: { readonly [field: string]: Pred };
};
export type LimitRule = { key: string; rate: Rate; per: 'actor' | 'ip' | 'sender' | 'subject' };
/** Compiled once per `key` = (actor, assignment revision, team-graph revision, release) (rule 37). */
export type Authority = {
	key: string; actor: EngineActor; admin: boolean; policies: readonly string[];
	collections: { readonly [collection: string]: CollectionAuthority };
	automations: readonly string[];
	capabilities: { apps: readonly string[]; tools: readonly string[]; mcp: readonly string[]; skills: readonly string[] };
	limits: readonly LimitRule[];
	/** Operand values: `actor.teamTree`, `actor.scopes('<policy>')`. */
	teamTree: readonly string[]; scopes: { readonly [policy: string]: readonly string[] };
};

// ── the guest (C2, A10) ──
export type InvocationKind = 'transform' | 'query' | 'action' | 'similarity' | 'rerank' | 'automation' | 'mapping' | 'validation' | 'tool'; // hook:reads (rerank)
/** One fresh-isolate run of one body. `target` names it: `'<c>'` (transform), `'<c>.<query|action|similarity>'`, `'<a>'`. */
export type Invocation = {
	id: string; kind: InvocationKind; target: string; input: Json;
	ctx: { actor: EngineActor; now: string; today: string; tz: string; seed: string;
		/** transform: stored root rows per input (`null` on a create); record action: its row. */
		existing?: readonly (RowData | null)[]; row?: RowData };
	budget: { cpuMs: number; crossings: number; readBytes: number };
};
/** A guest request to the host. Calls issued before the microtask queue drains cross together (rule 12). */
export type CrossCall =
	| { op: 'read'; read: ReadIR; params: { readonly [name: string]: Json } }
	| { op: 'act'; callable: string; input: Json; options?: { key?: string; once?: string; onConflict?: 'update' | 'keep' } } // hook:ctx-types (onConflict, rule 28)
	| { op: 'schedule'; automation: string; input: Json; at?: string | { now: Offset }; key?: string }
	| { op: 'notify'; notices: Json }
	| { op: 'send'; channel: string; message: Json }
	/** `ctx.progress` (automations only): onto the run's row; answers `stopped` once the run was stopped. */ // hook:runtime
	| { op: 'progress'; progress: Json }
	/** `ai.sys_2.infer`, `http(conn).post`, `convert.document`, … Bytes ride `bins`, referenced as `{ "$bin": n }` (§5.8.1). */
	| { op: 'facility'; facility: 'http' | 'web' | 'files' | 'ai' | 'geo' | 'convert'; method: string; args: readonly Json[]; bins?: readonly Uint8Array[] };
export type CrossAnswer = ({ ok: true; value: Json; bins?: readonly Uint8Array[] }
	| { ok: false; error: FacilityError | { kind: 'refused'; code: string; message: string } | { kind: 'bolt'; code: string; message: string } })
	& { /** hook:runner — a journal hit (rule 55): costs no crossing (rule 12). */ journal?: true };
/**
 * The host half of a crossing. Inside an action, `act`/`schedule`/`notify` are recorded into the act's ChangeSet;
 * inside an automation each is its own journalled statement (rule 55). The bridge counts crossings and read bytes.
 */
export interface Bridge {
	cross(calls: readonly CrossCall[], signal: AbortSignal): Promise<readonly CrossAnswer[]>;
}
export type GuestOutcome =
	| { kind: 'ok'; output: Json; cpuMs: number }
	/** `ctx.refuse(message, { field })`. */
	| { kind: 'refused'; message: string; field?: string; cpuMs: number }
	/** A throw, a budget (`cpuBudget`, `crossingBudget`, `readBudgetExceeded`, `memory`) or a bad answer. */
	| { kind: 'failed'; error: BoltError; cpuMs: number };
export interface GuestPort {
	invoke(invocation: Invocation, bridge: Bridge): Promise<GuestOutcome>;
}

// ── host ports (§3.3.10 `/engine` types; P18, P19): optional ports are absent when the host lacks the provider ──
/** A stored blob; the `sys_file` row is the engine's (rule 18). */
export type Blob = { key: string; bytes: number; sha256: string; mime: string };
export interface FilesPort {
	put(bytes: Uint8Array, meta: { name: string; mime: string }, signal: AbortSignal): Promise<Blob>;
	/** At most `max` bytes; more is `invalid`, never a truncation. */
	get(key: string, max: number, signal: AbortSignal): Promise<Uint8Array>;
	url(key: string, expiresInS: number, signal: AbortSignal): Promise<string>;
	remove(key: string, signal: AbortSignal): Promise<void>;
}
/** Every conversion target, in the order hosts report them. */
export const CONVERT_TARGETS: readonly ConvertTarget[] = ['pdf', 'docx', 'pptx', 'odt', 'epub', 'html'];
/**
 * The document converter behind `ctx.convert.document` (optional; absent → `unavailable`). `targets` is what this host
 * serves, checked at start against `workspace.convert.to`. `reference` is the bytes of a styling document (docx, pptx, odt).
 */
export interface ConvertPort {
	readonly targets: readonly ConvertTarget[];
	convert(source: { markdown: string } | { html: string }, to: ConvertTarget,
		options: { reference?: Uint8Array; page?: 'A4' | 'A3' | 'Letter'; landscape?: boolean }, signal: AbortSignal): Promise<Uint8Array>;
}
export interface SecretsPort {
	get(name: string, signal: AbortSignal): Promise<string | null>;
	set(name: string, value: string, signal: AbortSignal): Promise<void>;
	remove(name: string, signal: AbortSignal): Promise<void>;
}
export type AiMessage = { role: 'user' | 'assistant' | 'tool'; content: Json };
export type AiRequest = { model: string; system?: string; messages: readonly AiMessage[]; tools?: readonly { name: string; description: string; input: Json }[];
	output?: Json; files?: readonly { mime: string; bytes: Uint8Array }[]; continuation?: string };
/** `cut`: the 60 s wall ended a stream; `continuation` resumes it as the next step (rule 63). */
export type AiResponse = { content: Json; toolCalls: readonly { id: string; name: string; input: Json; /** why the arguments did not parse; the call is answered with it, not run */ invalid?: string }[];
	finish: 'stop' | 'tool' | 'cut'; continuation?: string;
	/** L-BOLT-412: the provider's reasoning, verbatim, stored beside the text and sent back with it. */ reasoning?: string;
	usage: { input: number; output: number; /** hook:agent — USD, for the cost disclosure */ cost?: number; /** L-BOLT-432: the provider's call id (the metering key) */ call?: string } };
/** hook:runtime — one embedding input: text, or a stored file's bytes (an image; embed models are multimodal). */
export type EmbedInput = string | { readonly $file: { readonly name: string; readonly mime: string; readonly sha256: string; readonly bytes: Uint8Array } };
/** One model a person may pick (the panel lists `label`, grouped by `provider`); `context` is its window in tokens. */
export type AiModel = { id: string; label: string; provider?: string; context?: number };
export interface EmbeddingsPort {
	/** `dimensions`: the vector length the caller stores (a model that truncates, Matryoshka-style, answers at it). */
	embed(inputs: readonly EmbedInput[], model: string, signal: AbortSignal, dimensions?: number): Promise<readonly (readonly number[])[]>;
}
/**
 * The AI facility (P35, P39): `sys_1` (fast structured decisions, text only) and `sys_2` (the LLM, multimodal) are both
 * required when the port is bound; `embed` (multimodal) is present when the host maps an embedding model. The host
 * verifies at activation that every `sys_2` and `embed` model takes images; nothing here branches on modality.
 */
export interface AiPort {
	sys_1: import('./decisions/index.ts').System1Port;
	sys_2: {
		/** The model classes the host maps (`default fast strong`). */
		models: readonly string[];
		/**
		 * The concrete models a person may pick for a conversation and the id a new one starts on (the host's own selection,
		 * cached as it likes; it answers even offline). `infer` takes any of their ids as `model`, beside the classes.
		 */
		catalog?(): Promise<{ models: readonly AiModel[]; default: string }>;
		/** `onDelta` streams text as it arrives; on the wall the agent keeps it as a cut step (rule 63). */
		/** `onProgress`: the stream produced something that is not text (a tool call's arguments, or `reasoning` as it arrives). */
		infer(request: AiRequest, signal: AbortSignal, onDelta?: (text: string) => void, onProgress?: (reasoning?: string) => void): Promise<AiResponse>;
	};
	embed?: EmbeddingsPort['embed'];
}
export interface GeocoderPort {
	search(query: string, signal: AbortSignal): Promise<readonly GeoHit[]>;
	reverse(point: Point, signal: AbortSignal): Promise<GeoHit | null>;
}
export interface WebReadPort {
	/** Refuses private, loopback and link-local addresses. */
	/** `raw`: also the markup and its links, for a page that is markup (§5.8; P19: a provider may omit what it lacks). */ // hook:runtime
	read(url: string, signal: AbortSignal, options?: { raw?: boolean }): Promise<WebPage>;
}
/** What a transport hands the engine: an inbound message or a delivery event on a sent one. */
export type TransportEvent = { kind: 'inbound'; channel: string; message: Json; bins?: readonly Uint8Array[] }
	| { kind: 'delivery'; channel: string; providerId: string; event: string; at: string; data?: Json };
/** Mail, WhatsApp (a persistent socket the adapter owns), Telegram, web push. */
export interface TransportPort {
	send(channel: string, message: Json, signal: AbortSignal): Promise<{ providerId: string }>;
	/** The platform's typing indicator in the chat `to` (WhatsApp "typing…", a Telegram typing action), best effort: an agent at work shows it. */
	typing?(channel: string, to: string, signal: AbortSignal): Promise<void>;
	/** The adapter calls `sink` for every event; returns the unsubscribe. A sink rejection is a redelivery. */
	subscribe(sink: (event: TransportEvent) => Promise<void>): () => void;
}
export interface MeteringPort {
	record(meter: string, quantity: number, key: string): Promise<void>;
}
export interface TenancyPort {
	/** The environment scope a request's host name addresses, or `null`. */
	resolve(host: string): Promise<string | null>;
}
export interface MembershipPort {
	/** `email`, `phone` and `team` are null for an erased member (rule 38e(e)); `team` is the `sys_team` id. */
	project(member: { user: string; email: string | null; phone: string | null; team: string | null; state: 'active' | 'inactive' | 'erased' }, signal: AbortSignal): Promise<void>;
}
/** One next-due instant per scope, held in host memory; no polling (rule 52a). */
export interface DeadlinesPort {
	announce(scope: string, notLaterThan: string): void;
	settle(scope: string, nextDue: string | null): void;
	teardown(scope: string): void;
}
export type DatabasePort = TenantDb;
export type HostPorts = {
	database: DatabasePort; files: FilesPort; deadlines: DeadlinesPort;
	secrets?: SecretsPort; convert?: ConvertPort; ai?: AiPort; geocoder?: GeocoderPort;
	web?: WebReadPort; transports?: { readonly email?: TransportPort; readonly whatsapp?: TransportPort; readonly telegram?: TransportPort; readonly push?: TransportPort };
	metering?: MeteringPort; tenancy?: TenancyPort; membership?: MembershipPort;
};

/**
 * Calls a port under its wall (L-BOLT-288, 289): a missing port is `unavailable`, a throw or rejection `upstream`, the
 * wall `timeout`; a bad answer is the caller's check (`valid`). Never throws.
 */
export async function callPort<P, R>(facility: string, port: P | undefined, wallMs: number,
	call: (port: P, signal: AbortSignal) => Promise<R>, valid: (r: unknown) => r is R = (r): r is R => true): Promise<R | FacilityError> {
	if (port === undefined) return { kind: 'unavailable', facility, reason: `the host provides no ${facility}` };
	const signal = AbortSignal.timeout(wallMs);
	try {
		const result = await new Promise<R>((resolve, reject) => {
			signal.addEventListener('abort', () => reject(signal.reason), { once: true });
			Promise.resolve().then(() => call(port, signal)).then(resolve, reject);
		});
		return valid(result) ? result : { kind: 'upstream', message: `${facility} answered something that is not its result` };
	} catch (e) {
		if (signal.aborted) return { kind: 'timeout', message: `${facility} did not answer within ${wallMs} ms` };
		return { kind: 'upstream', message: e instanceof Error && e.message !== '' ? e.message : `${facility} failed` };
	}
}
