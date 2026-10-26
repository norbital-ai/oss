// The engine contracts (§2.3, §3.3.10 `/engine`, §11.1 P2): the only coupling between the engine areas. Types plus the
// few runtime values every area shares (budgets, the port-call wrapper, the manifest projection); failures are `errors.ts`.
//
// Ownership: who implements what is declared here.
//   EngineManifest, engineManifest ....... P1 compiler (A2, C1); consumed by every area
//   TenantDb ............................. adapters in `node/db` (PGlite, Postgres); a cell reads the host's `HostTenantDb`
//   Pred, ReadIR, SelectIR, ReadEngine ... query compiler (A4, `engine/query`): Where literal → Pred, Pred → SQL and JS
//   Change, Captured ..................... write compiler (A5, `engine/write`): flattening, the one statement, RETURNING
//   Authority ............................ access (A6, `engine/access`): compiled per (actor, revisions, release), rule 37
//   GuestPort, Bridge, CrossCall ......... guest runtime (A10, `engine/guest`): isolate runner, walls, crossings
//   HostPorts and every *Port ............ host adapters (bolt-server self-host, P5; any other host); the engine only
//                                          calls them through native port services — deadlines are driven by runs,
//                                          `membership`/`secrets`/`tenancy` by identity (§5.11), `ai` by agents (A11)
//   Outcome .............................. write compiler (A5) builds it; protocol (A9) maps it to HTTP (rule 32)
// Bolt never names a host (P18): every port below is generic.
import type { Refused, Unknown } from '../decl/ctx.ts';
import type { DeliveryReport } from './conversations/status.ts';
import type { BoltError } from '../protocol/errors.ts';
import type { FacilityFailure, Unavailable } from '../decl/errors.ts';
import type {
	ConvertTarget,
	GeoHit,
	RunCause,
	SpeechFormat,
	TranscribeOptions,
	Transcript,
	WebPage
} from '../decl/runtime/facilities.ts';
import type { Json, Point, Rate } from '../decl/values.ts';
import type { Pred } from '@norbital-ai/store';
import type { GuestProgram } from './guest/runner.ts';

/** The precise facility failure sent across the guest ABI; interior failures remain tagged errors. */
export type FacilityError =
	| (Pick<FacilityFailure, 'kind' | 'message'> & { readonly status?: number | undefined })
	| ({ readonly kind: 'unavailable' } & Pick<Unavailable, 'facility' | 'reason'>);

// ── budgets (rule 72; §4.9) ──
const MiB = 1024 * 1024;
/** Every wall and cap as one table; each overrun is a typed `BoltError`, never a clamp (rule 9). */
export const LIMITS = {
	guestCpuMs: 2_000,
	guestMemoryMiB: 256,
	/**
	 * Per I/O response, never per invocation (X-28). Streaming model responses reset their idle deadline on progress;
	 * a multi-step inference keeps its separate whole-call ceiling. Speech's current ABI returns one response.
	 */
	callMs: {
		database: 20_000,
		ai: 20_000,
		tool: 20_000,
		http: 20_000,
		web: 20_000,
		image: 20_000,
		other: 20_000,
		speech: 20_000,
		attachment: 20_000
	},
	/** Read crossings per invocation: `write` for one write-callback call (`create.transform`, `update.transform`,
	 * `delete.check`: read for the whole batch, never per row), `sync` for every other synchronous body. */
	crossings: { sync: 40, write: 2, automation: 10_000 },
	/** Rows per write-callback invocation: a batch of N rows is ⌈N/1000⌉ calls per verb per model, one 2 s budget each. */
	writeChunk: 1_000,
	readBytes: 32 * MiB,
	/** Coalesced native reads retained between an automation's successful read and its next act. */
	readGuards: { count: 256, bytes: 4 * MiB },
	crossingBytes: 4 * MiB,
	argsBytes: 4 * MiB,
	changeSetBytes: 16 * MiB,
	changesPerAct: 10_000,
	expandedRowsPerStatement: 100_000,
	writeDepth: 8,
	page: { max: 10_000, all: 50_000, allBytes: 8 * MiB, relationArm: 10_000 },
	statement: { shapes: 500, params: 30_000 },
	fileBytes: 4 * MiB,
	storedFileBytes: 20 * MiB,
	/** An outbound conversation message's attachments together, read for its provider; more refuses the message (permanent). */
	messageAttachmentBytes: 20 * MiB
} as const;

