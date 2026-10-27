// `PageBolt` (D9): `$bolt` as pages see it, over the same names, rows and inputs as `ctx`. A read is `query` (and
// `aggregate`, `history`), the same name and arguments as server code's `ctx.query`, answering a `Query<T>`: live where a
// component reads it, one read where it is awaited outside one, and an Effect to `yield*`. Acts, starts, uploads, record
// capabilities, conversions, approval decisions and the session are Effects failing with the D3 tags; `clock`, `fileUrl`,
// `t` and `actor` stay plain. Pages run Effects on the ui edge (`run`, `fork`, `attach` from `$bolt`).
import type { Effect } from 'effect';
import type { FileUrlOptions } from '@norbital-ai/std/kind';
import type { Actor } from '../decl/access/actor.ts';
import type { StartableName } from '../decl/access/policy.ts';
import type {
	ActInput,
	ActOutput,
	AggRow,
	Bucket,
	BucketField,
	Callable,
	Committed,
	HistoryOptions,
	Measures,
	MessageKey,
	Outcome,
	Page,
	Paged,
	PendingApproval,
	ReadAnswer,
	ReadRequest,
	ReadRequestBase,
	Revision,
	Running
} from '../decl/ctx.ts';
import type {
	ActConflict,
	ActRefused,
	ActUnknown,
	ProtocolFailed,
	ReadFailed,
	Refusal,
	TransportFailed,
	Unavailable
} from '../decl/errors.ts';
import type { ModelName, FileField, FileSyncName, Is, ReadableName } from '../decl/names.ts';
import type {
	ConvertRequest,
	ConvertSource,
	StartInput,
	StartOutput
} from '../decl/runtime/facilities.ts';
import type { FileRef, Id, Instant, PlainDate, RequestId } from '../decl/values.ts';
import type { ApprovalView } from '../engine/approvals/approvals.ts';
import type { RecordCapabilities, RecordParentContext } from '../protocol/record-contracts.ts';
import type { WireRead } from '../protocol/wire.ts';

/**
 * A page's read (`bolt.query`, `bolt.aggregate`, `bolt.history`). Read in a component (`.current`, `.loading`, `.error`,
 * or `await` inside `$derived` or markup), it is live: it subscribes on the first reactive read and unsubscribes 30 s after
 * its last reader is destroyed, and identical calls share one subscription. Awaited outside a reactive context (a click
 * handler), it reads once. It is also an Effect, so it `yield*`s in a page's Effect code. `read` is its wire form.
 */
export interface Query<out T>
	extends Effect.Effect<T, ReadFailed | TransportFailed>, PromiseLike<T> {
	/** The latest answer; `undefined` until the first arrives. */
	readonly current: T | undefined;
	/** `true` until the first answer, and while the arguments' new answer is on its way. */
	readonly loading: boolean;
	/** The read's failure, if the latest answer failed. */
	readonly error: ReadFailed | TransportFailed | undefined;
	readonly read: WireRead;
}
/**
 * A caller-authorized write: committed output, a held approval proposal, or `running` (the write outlived the person-wait
 * and continues as a run, followed through `bolt.runs`) succeeds; refusal, conflict and uncertain settlement are typed
 * failures.
 */
export type PageAct<O, N = string> = Effect.Effect<
	Committed<O, N> | PendingApproval<N> | Running,
	ActRefused | ActConflict | ActUnknown
>;
/** Admission of queued runs; a committed output is the queue receipt. `runs` follows execution and its declared result. */
export type PageStart<A extends string = string> = Effect.Effect<
	Outcome<{
		readonly id: Id<'sys_run'>;
		readonly ids: readonly Id<'sys_run'>[];
		readonly automation: A;
	}>
> & {
	/** The first run's id; `ids` holds every run's, one per input. */
	readonly id: Id<'sys_run'>;
	readonly ids: readonly Id<'sys_run'>[];
	readonly automation: A;
};
/** A page operation with its own typed failure channel, executed by the mounted UI runtime through `run`, `fork` or `attach`. */
export type PageCall<A, E> = Effect.Effect<A, E>;
/** The page's clock: today in the workspace zone and the instant. */
export type PageClock = { readonly today: PlainDate; readonly now: Instant };

type UploadField = {
	[C in ModelName]: `${C}.${FileField<C>}` | `${C}.$import.${FileSyncName<C>}`;
}[ModelName];
/** The approval requests a page lists: open ones unless `all`, by model, records or request ids. */
type ApprovalFilter = {
	model?: ModelName;
	records?: readonly string[];
	ids?: readonly RequestId[];
	all?: boolean;
};

