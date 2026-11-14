// The typed operations on a page context use the same names, rows and inputs as server code. A read is `query` (and
// `history` for one record's revisions), the same name and arguments as server code's `ctx.query`, answering a `Query<T>`: live where a
// component reads it, one read where it is awaited outside one, and an Effect to `yield*`. Acts, starts, uploads, record
// capabilities, conversions, approval decisions and the session are Effects failing with typed tags; `clock`, `file_url`,
// `t` and `actor` stay plain. Pages run Effects on the ui edge (`run`, `fork`, `attach` from `@norbital-ai/ui/effect`).
import type { Effect } from 'effect';
import type { FileUrlOptions } from '@norbital-ai/store/kind';
import type { Actor } from '../decl/access/actor.ts';
import type { AutomationName } from '../decl/names.ts';
import type { AutomationSpecOf } from '../decl/runtime/names.ts';
import type { StartOutput } from '../decl/runtime/facilities.ts';
import type { SyncControlInput } from '../decl/runtime/sync.ts';
import type {
	ActMap,
	ActMapInput,
	ActMapOutput,
	ActOptions,
	Committed,
	HistoryOptions,
	MessageKey,
	PendingApproval,
	ReadAnswer,
	ReadRequest,
	ReadRequestBase,
	Revision,
	Running
} from '../decl/ctx.ts';
import type { ConvertSource, PreviewPdfOptions, Unavailable } from '@norbital-ai/host-api';
import type { ActConflict, ActRefused, ProtocolFailed, ReadFailed, Refusal } from '../decl/errors.ts';
import type { ActUnknown } from '../decl/errors/act.ts';
import type { TransportFailed } from '../decl/errors/browser.ts';
import type { ModelName, FileField, FileSyncName, ReadSyncName, Is, ReadableName } from '../decl/names.ts';
import type { StartInput } from '../decl/runtime/facilities.ts';
import type { FileRef, Id, Instant, Json, PlainDate, RequestId } from '../decl/values.ts';
import type { ApprovalView } from '../engine/approvals/approvals.ts';
import type { RecordCapabilities, RecordParentContext } from '../protocol/record-contracts.ts';
import type { WireRead } from '../protocol/wire.ts';

/**
 * A page's read (`ctx.query`, `ctx.history`). Read in a component (`.current`, `.loading`, `.error`,
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
 * and continues as a run, followed with ui's `RunStatus`) succeeds; refusal, conflict and uncertain settlement are typed
 * failures.
 */
type PageAct<O> = Effect.Effect<
	Committed<O> | PendingApproval | Running,
	ActRefused | ActConflict | ActUnknown | ProtocolFailed
>;
/**
 * Admission of queued runs: succeeds with the committed queue receipt; a refusal (a missing start grant, the start
 * quota), a conflict and an unconfirmed admission are typed failures, as every page write's (ui's `ActFailure`). ui's
 * `RunStatus` follows execution and its declared result.
 */
type PageRun<A extends string = string> = Effect.Effect<
	Committed<{
		readonly id: Id<'sys_run'>;
		readonly ids: readonly Id<'sys_run'>[];
		readonly automation: A;
	}>,
	ActRefused | ActConflict | ActUnknown | ProtocolFailed
> & {
	readonly mode: 'job';
	/** The first run's id; `ids` holds every run's, one per input. */
	readonly id: Id<'sys_run'>;
	readonly ids: readonly Id<'sys_run'>[];
	readonly automation: A;
};
/** A page operation with its own typed failure channel, executed by the mounted UI runtime through `run`, `fork` or `attach`. */
type PageCall<A, E> = Effect.Effect<A, E>;
/** The page's clock: today in the workspace zone and the instant. */
type PageClock = { readonly today: PlainDate; readonly now: Instant };

type UploadField = {
	[C in ModelName]: `${C}.${FileField<C>}` | `${C}.$import.${FileSyncName<C>}`;
}[ModelName];
/** An automation's `file` inputs, uploaded before the start that names them (`<automation>.$input.<input>`). */
type InputUploadField = {
	[A in AutomationName]: AutomationSpecOf<A> extends { input: infer I }
		? `${A}.$input.${{ [K in keyof I]: I[K] extends { kind: 'file' } ? K & string : never }[keyof I]}`
		: never;
}[AutomationName];
/** The approval requests a page lists: open ones unless `all`, by model, records or request ids. */
type ApprovalFilter = {
	model?: ModelName;
	records?: readonly string[];
	ids?: readonly RequestId[];
	all?: boolean;
};

