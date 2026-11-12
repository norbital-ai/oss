// The structural client boundary supplied by a host; UI has no Bolt package dependency.
import type { Effect, Stream } from 'effect';
import type { Json } from '@norbital-ai/std/wire';
import type { Value, FileRef, FileUrlOptions, Kind } from '@norbital-ai/std/kind';
import type { ModelKey, Page, RecordOf, Row, RowOf, SourceColumns, SourceRow, Values, ViewSource } from '../model/types.js';
import type { RecordCapabilities, RecordParentContext, RestorePreview } from '../record/types.js';
import type { Offer } from '../filter/catalog.js';
export type { Json } from '@norbital-ai/std/wire';
export type { FileRef } from '@norbital-ai/std/kind';
/** A read's wire form (`Query<T>['read']`): the host's method and its arguments. */
export type WireRead = { m: string; a: readonly Json[] };
export type ReadError = Error &
	(
		| { readonly _tag: 'ReadFailed'; readonly code: string; readonly message: string }
		| { readonly _tag: 'TransportFailed'; readonly status: number; readonly message: string }
	);
/** A read request's answer (`query`): one page per root. */
export type QueryAnswer<R = Row> = { readonly [root: string]: Page<R> };
/** One revision of a record as `history` answers it (rule 17). */
export type HistoryEntry = {
	readonly revision: number;
	readonly at: string | null;
	readonly actor: { readonly kind: string; readonly id: string } | null;
	readonly cause: 'direct' | 'cascade' | 'derived' | 'seed' | 'erased' | 'restored';
	/** A per-record restore's source revision; `null` for any other write. */
	readonly restored_from: number | null;
	/** The approval request this revision belongs to and that request's state now. */
	readonly approval: { readonly request: string; readonly state: string | null } | null;
	/** The fields this revision wrote, as the read's output shows them. */
	readonly changed: Readonly<Record<string, Json>>;
	readonly schema_version: string;
	readonly incompatible: readonly string[];
	/** Whether the whole revision still projects into today's representation. */
	readonly valid: boolean;
};
/** One revision rendered with its own definition, and the values safe to project into today's schema. */
export type HistorySnapshot = {
	readonly model: string;
	readonly record: string;
	readonly revision: number;
	readonly at: string | null;
	readonly schema_version: string;
	readonly fields: Readonly<Record<string, Kind>>;
	readonly values: Readonly<Record<string, Json>>;
	readonly compatible: Readonly<Record<string, Json>>;
	readonly incompatible: readonly string[];
};
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
			output: Value | undefined;
			records: readonly { model: string; id: string; revision: number }[];
	  }
	| {
			kind: 'pending_approval';
			request_id: string;
			records: readonly { model: string; id: string; revision: number }[];
	  }
	| { kind: 'refused'; code: string; message: string; field?: string; row?: number }
	| {
			kind: 'conflict';
			records: readonly { model: string; id: string }[];
	  }
	| { kind: 'unknown'; invocation: string }
	/** Past the person-wait the write continues in the background as run `run`; its row reports the outcome (`runs`). */
	| { kind: 'running'; run: string };
/** Fields needed to present an outcome; actions may return any typed output. */
export type ActSuccess = Extract<Outcome, { kind: 'committed' | 'pending_approval' | 'running' }>;
/** A malformed native receipt is an error, independent of whether the host already applied the operation. */
export type ProtocolFailure = Error & { readonly _tag: 'ProtocolFailed'; readonly message: string };
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
				readonly records: readonly { model: string; id: string }[];
				readonly message: string;
		  }
		| { readonly _tag: 'ActUnknown'; readonly invocation: string; readonly message: string }
		| { readonly _tag: 'ProtocolFailed'; readonly message: string }
	);
export type OutcomeFeedback =
	| { kind: Exclude<Outcome['kind'], 'refused'> }
	| Pick<Extract<Outcome, { kind: 'refused' }>, 'kind' | 'message'>;
