// What server code may cause beyond its own write (§3.3.9 effects, §5.8): runs, notices, and the automation-only I/O
// facilities. Each answers an Effect (D8); a facility fails with `FacilityFailure` or `Unavailable` (`../errors.ts`).
import type { StartableName } from '../access/policy.ts';
import type { Eff } from '../ctx.ts';
import type { OutputOf } from '../body.ts';
import type { FacilityFailure, Unavailable as UnavailableFailure } from '../errors.ts';
import type { Checked, Exact, InputKind, InputOf, ValidInput, ValueOf } from '../fields.ts';
import type {
	AutomationName,
	ModelName,
	ExposureSpecOf,
	Columns,
	HostToolName,
	InstanceId,
	Is,
	PolicyName,
	TeamName
} from '../names.ts';
import type {
	brand,
	FileRef,
	Id,
	Instant,
	Json,
	Msg,
	Offset,
	Point,
	RecordRef,
	RequestId,
	Size,
	Vector
} from '../values.ts';
import type { ConversationOf, RequestOf, RequestResult, SendInput } from './integration.ts';
import type { Finding } from './sync.ts';
import type { Where } from '../where.ts';
import type {
	AiModelClass,
	AutomationSpecOf,
	ConnectionName,
	DeclaredConvertTarget,
	EmbeddingModelName,
	IntegrationOf,
	IsUnion
} from './names.ts';

// ── runs (rules 48–56) ──
/** A started run: its id and the automation it runs. */
export type RunHandle<A = StartableName> = { readonly id: Id<'sys_run'>; readonly automation: A };
/** Where a run stands. */
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'stopped' | 'skipped';
/** Why a run started; `handoff`: an act that outlived the person-wait, held by its run (compute model §3). */
export type RunCause =
	| 'cron'
	| 'webhook'
	| 'created'
	| 'updated'
	| 'deleted'
	| 'schedule'
	| 'start'
	| 'retry'
	| 'handoff';
/**
 * A run as `$bolt.runs` and the run ledger show it: cause, status, due and start time, progress, result and error.
 */
export type RunRow<O = unknown> = {
	readonly id: Id<'sys_run'>;
	readonly automation: StartableName;
	readonly cause: RunCause;
	readonly status: RunStatus;
	readonly due_at: Instant;
	readonly started: Instant | null;
	readonly progress: { readonly ratio: number | null; readonly text: string | null } | null;
	readonly result?: O;
	readonly error: {
		readonly code: string;
		readonly message?: string;
		readonly field?: string;
		readonly row?: number;
		readonly rows?: readonly number[];
		readonly rule?: string;
		readonly data?: { readonly requestId: RequestId };
		readonly records?: readonly {
			readonly model: string;
			readonly id: string;
			readonly fields: readonly string[];
		}[];
		readonly invocation?: string;
	} | null;
	readonly attempt_count: number;
};
/** The input a start or a schedule passes: the automation's declared input, else nothing (a sync run takes none). */
type SyncOf<A> = A extends `${infer M}.sync.${infer S}`
	? ExposureSpecOf<M> extends { syncs: infer X }
		? X[S & keyof X]
		: never
	: never;
type SyncModel<A> = A extends `${infer M}.sync.${string}` ? M : never;
type SyncContext<X> = X extends { context: infer F } ? InputOf<F> : {};
/** File syncs import a stored upload or export the view to a sheet or declared document target. */
export type FileSyncStartInput<A> = (
	| { readonly mode: 'import'; readonly file: Id<'sys_file'>; readonly accept?: boolean }
	| {
			readonly mode: 'template' | 'export';
			readonly format?: 'xlsx' | 'csv' | 'tsv' | 'json';
			readonly to?: DeclaredConvertTarget;
			readonly where?: Where<SyncModel<A>>;
	  }
) & { readonly context?: SyncContext<SyncOf<A>> };
/** The typed input accepted when starting an automation or a model sync. */
export type StartInput<A> = A extends AutomationName
	? AutomationSpecOf<A> extends { input: infer I }
		? InputOf<I>
		: { readonly [key: string]: never }
	: SyncOf<A> extends { with: 'file' }
		? FileSyncStartInput<A>
		: { readonly [key: string]: never };