/** The typed members of `$bolt` (§3.5); a page reads and acts as its viewer, so rows are caller rows. */
export interface PageBolt {
	/**
	 * A read request, as server code's `ctx.query`: roots (models with `read`) and their declared layers in one read, the
	 * answer typed from the named layers; live by every row it read, layers included.
	 * @example
	 * const orders = bolt.query({
	 * 	orders: { where: { status: { eq: 'issued' } }, fields: ['number', 'total', 'party'], orderBy: 'due_on', limit: 100 },
	 * 	'orders.party': { fields: ['name'] },
	 * 	'orders.lines': { fields: ['quantity', 'net'] }
	 * });
	 */
	query<const R extends ReadRequestBase>(request: ReadRequest<R>): Query<ReadAnswer<R>>;
	/** Without `by`, one row over the whole scope. */
	aggregate<C extends string>(
		model: Is<C, ReadableName>,
		args: Measures<C> & { by?: never }
	): Query<AggRow<C>>;
	/** With `by`, a page of buckets (rule 9), each keyed by its bucket values. */
	aggregate<C extends string, const B extends Bucket<C> | readonly Bucket<C>[]>(
		model: Is<C, ReadableName>,
		args: Measures<C> & { by: B } & Paged
	): Query<Page<AggRow<C, BucketField<B>>>>;
	/** A record's revisions, newest first, or from an instant, a revision or just before an approval request. */
	history<C extends string>(
		model: Is<C, ReadableName>,
		id: NoInfer<Id<C>>,
		options?: HistoryOptions
	): Query<readonly Revision<C>[]>;
	/**
	 * The page's clock. With a unit, reactive: `today` and `now` change at each minute, hour or day boundary in the
	 * workspace zone, ticking only while the page is visible. Without one, a fixed snapshot taken when the page opened.
	 */
	clock(unit?: 'minute' | 'hour' | 'day'): PageClock;
	/** The record's field and operation permissions for its current revision; `null` when it is absent or not readable. */
	recordCapabilities<C extends string>(
		model: Is<C, ReadableName>,
		id: NoInfer<Id<C>>,
		parent?: RecordParentContext
	): PageCall<RecordCapabilities | null, TransportFailed | ProtocolFailed>;
	/** Runs a callable with its typed input; a held write is a success. */
	act<const N extends string>(
		callable: Is<N, Callable>,
		input: NoInfer<ActInput<N>>,
		options?: { key?: string; once?: string; observed?: Readonly<Record<string, number>> }
	): PageAct<ActOutput<N>, N>;
	/**
	 * Starts an automation now with its typed input, or once per input in one request (a bulk action over selected
	 * records); `id`/`ids` are the runs' ids before the outcome settles (a toolbar item returning it shows the runs).
	 */
	start<const A extends string>(
		automation: Is<A, StartableName>,
		input: NoInfer<StartInput<A> | readonly StartInput<A>[]>
	): PageStart<A>;
	/** `accept` and `max` are checked before bytes are stored; a refusal is `ActRefused`. */
	upload(
		file: Blob & { name?: string },
		field: UploadField
	): PageCall<FileRef, ActRefused | TransportFailed>;
	/**
	 * Converts content the page already has (Markdown or HTML) to a target `+workspace.ts` declares under `convert.to`,
	 * on the host: a short-lived file the viewer owns (download it with `fileUrl`). Rate-limited by the policy limit key
	 * `convert` (default `30/min`); an undeclared or unserved target fails `Unavailable`.
	 */
	convert(
		source: ConvertSource,
		request: ConvertRequest
	): PageCall<FileRef, ActRefused | TransportFailed | Unavailable>;
	/** The URL a page shows or downloads a stored file from. */
	fileUrl(ref: Pick<FileRef, 'id'>, options?: FileUrlOptions): string;
	/** Approval requests: decide the current step, read one request's view, or list the requests the viewer may see. */
	approvals: {
		/**
		 * Decides the request's current step as the viewer: `approve` (a superseder's approve supersedes, reason
		 * required), `reject` (rolls the held change back), or `requestChanges` (the requester edits and saves to
		 * resubmit); `reason` is required for the last two.
		 */
		decide(
			id: RequestId,
			decision: { decision: 'approve' | 'reject' | 'requestChanges'; reason?: string }
		): PageAct<undefined>;
		/** One request's view (its steps, timeline and the viewer's moves); `null` when not visible. */
		get(id: RequestId): PageCall<ApprovalView | null, TransportFailed | ProtocolFailed>;
		list(
			filter?: ApprovalFilter
		): PageCall<readonly ApprovalView[], TransportFailed | ProtocolFailed>;
	};
	/** A message of `+messages.ts` in the page's locale, `{name}` placeholders filled from `vars`. */
	t(key: MessageKey, vars?: { readonly [name: string]: string | number }): string;
	/**
	 * On-page sign-in (§5.11.2): `sendCode` texts or emails a six-digit code, `verify` proves it, signs the viewer in — a
	 * newcomer joins where the workspace declares `signup` — and reloads the page as them. A refusal is a `Refusal`. ui's
	 * `<PhoneVerify session={bolt.session} />` is the whole control.
	 */
	session: {
		sendCode(address: string): PageCall<void, Refusal>;
		verify(address: string, code: string): PageCall<void, Refusal>;
	};
	/** Who the page runs as; `null` before a visitor page has one. */
	actor: Actor | null;
}
