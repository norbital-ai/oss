// What server code may cause beyond its own write (§3.3.9 effects, §5.8): runs, notices, and the automation-only I/O
// facilities. Facilities throw their typed error; `.try` returns it as a value (X-25).
import type { StartableName } from '../access/policy.ts';
import type { Checked, Exact, InputKind, InputOf, ValidInput, ValueOf } from '../fields.ts';
import type { ChannelName, CollectionName, Columns, HostToolName, Is, NamesPart, PolicyName, TeamName } from '../names.ts';
import type { FileRef, Id, Instant, Json, Msg, Offset, Point, RecordRef, Size, Vector } from '../values.ts';
import type { OutboundFor } from './channel.ts';
import type { AiModelClass, AutomationSpecOf, ConnectionName, EmbeddingModelName, IsUnion, TransportOf } from './names.ts';

// ── runs (rules 48–56) ──
/** A started run: its id and the automation it runs. */
export type RunHandle<A = StartableName> = { readonly id: Id<'sys_run'>; readonly automation: A };
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'stopped' | 'skipped';
export type RunCause = 'cron' | 'webhook' | 'created' | 'updated' | 'deleted' | 'schedule' | 'start' | 'retry';
/**
 * A run as `$bolt.runs` and the run ledger show it: cause, status, due and start time, progress, result and error.
 */
export type RunRow<O = unknown> = {
	readonly id: Id<'sys_run'>; readonly automation: StartableName; readonly cause: RunCause; readonly status: RunStatus;
	readonly due_at: Instant; readonly started: Instant | null;
	readonly progress: { readonly ratio: number | null; readonly text: string | null } | null; readonly result?: O;
	readonly error: { readonly code: string; readonly message: string } | null; readonly attempt_count: number;
};
/** The input a start or a schedule passes: the declared input, `{ mode }` for an integration run, else nothing. */
export type StartInput<A> = A extends `${infer C}.integration` ? C extends keyof NamesPart<'integrations'> ? { mode: 'pull' | 'push' | 'reconcile' } : never
	: AutomationSpecOf<A> extends { input: infer I } ? InputOf<I> : { readonly [key: string]: never };
export interface Schedule {
	/** Due at once without `at`; with `key`, a queued run under the same key is replaced (rule 51). */
	<const A extends string>(automation: Is<A, StartableName>, input: StartInput<A>, options?: { at?: Instant | { now: Offset }; key?: string }): Promise<RunHandle<A>>;
}

// ── notices (§3.3.9) ──
export type NoticeRecipient = { team: TeamName } | { user: Id<'sys_user'> } | { policy: PolicyName };
/**
 * A notice sent with `ctx.notify`: recipients (team, member or policy holders), a title and body message, an optional record link and a `once` key.
 */
export type Notice = { to: NoticeRecipient | readonly NoticeRecipient[]; title: Msg; body?: Msg; link?: RecordRef; once?: string };
export type Notify = (notice: Notice | readonly Notice[]) => Promise<void>;

// ── facility errors ──
/** An optional facility with no provider bound (P19): a value, never a throw, naming the facility and why. */
export type Unavailable = { readonly kind: 'unavailable'; readonly facility: string; readonly reason: string };
/** `tooLarge` and `invalid` pass a provider's own limit refusal through; `unsupported` is a provider refusing a specific input (P37). */
export type FacilityError = { readonly kind: 'upstream' | 'timeout' | 'rateLimited' | 'invalid' | 'tooLarge' | 'unsupported'; readonly message: string; readonly status?: number } | Unavailable;
type Call<A extends unknown[], R> = { (...args: A): Promise<R>; try(...args: A): Promise<R | FacilityError> };
type Out<O> = O & Checked<InputKind, O, Exact<O, ValidInput<O>>>;