/** The typed result recorded by an automation, or no result for a sync read. */
export type StartOutput<A> = A extends AutomationName
	? OutputOf<AutomationSpecOf<A>>
	: SyncOf<A> extends { with: 'file' }
		? | { readonly file: FileRef & { readonly bytes: number; readonly sha256: string } }
			| { readonly applied: false; readonly findings: readonly Finding[] }
			| {
					readonly applied: true;
					readonly created: number;
					readonly updated: number;
					readonly deleted: number;
					readonly findings: readonly Finding[];
			  }
			| { readonly pendingApproval: true; readonly findings: readonly Finding[] }
		: undefined;
/** `ctx.schedule`: queues a run of an automation (or a sync's read) after the current write commits. */
export interface Schedule {
	/** Due at once without `at`; with `key`, a queued run under the same key is replaced (rule 51). */
	<const A extends string>(
		automation: Is<A, StartableName>,
		input: StartInput<A>,
		options?: { at?: Instant | { now: Offset }; key?: string }
	): Eff<RunHandle<A>>;
}

// ── notices (§3.3.9, spec §2.2): one shape for a model's `notify` and `ctx.notify` ──
/**
 * Whom a notice goes to: a team's members, one member, a policy's holders, or, in a model's `notify` for an approval
 * event, the request's `'requester'` or the current step's `'approvers'` (teams and users); elsewhere those two resolve
 * to nobody.
 */
export type Recipient =
	| { team: TeamName }
	| { user: Id<'sys_user'> }
	| { policy: PolicyName }
	| 'requester'
	| 'approvers';
/**
 * A file a notice carries: a stored file, or a document converted at delivery (after the commit, retried with the
 * delivery) from Markdown or HTML to a target `+workspace.ts` declares under `convert.to`.
 */
export type NoticeAttachment =
	FileRef | { document: ConvertSource; to: ConvertTarget; name: string };
/**
 * One notice. The in-app inbox always gets it; `via` also sends it through those conversation connections (`bolt check`
 * refuses any other name) to each recipient's handle there. `link` defaults to the record the event is about; `once`
 * delivers at most one notice per key.
 * @example
 * { title: 'New colour matching job', description: `${name} is waiting on the board.`, to: [{ team: 'colour_matchers' }],
 *   via: ['whatsapp'], attachments: [{ document: { html }, to: 'pdf', name: 'Brief.pdf' }] }
 */
export type Notice = {
	title: Msg;
	description?: Msg;
	to: readonly Recipient[];
	via?: readonly ConnectionName[];
	attachments?: readonly NoticeAttachment[];
	link?: RecordRef;
	once?: string;
};
/** `ctx.notify`: queues notices, delivered after the current write commits; a notice never delays or fails it. */
export type Notify = (notice: Notice | readonly Notice[]) => Eff<void>;

// ── facility errors ──
/** What a facility call fails with. */
type Failure = FacilityFailure | UnavailableFailure;
type Call<A extends unknown[], R> = {
	(...args: A): Eff<R, Failure>;
};
type Out<O> = O & Checked<InputKind, O, Exact<O, ValidInput<O>>>;

// ── send, request, web ──
/** Where a send or request goes: a connection, or an instance id pinned to a definition. */
export type InstanceTarget = ConnectionName | InstanceId;
type SendPayload<N> =
	IsUnion<N> extends true
		? 'error: send names one connection'
		: [ConversationOf<IntegrationOf<N>>] extends [never]
			? 'error: this integration carries no conversation; send goes through a conversation instance'
			: SendInput<IntegrationOf<N>>;
/**
 * Queues a message through one conversation instance (the outbox delivers it after the run's write commits); a
 * union-typed target is a type error (§3.3.9), and a member's personal instance refuses at run time.
 */
export type Send = <const N extends string>(
	to: Is<N, InstanceTarget>,
	payload: SendPayload<N>
) => Eff<Id<'sys_message'>>;
type RequestPayload<N, O> =
	IsUnion<N> extends true
		? 'error: request names one connection'
		: [RequestOf<IntegrationOf<N>, O>] extends [never]
			? 'error: this integration takes no request'
			: RequestOf<IntegrationOf<N>, O>;
/**
 * A live request through one `http` or `sqlserver` instance: an HTTP op (its path under the definition's base URL) or a
 * database statement, journalled, with the credential host-side; it fails with a `FacilityFailure`, or `Unavailable`
 * while the instance is unpaired.
 */
export interface Request {
	<const N extends string, const O extends InputKind = { kind: 'json' }>(
		to: Is<N, InstanceTarget>,
		op: RequestPayload<N, O>
	): Eff<RequestResult<IntegrationOf<N>, O>, Failure>;
}
/**
 * A read page: its final URL, title and readable text (a PDF's text), and, when the provider reports them, its content type,
 * SHA-256 of the body and a document's page count; with `{ raw: true }` also the markup and its absolute links (a crawl).
 */ // hook:runtime