// ── the tenant database (C11 per activation) ──
/** One statement with positional parameters (`$1…`); values are JSON (numeric, timestamps and dates as strings). */
export type Sql = { readonly text: string; readonly params: readonly Json[] };
export type Rows = {
	readonly rows: readonly { readonly [column: string]: Json }[];
	readonly affected: number;
};
/** Taken before the statement, in sorted order; advisory keys are hashed by the adapter (`pg_advisory_xact_lock`). */
export type Lock = {
	tables?: readonly string[];
	mode?: 'SHARE ROW EXCLUSIVE';
	advisory?: readonly string[];
};
/** What operands resolve against, fixed per invocation (rule 26: a replay keeps `now` and `today`). */
export type Bindings = {
	now: string;
	today: string;
	tz: string;
	params: { readonly [name: string]: Json };
};
/** Who reads (rule 15): a caller's Authority (scoped, masked), or the workspace (the transform: unscoped). */
export type Reader = { as: 'caller'; authority: Authority } | { as: 'workspace' };
// ── changes: everything one act's statement writes besides the engine's bookkeeping (A5) ──
/** A row's stored values in wire form: `$dec` preserves decimal scale; dates and instants are ISO strings. */
export type RowData = { readonly [field: string]: Json };
/** Where a change came from in the caller's input, for `refused { field, row }` (rule 32). */
export type InputPath = readonly (string | number)[];
/** One write per row (rule 21); relation actions are already flattened (`link`/`unlink` are FK updates). */
export type Change = { collection: string; id: string; path: InputPath } & (
	| { op: 'create'; values: RowData }
	| { op: 'upsert'; values: RowData; on: readonly string[]; onConflict: 'update' | 'keep' }
	/** `revision` is the one the caller observed (rule 25); `null` writes blind. */
	| { op: 'update'; set: RowData; revision: number | null }
	| { op: 'delete'; revision: number | null }
);
export type QueuedRun = {
	automation: string;
	input: Json;
	dueAt: string;
	key?: string;
	id?: string;
	actor?: string;
	starter?: Json;
	cause: string;
	depth: number;
};
export type NoticeRow = Omit<import('./notifications/notify.ts').NoticeInsert, 'id'>;
/** One committed row change from `RETURNING old.*, new.*`: the input of triggers (rule 50) and live routing (A9). */
export type Captured = {
	collection: string;
	id: string;
	op: 'create' | 'update' | 'delete';
	revision: number;
	old: RowData | null;
	new: RowData | null;
	cause: 'direct' | 'cascade' | 'derived' | 'erased';
};

// ── outcomes (rule 32): the author types of decl/ctx with names erased; a write's own `Outcome` is never `running` ──
export type Written = readonly { collection: string; id: string; revision: number }[];
export type Outcome =
	| { kind: 'committed'; output: Json; records: Written }
	| { kind: 'pendingApproval'; requestId: string; records: Written }
	| Refused
	| {
			kind: 'conflict';
			records: readonly { collection: string; id: string; fields: readonly string[] }[];
	  }
	| Unknown;
/** Past the person-wait the write continues in the background as run `run`; its row reports the outcome (`Running`). */
export type Running = { kind: 'running'; run: string };
/** What an act answers its caller: the write's outcome, or `running` once it outlives the person-wait. */
export type ActOutcome = Outcome | Running;

// ── actors and authority (A6) ──
/** The decl `Actor` with names erased: one engine serves any workspace. */
export type MemberActor = {
	kind: 'member';
	id: string;
	email: string | null;
	phone: string | null;
	external: boolean;
	teams: readonly string[];
	teamPath: readonly string[];
	admin: boolean;
	party: { collection: string; id: string } | null;
};
export type EngineActor =
	| MemberActor
	/**
	 * hook:envoys — P32: the envoy's turn on `instance` (the `sys_integration` row it arrived on, `{ actor: 'instance' }`);
	 * `member` names the linked sender (either audience); `linked` is set on a linked member's DM and binds `actor` operands.
	 */
	| {
			kind: 'envoy';
			envoy: string;
			instance: string;
			sender: string;
			member: string | null;
			linked?: MemberActor;
	  }
	| { kind: 'visitor'; app: string; visitor: string }
	| { kind: 'apiKey'; key: string }
	/** An automation's or platform run's work, or a remote sync's read page for the instance it runs for (`'<model>.sync.<sync>'`). */
	| {
			kind: 'system';
			run: string;
			by: { automation: string } | { platform: string } | { sync: string; instance: string };
	  };
/** One grant arm; arms of every held policy union (rule 35). `fields: 'all'` = no field narrowing. */
export type Arm = { policy: string; where: Pred; fields: readonly string[] | 'all' };
/**
 * A write arm; `approval`: the arm admits subject to its policy's approval callback (spec §8). Among the admitting arms
 * one without `approval` executes directly; else the first with `approval`, in policy order, runs its callback.
 */