// ── send, http, web ──
/** A single channel name: a union-typed channel is a type error (§3.3.9). */
export type Send = <const N extends ChannelName>(channel: N,
	message: IsUnion<N> extends true ? 'error: send names one channel' : OutboundFor<TransportOf<N>>) => Promise<Id<'sys_message'>>;
type Request<O> = { query?: { readonly [name: string]: string | number | boolean }; body?: Json; output: Out<O> };
interface Method {
	<const O extends InputKind>(path: string, request: Request<O>): Promise<ValueOf<O>>;
	try<const O extends InputKind>(path: string, request: Request<O>): Promise<ValueOf<O> | FacilityError>;
}
export type Http = (connection: ConnectionName) => { get: Method; post: Method; put: Method; patch: Method; delete: Method };
/**
 * A read page: its final URL, title and readable text (a PDF's text), and, when the provider reports them, its content type,
 * SHA-256 of the body and a document's page count; with `{ raw: true }` also the markup and its absolute links (a crawl).
 */ // hook:runtime
export type WebPage = { readonly url: string; readonly title: string | null; readonly text: string; readonly contentType?: string; readonly sha256?: string;
	readonly pages?: number; readonly html?: string; readonly links?: readonly string[] };
/** Refuses private, loopback and link-local addresses. */
export type Web = { read: Call<[url: string, options?: { raw?: boolean }], WebPage> };

// ── files (§5.8.1): handles by default, bytes only on request ──
/** A file reference with its size in bytes and SHA-256. */
export type FileMeta = FileRef & { readonly bytes: number; readonly sha256: string };
/**
 * What `ctx.files.image` reads from an image: format, size, SHA-256, the PDQ perceptual hash and EXIF (time taken, GPS, camera).
 */
export type ImageFacts = {
	readonly format: string; readonly width: number; readonly height: number; readonly sha256: string; readonly pdq: string;
	readonly exif: { readonly takenAt?: Instant; readonly gps?: Point; readonly software?: string; readonly make?: string; readonly model?: string };
};
type PdfBlock = { text: string; size?: number; bold?: true; italic?: true; align?: 'left' | 'center' | 'right' }
	| { table: readonly (readonly string[])[]; header?: true } | { image: FileRef; width?: number } | { spacer: number } | { pageBreak: true };
/** A document as data (`std/pdf`'s block literal); the host renders it and splices images, so no bytes enter the guest. */
export type PdfDoc = { page?: 'A4' | 'A5' | 'Letter'; font?: FileRef; blocks: readonly PdfBlock[] };
type FileFieldOf<C> = { [P in keyof Columns<C> & string]: Columns<C>[P] extends { kind: 'file' } ? P : never }[keyof Columns<C> & string];
/** Where a stored file belongs: a collection's file field, or an automation's run (collected with it). */
export type FileOwner = { [C in CollectionName]: `${C}.${FileFieldOf<C>}` }[CollectionName] | StartableName;
type Sheet = { readonly name: string; readonly rows: readonly (readonly (string | number | boolean | null)[])[] };
export type Files = {
	meta: Call<[ref: FileRef], FileMeta>;
	/** At most `max` bytes (default and ceiling 4MiB). */
	get: Call<[ref: FileRef, options?: { max?: Size }], Uint8Array>;
	url: Call<[ref: FileRef], string>;
	text: Call<[ref: FileRef], string>;
	table: Call<[ref: FileRef], readonly (readonly string[])[]>;
	sheet: Call<[ref: FileRef], readonly Sheet[]>;
	image: Call<[ref: FileRef], ImageFacts> & Call<[ref: FileRef, derive: { jpeg: { maxEdge: number } }], FileRef>;
	put: Call<[bytes: Uint8Array, options: { name: string; mime: string; for: FileOwner }], FileRef>;
	pdf: Call<[doc: PdfDoc, options: { name: string; for: FileOwner }], FileRef>;
	/** An optional host capability: a component rendered to a file. */
	render: Call<[component: string, props: Json, options: { name: string; for: FileOwner }], FileRef>;
};