export type WebPage = {
	readonly url: string;
	readonly title: string | null;
	readonly text: string;
	readonly contentType?: string;
	readonly sha256?: string;
	readonly pages?: number;
	readonly html?: string;
	readonly links?: readonly string[];
};
/** Refuses private, loopback and link-local addresses. */
export type Web = { read: Call<[url: string, options?: { raw?: boolean }], WebPage> };

// ── files (§5.8.1): handles by default, bytes only on request ──
/** A file reference with its size in bytes and SHA-256. */
export type FileMeta = FileRef & { readonly bytes: number; readonly sha256: string };
/**
 * What `ctx.files.image` reads from an image: format, size, SHA-256, the PDQ perceptual hash and EXIF (time taken, GPS, camera).
 */
export type ImageFacts = {
	readonly format: string;
	readonly width: number;
	readonly height: number;
	readonly sha256: string;
	readonly pdq: string;
	readonly exif: {
		readonly takenAt?: Instant;
		readonly gps?: Point;
		readonly software?: string;
		readonly make?: string;
		readonly model?: string;
	};
};
type FileFieldOf<C> = {
	[P in keyof Columns<C> & string]: Columns<C>[P] extends { kind: 'file' } ? P : never;
}[keyof Columns<C> & string];
/** Where a stored file belongs: a model's file field, or an automation's run (collected with it). */
type FileOwner =
	{ [C in ModelName]: `${C}.${FileFieldOf<C>}` }[ModelName] | StartableName;
/** One worksheet: its name and rows of cell values. */
type Sheet = {
	readonly name: string;
	readonly rows: readonly (readonly (string | number | boolean | null)[])[];
};
/** `ctx.files`: stored files by reference; bytes only on request. */
export type Files = {
	meta: Call<[ref: FileRef], FileMeta>;
	/** At most `max` bytes (default and ceiling 4MiB). */
	get: Call<[ref: FileRef, options?: { max?: Size }], Uint8Array>;
	url: Call<[ref: FileRef], string>;
	text: Call<[ref: FileRef], string>;
	table: Call<[ref: FileRef], readonly (readonly string[])[]>;
	sheet: Call<[ref: FileRef], readonly Sheet[]>;
	image: Call<[ref: FileRef], ImageFacts> &
		Call<[ref: FileRef, derive: { jpeg: { maxEdge: number } }], FileRef>;
	put: Call<[bytes: Uint8Array, options: { name: string; mime: string; for: FileOwner }], FileRef>;
};

// ── convert: markdown or HTML to a document the workspace declares (`workspace({ convert: { to } })`) ──
/**
 * What each conversion target takes beyond `to` and `name`: a `reference` document styles a Word, PowerPoint or
 * OpenDocument output (its fonts, headers, footers and page setup, as pandoc's reference-doc); a PDF sets its paper.
 */
export type ConvertTargets = {
	pdf: { page?: 'A4' | 'A3' | 'Letter'; landscape?: boolean };
	docx: { reference?: FileRef };
	pptx: { reference?: FileRef };
	odt: { reference?: FileRef };
	epub: {};
	html: {};
};
/** A document format the converter can produce (`bolt.convert`, `ctx.convert.document`, notice attachments, file exports). */
export type ConvertTarget = keyof ConvertTargets;
/**
 * The source of a conversion: Markdown (pandoc's dialect, with pipe tables and front matter) or an HTML document. HTML is
 * read for its structure (headings, tables, images, emphasis); its CSS does not carry into the output, and a PDF is typeset
 * by Typst.
 */
export type ConvertSource = { readonly markdown: string } | { readonly html: string };
/**
 * One declared target, its file name and its options, discriminated by `to`: `reference` only where the format takes
 * one, `page` only for PDF. What a page's `bolt.convert(source, request)` takes: the file it answers is the viewer's own
 * and short-lived (`bolt.fileUrl` downloads it), and calls count against the policy limit key `convert` (default `30/min`).
 */
export type ConvertRequest = {
	[T in DeclaredConvertTarget]: { to: T; name: string } & ConvertTargets[T];
}[DeclaredConvertTarget];
/** `ctx.convert.document`'s options: a `ConvertRequest` and the owner `for` the stored output belongs to. */
export type ConvertOptions = ConvertRequest & { for: FileOwner };
/**
 * `ctx.convert` (optional host capability): only the targets `+workspace.ts` declares under `convert.to` type-check, and
 * the host confirms at start that it serves them. The output is stored like `files.put`'s, owned by `for`.
 */
