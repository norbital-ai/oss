// The engine contracts (§2.3, §3.3.10 `/engine`, §11.1 P2): the only coupling between the engine areas. Types plus the
// few runtime values every area shares (budgets, the port-call wrapper, the manifest projection); failures are `errors.ts`.
//
// Ownership: who implements what is declared here.
//   EngineManifest, engineManifest ....... P1 compiler (A2, C1); consumed by every area
//   TenantDb ............................. PGlite adapter here in bolt (P2); Postgres adapter in bolt-server (P5)
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
import type { Pred } from '../protocol/ir-types.ts';

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
	crossings: { sync: 40, automation: 10_000 },
	readBytes: 32 * MiB,
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
export type NoticeRow = {
	to: Json;
	title: string;
	body?: string;
	link?: { collection: string; id: string };
	once?: string;
};
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

// ── outcomes (rule 32): the author types of decl/ctx with names erased ──
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
	/** A feed's page or an outbound rule's delivery writes as its definition, for the instance it runs for (§4.1, §4.2). */
	| {
			kind: 'system';
			run: string;
			by:
				| { automation: string }
				| { platform: string }
				| { integration: string; instance: string; feed: string }
				| { integration: string; instance: string; outbound: string };
	  };
export type ApprovalRoute = import('./approvals/configuration.ts').SourceApprovalRoute;
/** One grant arm; arms of every held policy union (rule 35). `fields: 'all'` = no field narrowing. */
export type Arm = { policy: string; where: Pred; fields: readonly string[] | 'all' };
export type WriteArm = Arm & { previous?: Pred };
export type CollectionAuthority = {
	read: readonly Arm[];
	history: readonly Arm[];
	create: readonly WriteArm[];
	update: readonly WriteArm[];
	delete: readonly WriteArm[];
	/** Optional source approval routes admit a proposal only when direct permission refuses. */
	approval: { readonly [O in 'create' | 'update' | 'delete']: readonly ApprovalRoute[] };
	queries: readonly string[];
	actions: readonly string[];
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
	| 'integration'
	| 'notification'
	| 'projection'
	| 'transform'
	| 'query'
	| 'action'
	| 'similarity'
	| 'rerank'
	| 'automation'
	| 'pipeline'
	| 'page'
	| 'validation'
	| 'tool'; // hook:reads (rerank)
/** One fresh-isolate run of one body. `target` names it: `'<c>'` (transform), `'<c>.<query|action|similarity>'`, `'<a>'`, or `'<app>/<page>'` (page). */
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
		/** transform: stored root rows per input (`null` on a create); record action: its row. */
		existing?: readonly (RowData | null)[];
		staged?: readonly {
			collection: string;
			id: string;
			path: InputPath;
			operation: string;
			parent?: { collection: string; id: string; relation: string; field: string };
		}[];
		row?: RowData;
		admin?: boolean;
		policies?: readonly string[];
		fields?: readonly string[];
		/** An integration body's instance, partition (a partitioned feed's), send key (an outbound `run`'s) and configuration. */
		instance?: string;
		partition?: string | null;
		key?: string;
		configuration?: Json;
	};
	budget: { cpuMs: number; crossings: number; readBytes: number };
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
	| { kind: 'ok'; output: Json; cpuMs: number }
	/** `ctx.refuse(message, { field })`. */
	| { kind: 'refused'; message: string; field?: string; cpuMs: number }
	/** A throw, a budget (`cpuBudget`, `crossingBudget`, `readBudgetExceeded`, `memory`) or a bad answer. */
	| { kind: 'failed'; error: BoltError; cpuMs: number };
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
/** hook:runtime — one embedding input: text, or a stored file's bytes (an image; embed models are multimodal). */
export type EmbedInput =
	| string
	| {
			readonly $file: {
				readonly name: string;
				readonly mime: string;
				readonly sha256: string;
				readonly bytes: Uint8Array;
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
/**
 * What an instance's link hands the engine (§4.5, `integrations.receive`): inbound conversation messages (each attachment
 * `{ name, mime, bytes, bin? }`, its bytes in `bins` at `bin`; `history` is a backfill nobody waits on), a provider's
 * report on a message it sent (§5.9; `providerId` is what its `send` answered), a chat the account cleared or deleted
 * (`clear`: every message of `thread` sent at or before `before` is tombstoned), or a pushing driver's changed feed
 * partition.
 */
export type DriverEvent =
	| { kind: 'messages'; messages: readonly Json[]; history?: true; bins?: readonly Uint8Array[] }
	| { kind: 'delivery'; providerId: string; report: DeliveryReport }
	| { kind: 'clear'; thread: string; before: string }
	| { kind: 'invalidate'; feed: string; partition: string };
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
export interface MeteringPort {
	record(meter: string, quantity: number, key: string): Promise<void>;
}
export interface TenancyPort {
	/** The environment scope a request's host name addresses, or `null`. */
	resolve(host: string): Promise<string | null>;
}
export interface MembershipPort {
	/** `team` is the `sys_team` id. */
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
/** A pushing driver's feed page (`from: 'driver'`): its items for the feed's `map`, and the page facts a `read` page carries. */
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
 * a feed page. A throw is a facility failure; `SendRefused` refuses a send (permanent or retried). An http `request`
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
		feed: string,
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
export type HostPorts = {
	files: FilesPort;
	deadlines: DeadlinesPort;
	secrets?: SecretsPort;
	convert?: ConvertPort;
	ai?: AiPort;
	speech?: SpeechPort;
	geocoder?: GeocoderPort;
	web?: WebReadPort;
	push?: TransportPort;
	links?: LinksPort;
	metering?: MeteringPort;
	tenancy?: TenancyPort;
	membership?: MembershipPort;
};
