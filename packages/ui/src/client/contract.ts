// The structural client boundary supplied by a host; UI has no Bolt package dependency.
import type { Effect, Stream } from 'effect';
import type { Json } from '@norbital-ai/std/wire';
import type { Value, FileRef, FileUrlOptions } from '@norbital-ai/std/kind';
import type { Page, Values } from '../collection/types.js';
import type { RecordCapabilities, RecordParentContext, RestorePreview } from '../record/types.js';
import type { Offer } from '../filter/filter.js';
export type { Json } from '@norbital-ai/std/wire';
export type { FileRef } from '@norbital-ai/std/kind';
/** A read's wire form (`Query<T>['read']`): the host's method and its arguments. */
export type WireRead = { m: string; a: readonly Json[] };
export type ReadError = Error &
	(
		| { readonly _tag: 'ReadFailed'; readonly code: string; readonly message: string }
		| { readonly _tag: 'TransportFailed'; readonly status: number; readonly message: string }
	);
/**
 * A read (`query`, `aggregate`, `history`), as bolt's `Query<T>`: read in a component (`.current`, `.loading`, `.error`)
 * it is live, subscribing on the first reactive read and unsubscribing 30 s after its last reader is destroyed; awaited
 * outside a reactive context it reads once; and it is an Effect to `yield*`. `read` is its wire form.
 */
export interface Query<T> extends Effect.Effect<T, ReadError>, PromiseLike<T> {
	/** The latest answer; `undefined` until the first arrives. */
	readonly current: T | undefined;
	/** `true` until the first answer, and while the arguments' new answer is on its way. */
	readonly loading: boolean;
	readonly error: ReadError | undefined;
	readonly read: WireRead;
}
export type LiveError = Error & { code: string; message: string };
/** A host Stream a view follows (the run rows of `runs`). */
export type Live<T> = Stream.Stream<T, LiveError | ReadError>;
/** The page's clock (`clock(unit)`): today in the workspace zone (`YYYY-MM-DD`) and the instant (ISO). */
export type Clock = { readonly today: string; readonly now: string };
export type Outcome =
	| {
			kind: 'committed';
			output: Value;
			records: readonly { collection: string; id: string; revision: number }[];
	  }
	| {
			kind: 'pendingApproval';
			requestId: string;
			records: readonly { collection: string; id: string; revision: number }[];
	  }
	| { kind: 'refused'; code: string; message: string; field?: string; row?: number }
	| {
			kind: 'conflict';
			records: readonly { collection: string; id: string; fields: readonly string[] }[];
	  }
	| { kind: 'unknown'; invocation: string }
	/** Past the person-wait the write continues in the background as run `run`; its row reports the outcome (`runs`). */
	| { kind: 'running'; run: string };
/** Fields needed to present an outcome; actions may return any typed output. */
export type ActSuccess = Extract<Outcome, { kind: 'committed' | 'pendingApproval' | 'running' }>;
export type ActFailure = Error &
	(
		| {
				readonly _tag: 'ActRefused';
				readonly code: string;
				readonly message: string;
				readonly field?: string | undefined;
				readonly row?: number | undefined;
		  }
		| {
				readonly _tag: 'ActConflict';
				readonly records: readonly { collection: string; id: string; fields: readonly string[] }[];
				readonly message: string;
		  }
		| { readonly _tag: 'ActUnknown'; readonly invocation: string; readonly message: string }
	);
export type OutcomeFeedback =
	| { kind: Exclude<Outcome['kind'], 'refused'> }
	| Pick<Extract<Outcome, { kind: 'refused' }>, 'kind' | 'message'>;
/** A queued run's ids immediately and its admission outcome when awaited; `runs` follows execution. */
export type RunHandle = Effect.Effect<Outcome> & {
	readonly id: string;
	/** Every run a bulk start queued (`id` is the first). */
	readonly ids: readonly string[];
	readonly automation: string;
};
/** Rule 56's run row as its viewer may read it. */
export type RunRow = {
	id: string;
	automation: string;
	status: string;
	progress?: Value;
	error?: { code: string; message?: string | undefined } | null;
	attempt_count?: number;
	result?: Value;
	due_at?: string;
	started?: string | null;
};