// ── ai, geo ──
/** `steps`: model calls it may take (continuing a cut answer, calling tools), 8 by default, at most 64; each is bounded on its own. */
type InferRequest<O, Tools> = { model?: AiModelClass; system?: string; prompt: string; files?: readonly FileRef[]; output?: Out<O>; steps?: number }
	& (Tools extends true ? { tools?: readonly HostToolName[] } : {});
interface Infer<Tools> {
	<const O extends InputKind = { kind: 'text' }>(request: InferRequest<O, Tools>): Promise<ValueOf<O>>;
	try<const O extends InputKind = { kind: 'text' }>(request: InferRequest<O, Tools>): Promise<ValueOf<O> | FacilityError>;
}
/** `Tools`: host tools exist only when `runAs` is a policy list (rule 58). */
/**
 * A `sys_1` state (P37 (3)): structured text, never a file. A `FileRef` anywhere in it is a tsc error here and `invalid`
 * at run time; describe a file in text (name, mime, size, caption) instead.
 */
export type DecisionValue = string | number | boolean | null | readonly DecisionValue[] | { readonly [key: string]: DecisionValue };
/** A System 1 state: structured text keyed by name (P37); never a file. */
export type DecisionState = { readonly [key: string]: DecisionValue };
/** One typed question in the provider's shape (P37): a noul's criteria say what true and false mean; score levels run lowest first. */
export type DecisionQuestion =
	| { readonly type: 'noul'; readonly instructions: string; readonly criteria: { readonly true: string; readonly false: string } }
	| { readonly type: 'choice'; readonly instructions: string; readonly criteria: { readonly [option: string]: string } }
	| { readonly type: 'score'; readonly instructions: string; readonly criteria: readonly string[] };
/**
 * `ctx.ai.sys_1.decide`'s answers, each typed from its question literal (P36, P37): a choice's option key; a score's
 * continuous `score`, its most probable `level` (the level itself), and `probabilities`/`legend` keyed by level index.
 */
export type DecisionAnswers<Q extends { readonly [id: string]: DecisionQuestion }> = { [K in keyof Q]:
	Q[K] extends { type: 'choice'; criteria: infer O }
		? { type: 'choice'; choice: keyof O & string; confidence: number; probabilities: Record<keyof O & string, number> }
		: Q[K] extends { type: 'score'; criteria: readonly (infer L)[] }
			? { type: 'score'; score: number; level: L; confidence: number; probabilities: Record<`${number}`, number>; legend: Record<`${number}`, L> }
			: { type: 'noul'; noul: number } };
interface Decide {
	<const Q extends { readonly [id: string]: DecisionQuestion }>(request: { state: DecisionState; questions: Q }): Promise<{ answers: DecisionAnswers<Q>; costUsd: number }>;
	try<const Q extends { readonly [id: string]: DecisionQuestion }>(request: { state: DecisionState; questions: Q }): Promise<{ answers: DecisionAnswers<Q>; costUsd: number } | FacilityError>;
}
/** `sys_1` decides (P36, text only); `sys_2` is the LLM (multimodal); `embed` takes text and files (P39). */
export type Ai<Tools> = {
	sys_1: { decide: Decide };
	sys_2: { infer: Infer<Tools> };
	/** `dimensions`: the length of the vector field it fills (the host asks the model for that length). */
	embed: Call<[inputs: readonly (string | FileRef)[], options?: { model?: EmbeddingModelName; dimensions?: number }], readonly Vector[]>;
};
/** A geocoding result: the point, a short label and the full address. */
export type GeoHit = { readonly point: Point; readonly label: string; readonly address: string };
/** Geocoding is optional (P19): an absent provider is an `Unavailable` value, not a throw. */
export type Geo = { search(query: string): Promise<readonly GeoHit[] | Unavailable>; reverse(point: Point): Promise<GeoHit | Unavailable> };