export type WriteArm = Arm & { previous?: Pred; approval?: true };
export type CollectionAuthority = {
	read: readonly Arm[];
	history: readonly Arm[];
	create: readonly WriteArm[];
	update: readonly WriteArm[];
	delete: readonly WriteArm[];
	queries: readonly string[];
	moves: { readonly [stateField: string]: 'all' | readonly string[] };
	/** Field → the predicate of the arms that admit it (rule 14); absent = unmasked for this caller. */
	masks: { readonly [field: string]: Pred };
};
export type LimitRule = { key: string; rate: Rate; per: 'actor' | 'ip' | 'sender' | 'subject' };
/** Compiled once per `key` = (actor, affiliation revision, source release) (rule 37). */
export type Authority = {
	key: string;
	actor: EngineActor;
	admin: boolean;
	policies: readonly string[];
	/** Trusted admin preview context, rechecked before an approval decision or proposal replay. */
	preview?: { by: string; team: string | null };
	/** Set when compiled for a kiosk's requests: the kiosk whose assigned policies this reads and writes as. */
	kiosk?: string;
	/**
	 * Set from a session minted for the agent's browser (`session.mint`'s `agent`): every request made with it is the
	 * agent's, acting for this authority's own member in `conversation`. A host holds live-changing work from it.
	 */
	agent?: { readonly conversation: string };
	collections: { readonly [collection: string]: CollectionAuthority };
	automations: readonly string[];
	capabilities: {
		apps: readonly string[];
		kiosks?: readonly string[];
		tools: readonly string[];
		mcp: readonly string[];
		skills: readonly string[];
	};
	limits: readonly LimitRule[];
	/** Operand values: `actor.teamTree`, `actor.scopes('<policy>')`. */
	teamTree: readonly string[];
	scopes: { readonly [policy: string]: readonly string[] };
};

// ── the guest (C2, A10) ──
export type InvocationKind =
	| 'create'
	| 'update'
	| 'delete'
	| 'query'
	| 'notify'
	| 'vector'
	| 'probe'
	| 'rerank'
	| 'syncRead'
	| 'syncWrite'
	| 'parse'
	| 'approval'
	| 'automation'
	| 'integration'
	| 'page'
	| 'validation'
	| 'tool';
/**
 * One fresh-isolate run of one body. `target` names it: `'<model>'` (write callbacks `create`/`update`/`delete`,
 * `notify`), `'<model>.<query>'`, `'<model>.<index>'` (`vector`, `probe`, `rerank`), `'<model>.<sync>'`
 * (`syncRead`, `syncWrite`), `'<model>.<sync>.<media type>'` (`parse`), `'<policy>.<model>.<op>'` (`approval`), `'<a>'`
 * (automation), or `'<app>/<page>'` (page).
 */
export type Invocation = {
	id: string;
	/** The `sys_run` an automation attempt belongs to: its events (console lines among them) carry it. */
	run?: string;
	kind: InvocationKind;
	target: string;
	input: Json;
	ctx: {
		actor: EngineActor;
		now: string;
		today: string;
		tz: string;
		seed: string;
		cause?: RunCause;
		admin?: boolean;
		policies?: readonly string[];
		/** A sync body's or integration test's instance and configuration; `key` a sync write's `Idempotency-Key`. */
		instance?: string;
		key?: string;
		configuration?: Json;
		/** Only the member's file-sync export writer may read bytes and derive images. */
		fileExport?: true;
	};
	budget: { crossings: number; readBytes: number };
};
export type CrossAnswer = (
	| { ok: true; value: Json; bins?: readonly Uint8Array[] }
	| {
			ok: false;
			error:
				| FacilityError
				| { kind: 'refused'; code: string; message: string }
				| { kind: 'bolt'; code: string; message: string };
	  }
) & { /** hook:runner — a journal hit (rule 55): costs no crossing (rule 12). */ journal?: true };
export type GuestOutcome =
	| { kind: 'ok'; output: Json }
	/** `ctx.refuse(message, { field, row })`; `row` indexes the batch a write callback received. */
	| {
			kind: 'refused';
			message: string;
			code?: string;
			field?: string;
			row?: number;
			rows?: readonly number[];
			rule?: string;
			data?: { readonly requestId: string };
			records?: readonly {
				readonly collection: string;
				readonly id: string;
				readonly fields: readonly string[];
			}[];
			invocation?: string;
	  }
	/** A throw, a budget (`cpuBudget`, `crossingBudget`, `readBudgetExceeded`, `memory`) or a bad answer. */
	| { kind: 'failed'; error: BoltError };