/** A decision on a request's current step (`approvals.decide`); a superseder's `approve` supersedes. */
export type ApprovalDecision = 'approve' | 'reject' | 'requestChanges';
/** One step of a request's flow as it was snapshotted when the request opened (or was resubmitted): decided by any of its teams or users. */
export type ApprovalStep = {
	readonly name: string;
	readonly teams: readonly string[];
	readonly users: readonly string[];
};
type ApprovalWho = { ref: string; name: string | null };
/** One approval request as its participants and authorized record readers see it; the host decides every move. */
export type ApprovalView = {
	id: string;
	collection: string;
	record: string;
	action: string;
	at: string;
	/** Pending, ChangesRequested, Approved, Rejected or Superseded. */
	status: string;
	/** The current step (from 0). */
	step: number;
	steps: readonly ApprovalStep[];
	superseded_by: readonly string[];
	/** Current labels of the steps' team handles and user ids; captured handles and native eligibility remain authoritative. */
	teamNames: Readonly<Record<string, string>>;
	userNames: Readonly<Record<string, string>>;
	requestor: ApprovalWho;
	/** Every move, oldest first, each on the step it was taken at, with what a rollback did. */
	log: readonly {
		move: 'request' | 'approve' | 'reject' | 'requestChanges' | 'resubmit' | 'supersede';
		by: ApprovalWho;
		at: string;
		from: string | null;
		to: string;
		step: number;
		reason: string | null;
		/** A resubmission's changed fields. */
		changed?: readonly string[] | undefined;
		rolledBack?:
			| readonly { collection: string; id: string; action: 'restored' | 'removed' | 'recreated' }[]
			| undefined;
		skipped?:
			readonly { collection: string; id: string; field: string; reason: string }[] | undefined;
	}[];
	/** The records the provisional change holds: committed already, rolled back on rejection. */
	records: readonly { collection: string; id: string; op: 'create' | 'update' | 'delete' }[];
	/** The decisions this viewer may take now, straight from the host's transition table. */
	moves: readonly { decision: ApprovalDecision; reason: 'required' | 'optional' }[];
	mine: boolean;
	participant: boolean;
};
/** A row an open approval request holds carries it as `$approval` (step counts from 0; `steps[step]` decides now). */
export type RowApproval = {
	readonly requestId: string;
	readonly state: 'Pending' | 'ChangesRequested';
	readonly step: number;
	readonly steps: readonly ApprovalStep[];
	readonly requestedBy: string;
};
/**
 * The client a view reads and acts through (the page's `$bolt`, as bolt's `PageBolt`), as `provideBolt` hands it to the
 * views. Reads are `query`, `aggregate` and `history`, each a `Query<T>` of the answer the caller types (a view types
 * `Page<RowOf<C>>` by the collection it names).
 */
export type ViewBolt = {
	/**
	 * A model's rows (`{ where?, select?, orderBy?, search?, limit | all, after? }`), one record (`{ id, select? }`, or
	 * `{ id, revision }` as of that revision), the nearest rows of a search index (`{ search: { <index>: input }, where?,
	 * select?, limit }`), or a declared query (`'<model>.<query>'` and its input).
	 */
	query<T = Page>(target: string, args: Value): Query<T>;
	/** Without `by`, one row over the scope; with `by`, a page of buckets. */
	aggregate<T = readonly Values[]>(model: string, args: Value): Query<T>;
	/** A record's revisions, newest first, or from `at` (`{ instant } | { revision } | { before }`). */
	history<T = Json>(model: string, id: string, options?: { at?: Json }): Query<T>;
	/** With a unit, reactive (it changes at each minute, hour or day in the workspace zone); without, the page's open. */
	clock(unit?: 'minute' | 'hour' | 'day'): Clock;
	recordCapabilities?(
		collection: string,
		id: string,
		parent?: RecordParentContext
	): Effect.Effect<RecordCapabilities | null, Error>;
	act(
		callable: string,
		input: Value,
		options?: { key?: string; observed?: Readonly<Record<string, number>> }
	): Effect.Effect<ActSuccess, ActFailure>;
	/**
	 * Per-record restore (rule 17): `preview` says what taking a live record's own fields back to a past revision would
	 * write; `run` writes it as one update observed at `live`, recorded in history as restored from that revision.
	 */
	restore?: {
		preview(
			collection: string,
			record: string,
			revision: number
		): Effect.Effect<RestorePreview, Error>;
		run(
			collection: string,
			record: string,
			revision: number,
			live: number
		): Effect.Effect<ActSuccess, ActFailure>;
	};
	start(automation: string, input: Value | readonly Value[]): RunHandle;
	/** §3.5 `runs(automation, { where?, limit })`; absent until the client serves it (views then say so). */
	runs?(automation: string, options: { where?: Json; limit: number }): Live<Page<RunRow>>;
	fileUrl(ref: Pick<FileRef, 'id'>, options?: FileUrlOptions): string;
	/** §3.5 rule 11a in the browser: each top-level condition and sort key kept or dropped alone. Absent → the view's own check. */
	decode?(
		collection: string,
		q: { where?: Json; orderBy?: Json }
	): { where: Json; orderBy?: Json; dropped: readonly { path: string; message: string }[] };
	/** Rule 16a `filter.describe`: present only when the host binds `decisions` or `ai` (P19); rejects when no filter could be built. */
	describe?:
		| ((
				collection: string,
				text: string,
				fields?: readonly {
					name: string;
					label: string;
					kind: 'text' | 'number' | 'bool';
					optional?: boolean;
				}[]
		  ) => Effect.Effect<{ where: Json; orderBy?: Json }, Error>)
		| undefined;
	/** Rule 16b `filter.options`: the same condition catalogue a description is offered, so the builder renders exactly what it may author. */
	options?(
		collection: string,
		fields?: readonly {
			name: string;
			label: string;
			kind: 'text' | 'number' | 'bool';
			optional?: boolean;
		}[]
	): Effect.Effect<{ fields: readonly Offer[] }, Error>;
	approvals: {
		/** Decides the request's current step; `reason` is required for `reject` and `requestChanges` (and a superseder's approve). */
		decide(
			requestId: string,
			decision: { decision: ApprovalDecision; reason?: string }
		): Effect.Effect<ActSuccess, ActFailure>;
		/** The approval view: the request, its steps and timeline, and what the viewer may do; `null` when not visible. */
		get(requestId: string): Effect.Effect<ApprovalView | null, Error>;
		/** The approval views the caller may see, open ones unless `all`, by `collection`, `records` or request `ids`. */
		list(filter?: {
			collection?: string;
			records?: readonly string[];
			ids?: readonly string[];
			all?: boolean;
		}): Effect.Effect<readonly ApprovalView[], Error>;
	};
	actor: Json;
	locale: string;
	t(key: string, vars?: { readonly [name: string]: string | number }): string;
};