export type Convert = { document: Call<[source: ConvertSource, options: ConvertOptions], FileRef> };

// ── ai, geo ──
/**
 * The model works in as many calls as it needs (continuing a cut answer, calling tools); each ends only after 60 s without a
 * token. A structured `output` is built by the model on a draft (`initial`, else empty) with `edit` (set, remove or append
 * at JSON Pointers whose segment for an item of a keyed list, `{ kind: 'list', key }`, is its key, not its index),
 * inspected with `read`, `find` and `diff` (changes since the start, keyed items matched by key), and handed in with
 * `submit`; a submission that does not match `output` or `rules` comes back with its problems and the model goes on until
 * one matches.
 */
type InferRequest<O, Tools> = {
	model?: AiModelClass;
	system?: string;
	prompt: string;
	files?: readonly FileRef[];
	output?: Out<O>;
	initial?: Json;
	/**
	 * CEL over `output`'s top-level fields that every submission must also hold, with what to tell the model when one does
	 * not; checked at `submit` and again when the budget is spent, where a draft still breaking one fails the call `invalid`
	 * with its message. This is how an automation makes an unfinished review fail instead of returning its `initial` draft
	 * unchanged: e.g. a `coverage` list whose items start `status: 'pending'`, with
	 * `{ expression: "coverage.all(c, c.status != 'pending')", message: 'every coverage item is reviewed' }`.
	 */
	rules?: readonly { readonly expression: string; readonly message: string }[];
	/**
	 * The most model turns that may call tools (the draft tools included), 1–1000, per batch of files. Once spent, or
	 * after 24 of the batch's 30 minutes, one final turn offers no host tools and must answer; otherwise the call fails `invalid`. Absent: no step budget.
	 */
	steps?: number;
	/**
	 * Names this inference's transcript: an administrator reads it in the agent panel, read-only, as
	 * `<automation> · <label>` (e.g. `MY · contribution`).
	 */
	label?: string;
} & (Tools extends true
	? {
			/**
			 * Tools the model may call between `edit`s: host tools the `runAs` policies name, and `'read'`, workspace
			 * records read as those policies (grants, masks and row scopes as for `ctx.query`; a bounded page per call; batch up to 8).
			 * @example Three-way matching: check an invoice against its open PO and goods receipts before answering.
			 * ```ts
			 * const match = yield* ctx.ai.sys_2.infer({
			 *   prompt: `Match invoice ${inv.number} from ${inv.supplier}: ${JSON.stringify(inv.lines)}. Read open purchase_orders
			 *     and goods_receipts for this supplier; compare quantities and unit prices line by line.`,
			 *   output: { kind: 'object', fields: { matched: { kind: 'bool' }, po: { kind: 'text', optional: true },
			 *     variances: { kind: 'list', of: { kind: 'text' } } } },
			 *   tools: ['read'],
			 *   steps: 6
			 * });
			 * ```
			 */
			tools?: readonly ('read' | HostToolName)[];
		}
	: {});
/**
 * An `output` given as data rather than declared: a JSON Schema (draft 2020-12) for the structure and CEL `rules` for the
 * logic between its parts, each read over the schema's top-level properties (`has(a.x) ? !has(a.y) : true`). Every
 * submission must satisfy both (and the request's own `rules`); a broken rule comes back to the model with its message.
 * There are no keyed lists: draft paths are plain JSON Pointers. Any number of `files` are read, in batches, into the one
 * answer.
 */
type InferSchemaOutput = {
	readonly jsonSchema: Json;
	readonly rules?: readonly { readonly expression: string; readonly message: string }[];
};
type InferSchemaRequest<Tools> = Omit<InferRequest<{ kind: 'text' }, Tools>, 'output'> & {
	output: InferSchemaOutput;
};
interface Infer<Tools> {
	(request: InferSchemaRequest<Tools>): Eff<Json, Failure>;
	<const O extends InputKind = { kind: 'text' }>(
		request: InferRequest<O, Tools>
	): Eff<ValueOf<O>, Failure>;
}
/** `Tools`: host tools exist only when `runAs` is a policy list (rule 58). */
/**
 * A `sys_1` state (P37 (3)): structured text, never a file. A `FileRef` anywhere in it is a tsc error here and `invalid`
 * at run time; describe a file in text (name, mime, size, caption) instead.
 */