/** A queued run's ids immediately and its admission outcome when awaited; `runs` follows execution. */
export type RunHandle = Effect.Effect<Outcome, ProtocolFailure> & {
	readonly mode: 'job';
	readonly id: string;
	/** Every run a bulk start queued (`id` is the first). */
	readonly ids: readonly string[];
	readonly automation: string;
};
/** In-request automation output, with no durable run identity. */
export type CallHandle = Effect.Effect<Value | undefined, ActFailure> & { readonly mode: 'call'; readonly automation: string };
export type AutomationHandle = RunHandle | CallHandle;
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
export type ApprovalDecision = 'approve' | 'reject' | 'request_changes';
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
	model: string;
	record: string;
	action: string;
	at: string;
	/** Pending, ChangesRequested, Approved, Rejected, Superseded or Withdrawn. */
	status: string;
	/** The current step (from 0). */
	step: number;
	steps: readonly ApprovalStep[];
	superseded_by: readonly string[];
	/** Current labels of the steps' team handles and user ids; captured handles and native eligibility remain authoritative. */
	team_names: Readonly<Record<string, string>>;
	user_names: Readonly<Record<string, string>>;
	requestor: ApprovalWho;
	/** Every move, oldest first, each on the step it was taken at, with what a rollback did. */
	log: readonly {
		move: 'request' | 'approve' | 'reject' | 'request_changes' | 'resubmit' | 'supersede';
		by: ApprovalWho;
		at: string;
		from: string | null;
		to: string;
		step: number;
		reason: string | null;
		/** A resubmission's changed fields. */
		changed?: readonly string[] | undefined;
		rolled_back?:
			| readonly { model: string; id: string; action: 'restored' | 'removed' | 'recreated' }[]
			| undefined;
		skipped?: readonly { model: string; id: string; field: string; reason: string }[] | undefined;
	}[];
	/** The records the provisional change holds: committed already, rolled back on rejection or withdrawal. */
	records: readonly { model: string; id: string; op: 'create' | 'update' | 'delete' }[];
	/** The decisions this viewer may take now, straight from the host's transition table. */
	moves: readonly { decision: ApprovalDecision; reason: 'required' | 'optional' }[];
	mine: boolean;
	participant: boolean;
};
/** A row an open approval request holds carries it as `$approval` (step counts from 0; `steps[step]` decides now). */
export type RowApproval = {
	readonly request_id: string;
	readonly state: 'Pending' | 'ChangesRequested';
	readonly step: number;
	readonly steps: readonly ApprovalStep[];
	readonly requested_by: string;
};
/**
 * The client a view reads and acts through (the page context), as `provide_bolt` hands it to the
 * views. Dynamic reads have fixed structural answers; model reads derive their row from the actual model input.
 */