// ── host ports (§3.3.10 `/engine` types; P18, P19): optional ports are absent when the host lacks the provider ──
/** A stored blob; the `sys_file` row is the engine's (rule 18). */
export type Blob = { key: string; bytes: number; sha256: string; mime: string };
/** A media file the host fetched for a tool: classified by its bytes, stored, never run. */
export type Downloaded = Blob & { name: string };
export interface FilesPort {
	put(bytes: Uint8Array, meta: { name: string; mime: string }, signal: AbortSignal): Promise<Blob>;
	/** At most `max` bytes; more is `invalid`, never a truncation. */
	get(key: string, max: number, signal: AbortSignal): Promise<Uint8Array>;
	url(key: string, expiresInS: number, signal: AbortSignal): Promise<string>;
	remove(key: string, signal: AbortSignal): Promise<void>;
	/**
	 * Fetches a public http(s) URL under the host's egress policy (every redirect hop re-checked, at most 5) and stores
	 * its body if its first bytes are media (image, audio, video, PDF); anything else is refused, never stored. The host
	 * streams it (at most 100 MiB, 20 s without bytes ends it) and names it from the response or the URL.
	 */
	download(url: string, signal: AbortSignal): Promise<Downloaded>;
}
/** Each conversion target's media type. */
export const CONVERT_MIME: Record<ConvertTarget, string> = {
	pdf: 'application/pdf',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	odt: 'application/vnd.oasis.opendocument.text',
	epub: 'application/epub+zip',
	html: 'text/html'
};
/** Every conversion target, in the order hosts report them. */
export const CONVERT_TARGETS: readonly ConvertTarget[] = [
	'pdf',
	'docx',
	'pptx',
	'odt',
	'epub',
	'html'
];
/**
 * The document converter behind `ctx.convert.document` (optional; absent → `unavailable`). `targets` is what this host
 * serves, checked at start against `workspace.convert.to`. `reference` is the bytes of a styling document (docx, pptx, odt).
 */
export interface ConvertPort {
	readonly targets: readonly ConvertTarget[];
	convert(
		source: { markdown: string } | { html: string },
		to: ConvertTarget,
		options: { reference?: Uint8Array; page?: 'A4' | 'A3' | 'Letter'; landscape?: boolean },
		signal: AbortSignal
	): Promise<Uint8Array>;
}
/**
 * Speech behind `ctx.ai.transcribe` and `ctx.ai.speak` (optional; each member absent → `unavailable`). `transcribe` gets a
 * stored file's bytes and answers segments in seconds from the audio's start, speaker labels `S1`, `S2`, … consistent across
 * the file; `speak` answers the audio in `format`. A throw carrying a FacilityError `kind` (`rateLimited`, `tooLarge`,
 * `invalid`, `unsupported`, `timeout`) is answered as that kind; any other throw is `upstream`.
 */
export interface SpeechPort {
	transcribe?(
		audio: { name: string; mime: string; bytes: Uint8Array },
		options: TranscribeOptions,
		signal: AbortSignal
	): Promise<Transcript>;
	speak?(
		text: string,
		options: { voice?: string; format: SpeechFormat; language?: string },
		signal: AbortSignal
	): Promise<{ bytes: Uint8Array; mime: string }>;
}
export interface SecretsPort {
	get(name: string, signal: AbortSignal): Promise<string | null>;
	set(name: string, value: string, signal: AbortSignal): Promise<void>;
	remove(name: string, signal: AbortSignal): Promise<void>;
}
export type AiMessage = { role: 'user' | 'assistant' | 'tool'; content: Json };
export type AiRequest = {
	model: string;
	system?: string;
	messages: readonly AiMessage[];
	tools?: readonly { name: string; description: string; input: Json }[];
	output?: Json;
	files?: readonly { mime: string; bytes: Uint8Array }[];
	continuation?: string;
};
/** `cut`: the 60 s wall ended a stream; `continuation` resumes it as the next step (rule 63). */
export type AiResponse = {
	content: Json;
	toolCalls: readonly {
		id: string;
		name: string;
		input: Json;
		/** why the arguments did not parse; the call is answered with it, not run */ invalid?: string;
	}[];
	finish: 'stop' | 'tool' | 'cut';
	continuation?: string;
	/** L-BOLT-412: the provider's reasoning, verbatim, stored beside the text and sent back with it. */ reasoning?: string;
	usage: {
		input: number;
		output: number;
		/** hook:agent — USD, for the cost disclosure */ cost?: number;
		/** L-BOLT-432: the provider's call id (the metering key) */ call?: string;
	};
};
/** hook:runtime — bytes supplied by a host, or an engine-resolved stored file read by the provider outside the Cell. */
export type EmbedInput =
	| string
	| {
			readonly $file: {
				readonly name: string;
				readonly mime: string;
				readonly sha256: string;
				readonly bytes: Uint8Array;
			};
	  }
	| {
			readonly $stored: {
				readonly key: string;
				readonly name: string;
				readonly mime: string;
				readonly sha256: string;
				readonly bytes: number;
			};
	  };