/** The typed members of a page context; a page reads and acts as its viewer, so rows are caller rows. */
export interface PageBolt {
	/** Re-reads mounted queries, surfaces read failures, and waits for their subscribers to receive the answers. */
	refresh(): Effect.Effect<void, ReadFailed | TransportFailed>;
	/**
	 * A read request, as server code's `ctx.query`: roots (models with `outputs`) and their declared layers in one read, the
	 * answer typed from the named layers; live by every row it read, layers included.
	 * Read `.current`, `.loading` and `.error` reactively to render all states. Awaiting in an event handler reads once.
	 * @param request Declared roots and layers with caller-scoped filters and pagination; it never bypasses policies.
	 * @returns A Query whose current value is initially undefined; each root contains its own page or aggregate.
	 * @see Query
	 * @example
	 * const orders = ctx.query({
	 * 	orders: { where: { status: { eq: 'issued' } }, fields: ['number', 'total'], order_by: 'due_on', limit: 100,
	 * 		party: { fields: ['name'] }, lines: { fields: ['quantity', 'net'] } }
	 * });
	 */
	query<const R extends ReadRequestBase>(request: ReadRequest<R>): Query<ReadAnswer<R>>;
	/** A record's revisions, oldest first, up to an instant, a revision or just before an approval request. */
	history<C extends string>(
		model: Is<C, ReadableName>,
		id: NoInfer<Id<C>>,
		options?: HistoryOptions<C>
	): Query<readonly Revision[]>;
	/**
	 * The page's clock. With a unit, reactive: `today` and `now` change at each minute, hour or day boundary in the
	 * workspace zone, ticking only while the page is visible. Without one, a fixed snapshot taken when the page opened.
	 */
	clock(unit?: 'minute' | 'hour' | 'day'): PageClock;
	/** The record's field and operation permissions for its current revision; `null` when it is absent or not readable. */
	record_capabilities<C extends string>(
		model: Is<C, ReadableName>,
		id: NoInfer<Id<C>>,
		parent?: RecordParentContext
	): PageCall<RecordCapabilities | null, TransportFailed | ProtocolFailed>;
	/** Whether deleting these records would commit (`allow`), be held for approval (`approve`) or be refused (`refuse`), in one read. */
	delete_verdict<C extends string>(
		model: Is<C, ReadableName>,
		ids: readonly NoInfer<Id<C>>[]
	): PageCall<'allow' | 'approve' | 'refuse', TransportFailed | ProtocolFailed>;
	/** Plans every named generated write together and commits them as one statement. */
	act<const A extends ActMap>(acts: ActMapInput<A>, options?: ActOptions): PageAct<ActMapOutput<A>>;
	act<const A extends Readonly<Record<string, Json>>>(
		acts: string extends keyof A ? A : never,
		options?: ActOptions
	): PageAct<Readonly<Record<string, Json>>>;
	/**
	 * Starts an automation as the viewer (their policy's `capabilities.automations`). A `call` is the page RPC, the one
	 * request/response path to server code: it runs in this request and answers its declared output. A job queues one
	 * run per input, with `id`/`ids` available before admission settles so native controls can follow them; yielding it
	 * confirms queue admission, not completed execution. A job batch needs at least one input. Every failure is typed:
	 * recover a refusal with `Effect.catchTag('ActRefused', …)`.
	 */
	run<const A extends string>(
		automation: Is<A, AutomationName>,
		input: NoInfer<AutomationSpecOf<A> extends { mode: 'call' } ? StartInput<A> : StartInput<A> | readonly StartInput<A>[]>
	): AutomationSpecOf<A> extends { mode: 'call' }
		? PageCall<StartOutput<A>, ActRefused | ActConflict | ActUnknown | ProtocolFailed> & { readonly mode: 'call'; readonly automation: A } : PageRun<A>;
	/**
	 * Native sync controls, separate from automation calls and schedules; execution stays visible in the run ledger as
	 * `<model>.sync.<name>`, and the handle's run id follows progress and the exported file. Grants as `SyncControlInput`.
	 * @example
	 * ctx.sync_control('work_logs', 'work_sheet', { mode: 'import', file, context: { company } });
	 */
	sync_control<const M extends string, const S extends string>(
		model: Is<M, ModelName>, sync: Is<S, FileSyncName<M> | ReadSyncName<M>>, input: NoInfer<SyncControlInput<M, S>>
	): PageRun<`${M}.sync.${S}`>;
	/**
	 * Stores a file for a model's file field, a file sync's import (`<model>.$import.<sync>`) or an automation's `file`
	 * input (`<automation>.$input.<input>`, then pass the answered `FileRef` in the start); `accept` and `max` are checked
	 * before bytes are stored; a refusal is `ActRefused`.
	 */
	upload(
		file: Blob & { name?: string },
		field: UploadField | InputUploadField
	): PageCall<FileRef, ActRefused | TransportFailed>;
	/**
	 * Renders a PDF for this page and returns its bytes without storing a file or a conversion job, for content the
	 * viewer already has; limited by the policy's `convert` rate (default `30/min`). A stored document comes from an
	 * automation's `ctx.convert.document`.
	 */
	preview_pdf(
		source: ConvertSource,
		options?: PreviewPdfOptions
	): PageCall<Uint8Array, ActRefused | TransportFailed | Unavailable>;
	/**
	 * The URL a page shows or downloads a stored file from: the original, or with `{ preview: 64 | 512 | 1024 }` an image
	 * preview of that maximum edge. Reading it still needs the file's record or conversation authority; a public page's
	 * URL keeps its app or kiosk scope.
	 */
	file_url(ref: Pick<FileRef, 'id'>, options?: FileUrlOptions): string;
	/** Approval requests: decide the current step, read one request's view, or list the requests the viewer may see. */
	approvals: {
		/**
		 * Decides the request's current step as the viewer: `approve` (a superseder's approve supersedes, reason
		 * required), `reject` (rolls the held change back), or `request_changes` (the requester edits and saves to
		 * resubmit); `reason` is required for the last two. `withdraw` is the requester's own: it takes their open
		 * request back, restoring the record as a rejection does. Offer what the view's `moves` lists.
		 */
		decide(
			id: RequestId,
			decision: {
				decision: 'approve' | 'reject' | 'request_changes' | 'withdraw';
				reason?: string;
			}
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
	 * On-page sign-in: `send_code` texts or emails a six-digit code, `verify` proves it, signs the viewer in — a
	 * newcomer joins where the workspace declares `signup` — and reloads the page as them. A refusal is a `Refusal`. ui's
	 * `<PhoneVerify {ctx} session={ctx.session} />` is the whole control.
	 */
	session: {
		send_code(address: string): PageCall<void, Refusal>;
		verify(address: string, code: string): PageCall<void, Refusal>;
	};
	/** Who the page runs as; `null` before a visitor page has one. */
	actor: Actor | null;
}