export type ViewBolt = {
	/** Re-reads mounted queries without a polling timer. */
	refresh(): Effect.Effect<void, Error>;
	/**
	 * One read request (`query({ <root>: { where?, fields?, order_by?, limit?, after?, search? }, '<root>.<layer>': { … } })`),
	 * answered as a page per root; a declared layer nests under its relation in each row.
	 */
	query(request: { readonly [path: string]: Json }): Query<QueryAnswer>;
	/** Internal model-view read: the host selects and validates every promised default-output list field. */
	model_query<C extends ModelKey>(model: C, request: Readonly<Record<string, Json>>, mode: 'list'): Query<QueryAnswer<RowOf<C> & Row>>;
	/** Internal record-view read: the host selects and validates the complete default-output record. */
	model_query<C extends ModelKey>(model: C, request: Readonly<Record<string, Json>>, mode: 'record'): Query<QueryAnswer<RecordOf<C> & Row>>;
	/** Internal source-linked model branch; a request or local source keeps its own original producer instead. */
	source_query<S extends ViewSource>(source: S, request: Readonly<Record<string, Json>>): Query<QueryAnswer<SourceRow<S> & Partial<SourceColumns<S>>>>;
	/** Internal projection for an authored representation; null leaves narrower authorized data with the native view. */
	project_record<C extends ModelKey>(model: C, record: Row): (RecordOf<C> & Row) | null;
	/** Without `by`, one row over the scope (`Values`); with `by`, a page of buckets (`Page<Values>`). */
	aggregate(model: string, args: Values & { readonly by: Value }): Query<Page<Values>>;
	aggregate(model: string, args: Value): Query<Values | Page<Values>>;
	/** A record's revisions, newest first, or from `at` (`{ instant } | { revision } | { before }`). */
	history<C extends ModelKey>(
		model: C,
		id: string,
		options: { at?: Json; output?: string; view: true }
	): Query<(HistorySnapshot & { readonly projection: (RecordOf<C> & Row) | null }) | null>;
	history(model: string, id: string, options?: { at?: Json; output?: string }): Query<readonly HistoryEntry[]>;
	/** With a unit, reactive (it changes at each minute, hour or day in the workspace zone); without, the page's open. */
	clock(unit?: 'minute' | 'hour' | 'day'): Clock;
	record_capabilities?(
		model: string,
		id: string,
		parent?: RecordParentContext
	): Effect.Effect<RecordCapabilities | null, Error>;
	act(
		acts: Readonly<Record<string, Value>>,
		options?: { key?: string }
	): Effect.Effect<ActSuccess, ActFailure>;
	/**
	 * Per-record restore (rule 17): `preview` says what taking a live record's own fields back to a past revision would
	 * write; `run` writes it as one update observed at `live`, recorded in history as restored from that revision.
	 */
	restore?: {
		preview(model: string, record: string, revision: number): Effect.Effect<RestorePreview, Error>;
		run(
			model: string,
			record: string,
			revision: number,
			live: number
		): Effect.Effect<ActSuccess, ActFailure>;
	};
	run(automation: string, input: Value | readonly Value[]): AutomationHandle;
	/** Native manual refresh/file transfer; these are never authored automation starts. */
	sync_control(model: string, sync: string, input: Value): RunHandle;
	/** §3.5 `runs(automation, { where?, limit })`; absent until the client serves it (views then say so). */
	runs?(automation: string, options: { where?: Json; limit: number }): Live<Page<RunRow>>;
	file_url(ref: Pick<FileRef, 'id'>, options?: FileUrlOptions): string;
	/** §3.5 rule 11a in the browser: each top-level condition and sort key kept or dropped alone. Absent → the view's own check. */
	decode?(
		model: string,
		q: { where?: Json; order_by?: Json }
	): { where: Json; order_by?: Json; dropped: readonly { path: string; message: string }[] };
	/** Rule 16a `filter.describe`: present only when the host binds `decisions` or `ai` (P19); rejects when no filter could be built. */
	describe?:
		| ((
				model: string,
				text: string,
				fields?: readonly {
					name: string;
					label: string;
					kind: 'text' | 'number' | 'bool';
					optional?: boolean;
				}[]
		  ) => Effect.Effect<{ where?: Json; order_by?: Json }, Error>)
		| undefined;
	/** Rule 16b `filter.options`: the same condition catalogue a description is offered, so the builder renders exactly what it may author. */
	options?(
		model: string,
		fields?: readonly {
			name: string;
			label: string;
			kind: 'text' | 'number' | 'bool';
			optional?: boolean;
		}[]
	): Effect.Effect<{ fields: readonly Offer[] }, Error>;
	approvals: {
		/** Decides the request's current step; `reason` is required for `reject` and `request_changes` (and a superseder's approve). */
		decide(
			request_id: string,
			decision: { decision: ApprovalDecision; reason?: string }
		): Effect.Effect<ActSuccess, ActFailure>;
		/** The approval view: the request, its steps and timeline, and what the viewer may do; `null` when not visible. */
		get(request_id: string): Effect.Effect<ApprovalView | null, Error>;
		/** The approval views the caller may see, open ones unless `all`, by `model`, `records` or request `ids`. */
		list(filter?: {
			model?: string;
			records?: readonly string[];
			ids?: readonly string[];
			all?: boolean;
		}): Effect.Effect<readonly ApprovalView[], Error>;
	};
	actor: Json;
	locale: string;
	t(key: string, vars?: { readonly [name: string]: string | number }): string;
};