/** One model a person may pick (the panel lists `label`, grouped by `provider`); `context` is its window in tokens. */
export type AiModel = { id: string; label: string; provider?: string; context?: number };
export interface EmbeddingsPort {
	/** `dimensions`: the vector length the caller stores (a model that truncates, Matryoshka-style, answers at it). */
	embed(
		inputs: readonly EmbedInput[],
		model: string,
		signal: AbortSignal,
		dimensions?: number
	): Promise<readonly (readonly number[])[]>;
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
		infer(
			request: AiRequest,
			signal: AbortSignal,
			onDelta?: (text: string) => void,
			onProgress?: (reasoning?: string) => void
		): Promise<AiResponse>;
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
/** Where `navigate` goes: a page, or back, forward or a reload of the one open. */
export type BrowserTarget =
	{ readonly url: string } | { readonly go: 'back' | 'forward' | 'reload' };
/** One `browser_act` step, on a control's `ref` from the page text. */
export type BrowserStep =
	| { readonly click: string }
	| { readonly type: { readonly ref: string; readonly text: string; readonly submit?: boolean } }
	| { readonly select: { readonly ref: string; readonly value: string } }
	| { readonly press: string }
	| { readonly hover: string }
	| { readonly scroll: { readonly ref?: string; readonly y?: number } }
	| { readonly wait: { readonly text?: string; readonly ms?: number } };
/**
 * The browsing facility the built-in `browser_*` tools drive. Each `profile` is one browser of its own, its sign-ins and
 * site data kept between calls: a person's id, or `BROWSER_RUN_PROFILE` + `<run id>:<inference id>` for one inference of a run.
 * Pages answer as text with a ref on every control; a PDF answers its extracted text, page by page.
 */
export interface BrowserPort {
	navigate(
		profile: string,
		to: BrowserTarget,
		find: string | undefined,
		signal: AbortSignal
	): Promise<Json>;
	snapshot(
		profile: string,
		options: { find?: string; from?: number },
		signal: AbortSignal
	): Promise<Json>;
	act(profile: string, steps: readonly BrowserStep[], signal: AbortSignal): Promise<Json>;
	evaluate(profile: string, expression: string, signal: AbortSignal): Promise<Json>;
	screenshot(profile: string, signal: AbortSignal): Promise<Uint8Array>;
	/**
	 * A media file at `url` fetched in the profile's session (its sign-ins) and stored as `FilesPort.download` stores one:
	 * classified by its first bytes, streamed into the store, never held whole.
	 */
	download(profile: string, url: string, signal: AbortSignal): Promise<Downloaded>;
}
/**
 * What an instance's link hands the engine (§4.5, `integrations.receive`): inbound conversation messages (each attachment
 * `{ name, mime, bytes, bin? }`, its bytes in `bins` at `bin`; `history` is a backfill nobody waits on), a provider's
 * report on a message it sent (§5.9; `providerId` is what its `send` answered), a chat the account cleared or deleted
 * (`clear`: every message of `thread` sent at or before `before` is tombstoned), or a pushing driver's changed sync
 * partition (`sync`: `'<model>.<sync>'`).
 */
export type DriverEvent =
	| { kind: 'messages'; messages: readonly Json[]; history?: true; bins?: readonly Uint8Array[] }
	| { kind: 'delivery'; providerId: string; report: DeliveryReport }
	| { kind: 'clear'; thread: string; before: string }
	| { kind: 'invalidate'; sync: string; partition: string };
/**
 * One of `message.attachments` (stored FileRefs, in order) as bolt hands it to `send`: the bytes read through the host's files
 * port, all of a message's together at most `LIMITS.messageAttachmentBytes`. `url` is a signed link a provider that fetches
 * media itself may pass on (Twilio's MediaUrl); it throws where the host serves no file links.
 */
export type OutboundAttachment = {
	readonly id: string;
	readonly name: string;
	readonly mime: string;
	readonly bytes: Uint8Array;
	url(expiresInS: number): Promise<string>;
};
/** The host's transactional mail and SMS (identity codes, invitations) and web push: a send to an address. */
export interface TransportPort {
	/** `kind` names what it sends (`email`, `sms`, `inbox` for push); the address is the message's. Any throw is a failed send. */
	send(kind: string, message: Json, signal: AbortSignal): Promise<{ providerId: string }>;
}
// ── the runtime log (§5.12) ──
export type LogLevel = 'info' | 'warn' | 'error';
/** One runtime event as it happens: the host writes it to its log pipe, never to the workspace's database. */
export type LogEvent = {
	readonly at: string;
	readonly severity: LogLevel;
	readonly event: string;
	readonly invocation: string;
	readonly run: string | null;
	readonly conversation: string | null;
	readonly turn: string | null;
	readonly attributes: { readonly [key: string]: Json };
};
/** A stored event as the host's log store answers it; `id` is the store's own cursor. */
export type LogRow = Omit<LogEvent, 'attributes'> & {
	readonly id: string;
	readonly attributes: Json;
};
export type LogQuery = {
	/** rows older than this id */
	readonly before?: string;
	/** rows newer than this id (the tail) */
	readonly after?: string;
	/** exactly this severity */
	readonly level?: LogLevel;
	/** this severity or worse */
	readonly min?: LogLevel;
	/** the event name or its attributes */
	readonly text?: string;
	readonly conversation?: string;
	readonly run?: string;
	/** events naming this automation */
	readonly automation?: string;
	/** instants bounding `at`: `since` inclusive, `until` exclusive */
	readonly since?: string;
	readonly until?: string;
	/** rows per page, 1 to 200 (default 200) */
	readonly limit?: number;
};
/**
 * The workspace's log facility, held by the host: each event written as it happens, and pages queried back newest first.
 * The host owns identity, time, caps and scope: an event names no tenant, and a query reads only this workspace's log.
 */
export interface LogPort {
	write(event: LogEvent): void;
	query(query: LogQuery, signal: AbortSignal): Promise<readonly LogRow[]>;
}
export interface MeteringPort {
	record(meter: string, quantity: number, key: string): Promise<void>;
}
export interface TenancyPort {
	/** The environment scope a request's host name addresses, or `null`. */
	resolve(host: string): Promise<string | null>;
}
export interface MembershipPort {
	/** `team` is a source team handle (`+team.ts`). */
	project(
		member: {
			user: string;
			email: string | null;
			phone: string | null;
			team: string | null;
			state: 'active' | 'inactive';
		},
		signal: AbortSignal
	): Promise<void>;
}
/** One next-due instant per scope, held in host memory; no polling (rule 52a). */
export interface DeadlinesPort {
	announce(scope: string, notLaterThan: string): void;
	settle(scope: string, nextDue: string | null): void;
	teardown(scope: string): void;
}
/** A pushing driver's page of a sync partition: its items (the sync `read`'s `items`), and the page facts a `read` page carries. */
export type DriverPage = {
	items: readonly Json[];
	cursor: Json;
	more: boolean;
	snapshot?: 'begin' | 'end';
	retained?: false;
	health?: { state: 'ready' | 'attention'; code?: string; message?: string };
};
/**
 * The host's live side of integration instances (§4.5), by instance id: a conversation driver `send`s (and shows `typing`),
 * a request driver (http, sqlserver) answers `request` with the instance's credential host-side, a pushing driver `read`s
 * a sync partition's page. A throw is a facility failure; `SendRefused` refuses a send (permanent or retried). An http `request`
 * answers `{ status, body }`, a database one the `DatabaseResult`.
 */
export interface LinksPort {
	send?(
		instance: string,
		message: Json,
		signal: AbortSignal,
		attachments?: readonly OutboundAttachment[]
	): Promise<{ providerId: string; presumeAfterMs?: number }>;
	typing?(instance: string, to: string, signal: AbortSignal): Promise<void>;
	request?(instance: string, op: Json, signal: AbortSignal): Promise<Json>;
	read?(
		instance: string,
		sync: string,
		partition: string,
		cursor: Json | null,
		signal: AbortSignal
	): Promise<DriverPage>;
	/**
	 * A committed change of what an instance's session link opened with — its `configuration` or its pause — or its
	 * deletion: the link closes, and opens again from the row as it is then when it is active and paired (a calendar
	 * watches what it names now; a resumed instance reconnects).
	 */
	changed?(instance: string): void;
}

// ── kernel ports (compute model §14, wave 1): the engine's former Node dependencies, served by the host ──
/**
 * The release's files, read-only. Paths are posix and relative to the release directory (`artifact.json`,
 * `client/index.html`), with no `.`, empty, `\` or NUL segment; `..` only as `../seed/<pack>/…`, the build's seed packs
 * beside the release (`.norbital/artifact` + `.norbital/seed/<pack>`). The host refuses any other path and resolves
 * symlinks itself, so a path never leaves those roots. `stat` answers `null` for nothing there; `list` answers every
 * file (never a directory) under `dir`, recursively, relative to `dir`, sorted.
 */
export interface ArtifactPort {
	read(path: string, signal: AbortSignal): Promise<Uint8Array>;
	list(dir: string, signal: AbortSignal): Promise<readonly string[]>;
	stat(path: string, signal: AbortSignal): Promise<ArtifactStat | null>;
}
export type ArtifactStat = { readonly kind: 'file' | 'directory'; readonly size: number };
/**
 * The tenant's secrets key, held by the host (F21): AES-256-GCM envelopes (`iv ‖ tag ‖ ciphertext`) bound to `aad`
 * (`bolt\0<owner>\0<name>`), so a copied envelope never opens under another owner or name. `open` answers `null` for
 * an envelope that does not open under this key and `aad`. A host without a key provides no port.
 */
export interface KeysPort {
	seal(plain: Uint8Array, aad: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
	open(sealed: Uint8Array, aad: Uint8Array, signal: AbortSignal): Promise<Uint8Array | null>;
}
/** A guest session's options: the prelude it evaluates first (the engine's `PRELUDE`), its entropy and its heap. */
export type GuestSessionOptions = {
	readonly prelude: string;
	/** `$1` draws SHA-256 blocks of it (`randomStream`), so a replay with the same seed draws the same values. */
	readonly seed: string;
	readonly memoryMiB: number;
	/** A program run once (a `run_js` script): no spare isolates are prepared for it. */
	readonly once?: true;
};
/** The prelude's `start(kind, path, inputJson, ctxJson, invocationId)`, by name. */
export type GuestStart = {
	readonly kind: InvocationKind;
	readonly path: readonly string[];
	readonly input: string;
	readonly ctx: string;
	readonly invocation: string;
};
/** The body's end state: its JSON result, a refusal, a missing body, or a throw (name, message, stack, facility kind). */
export type GuestFinal =
	| readonly ['ok', string]
	| readonly ['refused', string, string | null, number | null, string]
	| readonly ['missing', string]
	| readonly ['error', string, string, string]
	| readonly ['error', string, string, string, string];
/** One queued ctx call: member, JSON arguments, call site (stack frame) and call id. */
export type GuestCall = readonly [member: string, args: string, site: string, id: number];
/** The prelude's `take()`: end state, the calls crossing now, each call's bytes (`$bin`), and whether a timer ran instead. */
export type GuestTaken = readonly [
	final: GuestFinal | null,
	calls: readonly GuestCall[],
	bins: readonly (readonly Uint8Array[])[],
	ranTimer: boolean
];
/** One batch's answers (`give`): call ids, one JSON text per call, and each call's bytes. */
export type GuestAnswers = {
	readonly ids: readonly number[];
	readonly texts: readonly string[];
	readonly bins: readonly (readonly Uint8Array[])[];
};
/**
 * What one native slice leaves: the prelude's `take()` after it, and the console lines (`$0`) said since the last turn,
 * module evaluation's among the first; past 200 lines in one turn the host keeps the first 200 and counts the rest.
 */
export type GuestTurn = {
	readonly taken: GuestTaken;
	readonly lines: readonly (readonly [level: string, line: string])[];
	readonly dropped: number;
};
/**
 * Guest isolates, made and metered by the host. `open` evaluates `prelude` as an `evalClosure` body with the hooks
 * `$0` say (lines buffered for the turn), `$1` random (from `seed`), `$2` digest (`crypto.subtle.digest`'s host half)
 * and `$3` asset (`program.assets` by sha256), then `program.source` as one module bound to `__boltGuest`; it answers
 * an opaque session id. `start` and `give` run their prelude hook and then `take()`, `take` only `take()` (after a turn
 * whose timer ran): each call is one native slice, under a CPU slot the host takes for it. A session past its unit's
 * CPU budget or its memory ends and rejects with an encoded `HostFailure` of code `cpuBudget` or `memory`; an aborted
 * call ends its session. `close` disposes it (idempotent).
 */
export interface GuestIsolatesPort {
	open(program: GuestProgram, options: GuestSessionOptions, signal: AbortSignal): Promise<string>;
	start(session: string, start: GuestStart, signal: AbortSignal): Promise<GuestTurn>;
	take(session: string, signal: AbortSignal): Promise<GuestTurn>;
	give(session: string, answers: GuestAnswers, signal: AbortSignal): Promise<GuestTurn>;
	close(session: string): Promise<void>;
}
/** An outbound request: absolute URL, headers in order, body bytes (none for GET). */
export type HttpRequest = {
	readonly method: string;
	readonly url: string;
	readonly headers: readonly (readonly [name: string, value: string])[];
	readonly body?: Uint8Array;
};
/** `redirects`: hops followed (each re-checked); `maxBytes`: the decoded body's ceiling (more fails `tooLarge`). */
export type HttpFetchOptions = { readonly redirects: number; readonly maxBytes: number };
/** The final response: status, lowercase headers, the whole decoded body (empty for 204, 205, 304 and a redirect). */
export type HttpResponse = {
	readonly status: number;
	readonly headers: readonly (readonly [name: string, value: string])[];
	readonly body: Uint8Array;
};
/**
 * Outbound HTTP under the public-network policy (L-BOLT-366): HTTPS on 443 without credentials, DNS resolved once and
 * the checked address pinned, private and reserved networks refused, every redirect hop re-checked (a cross-origin hop
 * keeps only `accept`; a 301-303 of a write becomes a GET), transport headers (`host`, `connection`, `content-length`,
 * `transfer-encoding`, `upgrade`, `te`, `trailer`, `accept-encoding`, `proxy-*`) refused, gzip decoded. A refusal
 * rejects as a FacilityError `invalid`; the wall is the caller's (`Port.call`).
 */
export interface HttpPort {
	fetch(
		request: HttpRequest,
		options: HttpFetchOptions,
		signal: AbortSignal
	): Promise<HttpResponse>;
}
/** A file run's tree (a skill's folder): its digest, the entry's path in it, and every file by its path in the tree. */
export type BundleRequest = {
	/** sha256 hex of the sorted `<path>\0<sha256 hex of its bytes>` lines, `\n`-joined. */
	readonly digest: string;
	readonly entry: string;
	readonly files: readonly (readonly [path: string, bytes: Uint8Array])[];
};
/**
 * One ES module that imports nothing, with its source map (sources are tree paths), or the errors that stopped it, each
 * `file:line:column: message` and the line. The module's default export is `{ run(input) }`, which calls
 * `globalThis[Symbol.for('norbital.node')].run(input, load)` with `load` evaluating the entry; each Node built-in a run
 * provides (`fs`, `fs/promises`, `path`, `buffer`, `process`, `util`) is `…builtin(name)`, and a `require` that does not
 * resolve throws when called, naming the requirer.
 */
export type Bundled =
	{ readonly code: string; readonly map: string } | { readonly errors: readonly string[] };
/**
 * The confined bundler (compute model §3, "Running a file"): the host resolves the entry's imports inside the tree by
 * Node's rules and bundles them in a confined process that serves one tenant, caching by (digest, entry, bundler version).
 */
export interface BundlerPort {
	bundle(request: BundleRequest, signal: AbortSignal): Promise<Bundled>;
}
/** What `ctx.files.image` reads from a JPEG, PNG or HEIC: format, size, the PDQ perceptual hash and EXIF. */
export type ImageFacts = {
	readonly format: 'jpeg' | 'png' | 'heic';
	readonly width: number;
	readonly height: number;
	readonly pdq: string;
	readonly exif: {
		readonly takenAt?: string;
		readonly gps?: { readonly lat: number; readonly lng: number };
		readonly software?: string;
		readonly make?: string;
		readonly model?: string;
	};
};
export type ImagePreviewSize = 64 | 512 | 1024;
export type ImagePreviewMime = 'image/jpeg' | 'image/png' | 'image/heic' | 'image/heif';
/** A preview at most `maxEdge` on its long side, EXIF-oriented; `derived: false` is the original (an APNG, a HEIC sequence). */
export type ImagePreview = {
	readonly bytes: Uint8Array;
	readonly mime: string;
	readonly derived: boolean;
};
/**
 * Image decoding off the engine (JPEG, PNG, HEIC; rasters at most 16 million pixels, input at most
 * `LIMITS.storedFileBytes`): `facts`, a JPEG at most `maxEdge` on its long side, and a preview at most 5 MiB.
 */
export interface ImagesPort {
	facts(bytes: Uint8Array, signal: AbortSignal): Promise<ImageFacts>;
	jpeg(bytes: Uint8Array, maxEdge: number, signal: AbortSignal): Promise<Uint8Array>;
	preview(
		bytes: Uint8Array,
		mime: ImagePreviewMime,
		maxEdge: ImagePreviewSize,
		signal: AbortSignal
	): Promise<ImagePreview>;
}
/** An MCP server as the engine resolved it from the workspace's secrets: URL, headers, and its authorization. */
export type McpServer = {
	readonly url: string;
	readonly headers: { readonly [name: string]: string };
	readonly auth?:
		| { readonly bearer: string }
		| {
				readonly client: {
					readonly id: string;
					readonly secret: string;
					readonly scopes?: readonly string[];
				};
		  };
};
export type McpToolInfo = {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Json;
};
/**
 * MCP over streamable HTTP on the current protocol revision (rule 63b): `connect` answers an opaque session id, `call`
 * answers `{ content, structured?, isError? }`; `close` ends the session (idempotent).
 */
export interface McpPort {
	connect(server: McpServer, signal: AbortSignal): Promise<string>;
	tools(session: string, signal: AbortSignal): Promise<readonly McpToolInfo[]>;
	call(session: string, tool: string, input: Json, signal: AbortSignal): Promise<Json>;
	close(session: string): Promise<void>;
}
/** This release's API reference (`build/docs/<file>`, `index.json` first), served by the host: a cell reads no disk. */
export interface DocsPort {
	read(file: string, signal: AbortSignal): Promise<string>;
}
/** One cron the manifest declares: an automation's (`id` its name) or a remote sync's periodic read (the runs area's id). */
export type CronEntry = { readonly id: string; readonly cron: string; readonly zone: string };
/** `ran: false`: a repeat of `(id, slot)`, or a run that only read and wrote nothing. */
export type CronFired = { readonly ran: boolean };

export type HostPorts = {
	/** Durable administrator audit; no runtime-log fallback is permitted. */
	audit?: import('../protocol/audit.ts').AuditPort;
	files: FilesPort;
	deadlines: DeadlinesPort;
	secrets?: SecretsPort;
	convert?: ConvertPort;
	ai?: AiPort;
	speech?: SpeechPort;
	geocoder?: GeocoderPort;
	web?: WebReadPort;
	browser?: BrowserPort;
	push?: TransportPort;
	links?: LinksPort;
	metering?: MeteringPort;
	logs?: LogPort;
	tenancy?: TenancyPort;
	membership?: MembershipPort;
};