type DecisionValue =
	| string
	| number
	| boolean
	| null
	| readonly DecisionValue[]
	| ({ readonly [key: string]: DecisionValue } & { readonly [brand]?: never });
/** A System 1 state: structured text keyed by name (P37); never a file. */
export type DecisionState = { readonly [key: string]: DecisionValue };
/** One typed question in the provider's shape (P37): a noul's criteria say what true and false mean; score levels run lowest first. */
export type DecisionQuestion =
	| {
			readonly type: 'noul';
			readonly instructions: string;
			readonly criteria: { readonly true: string; readonly false: string };
	  }
	| {
			readonly type: 'choice';
			readonly instructions: string;
			readonly criteria: { readonly [option: string]: string };
	  }
	| { readonly type: 'score'; readonly instructions: string; readonly criteria: readonly string[] };
/**
 * `ctx.ai.sys_1.decide`'s answers, each typed from its question literal (P36, P37): a choice's option key; a score's
 * continuous `score`, its most probable `level` (the level itself), and `probabilities`/`legend` keyed by level index.
 */
export type DecisionAnswers<Q extends { readonly [id: string]: DecisionQuestion }> = {
	[K in keyof Q]: Q[K] extends { type: 'choice'; criteria: infer O }
		? {
				type: 'choice';
				choice: keyof O & string;
				confidence: number;
				probabilities: Record<keyof O & string, number>;
			}
		: Q[K] extends { type: 'score'; criteria: readonly (infer L)[] }
			? {
					type: 'score';
					score: number;
					level: L;
					confidence: number;
					probabilities: Record<`${number}`, number>;
					legend: Record<`${number}`, L>;
				}
			: { type: 'noul'; noul: number };
};
interface Decide {
	<const Q extends { readonly [id: string]: DecisionQuestion }>(request: {
		state: DecisionState;
		questions: Q;
	}): Eff<{ answers: DecisionAnswers<Q>; costUsd: number }, Failure>;
}
/** `sys_1` decides (P36, text only); `sys_2` is the LLM (multimodal); `embed` takes text and files (P39). */
export type Ai<Tools> = {
	sys_1: { decide: Decide };
	sys_2: { infer: Infer<Tools> };
	/** `dimensions`: the length of the vector field it fills (the host asks the model for that length). */
	embed: Call<
		[
			inputs: readonly (string | FileRef)[],
			options?: { model?: EmbeddingModelName; dimensions?: number }
		],
		readonly Vector[]
	>;
	/** Speech to text (optional host capability, P19): long audio is transcribed in parts the host joins. */
	transcribe: Call<[file: FileRef, options?: TranscribeOptions], Transcript>;
	/** Text to speech (optional host capability, P19), stored like `files.put`'s output and owned by `for`. */
	speak: Call<[text: string, options: SpeakOptions], FileRef>;
};
/**
 * How `ctx.ai.transcribe` listens: `diarize` tells speakers apart (default true), `language` a BCP 47 hint, `speakers`
 * how many there are when known, `prompt` context such as names and vocabulary.
 */
export type TranscribeOptions = {
	diarize?: boolean;
	language?: string;
	speakers?: number;
	prompt?: string;
};
/** One stretch of speech: its speaker (`S1`, `S2`, … across the whole file), start and end in seconds, and the words. */
export type TranscriptSegment = {
	readonly speaker: string;
	readonly start: number;
	readonly end: number;
	readonly text: string;
};
/** `ctx.ai.transcribe`'s answer: segments in order, the language heard (BCP 47, or null) and the audio's length. */
export type Transcript = {
	readonly segments: readonly TranscriptSegment[];
	readonly language: string | null;
	readonly durationMs: number;
};
/** An audio format `ctx.ai.speak` writes. */
export type SpeechFormat = 'mp3' | 'wav' | 'ogg';
/**
 * `ctx.ai.speak`'s options: the owner `for` and file `name` (default `speech.<format>`), a provider `voice`, the `format`
 * (default mp3) and a `language` hint that providers reading the language from the text ignore.
 */
export type SpeakOptions = {
	for: FileOwner;
	name?: string;
	voice?: string;
	format?: SpeechFormat;
	language?: string;
};
/** A geocoding result: the point, a short label and the full address. */
export type GeoHit = { readonly point: Point; readonly label: string; readonly address: string };
/** Geocoding is optional (P19): an absent provider fails the call with `Unavailable`. */
export type Geo = {
	search(query: string): Eff<readonly GeoHit[], UnavailableFailure>;
	reverse(point: Point): Eff<GeoHit, UnavailableFailure>;
};
