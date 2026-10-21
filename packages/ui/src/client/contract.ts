// The structural client boundary supplied by a host; UI has no Bolt package dependency.
import type { Effect, Stream } from 'effect';
import type { Json } from '@norbital-ai/std/wire';
import type { Value, FileRef, FileUrlOptions } from '@norbital-ai/std/kind';
import type { Page, Row, Values } from '../collection/types.js';
import type { RecordCapabilities, RecordParentContext, RestorePreview } from '../record/types.js';
import type { Offer } from '../filter/filter.js';
export type { Json } from '@norbital-ai/std/wire';
export type { FileRef } from '@norbital-ai/std/kind';
export type WireRead = {
	m:
		| 'read'
		| 'inbox'
		| 'get'
		| 'aggregate'
		| 'similar'
		| 'history'
		| 'query'
		| 'transcript'
		| 'conversations';
	a: readonly Json[];
};
export type ReadError = Error &
	(
		| { readonly _tag: 'ReadFailed'; readonly code: string; readonly message: string }
		| { readonly _tag: 'TransportFailed'; readonly status: number; readonly message: string }
	);
export type Q<T> = Effect.Effect<T, ReadError> & { readonly read: WireRead };
export type LiveError = Error & { code: string; message: string };
export type Live<T> = Stream.Stream<T, LiveError | ReadError>;
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
	| { kind: 'unknown'; invocation: string };
/** Fields needed to present an outcome; actions may return any typed output. */
export type ActSuccess = Extract<Outcome, { kind: 'committed' | 'pendingApproval' }>;
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
/** `start`'s answer: the run's id and automation at once, its start's outcome when awaited. */
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

/** An approval move as `approvals.process` names it (the host's state machine decides which a viewer may take). */
export type ApprovalStatus =
	| 'APPROVED'
	| 'REJECTED'
	| 'REQUEST_FOR_CHANGE'
	| 'RESUBMITTED'
	| 'WITHDRAWN'
	| 'SUPERSEDED'
	| 'COMMENT'
	/** An administrator closes a request whose collection or record a release removed (it ends Withdrawn). */
	| 'CLOSED';
type ApprovalWho = { ref: string; name: string | null };
/** One approval request as its participants and authorized record readers see it; the host decides every move. */
export type ApprovalView = {
	id: string;
	collection: string;
	record: string;
	action: string;
	at: string;
	/** ONGOING, CHANGES_REQUESTED, APPROVED, REJECTED, WITHDRAWN or SUPERSEDED. */
	status: string;
	step: number;
	steps: readonly (readonly string[])[];
	superseded_by: readonly string[];
	/** Current source labels; captured handles and native eligibility remain authoritative. */
	teamNames: Readonly<Record<string, string>>;
	requestor: ApprovalWho;
	/** Every interaction, oldest first: the request, each transition, each comment, with what a rollback did. */
	log: readonly {
		move:
			| 'request'
			| 'approve'
			| 'reject'
			| 'requestChanges'
			| 'resubmit'
			| 'withdraw'
			| 'supersede'
			| 'comment'
			| 'close';
		by: ApprovalWho;
		at: string;
		from: string | null;
		to: string;
		step: number;
		reason: string | null;
		rolledBack?:
			| readonly { collection: string; id: string; action: 'restored' | 'removed' | 'recreated' }[]
			| undefined;
		skipped?:
			readonly { collection: string; id: string; field: string; reason: string }[] | undefined;
	}[];
	/** The records the provisional change holds: committed already, rolled back on rejection or withdrawal. */
	records: readonly { collection: string; id: string; op: 'create' | 'update' | 'delete' }[];
	/** The moves this viewer may take now, straight from the host's transition table. */
	moves: readonly { status: ApprovalStatus; reason: 'required' | 'optional' }[];
	mine: boolean;
	participant: boolean;
};
/** A row an open approval request holds carries it as `$approval` (step counts from 0). */
export type RowApproval = {
	readonly requestId: string;
	readonly state: 'Pending' | 'ChangesRequested';
	readonly step: number;
	readonly steps: number;
	readonly requestedBy: string;
	readonly waitingOn: readonly string[];
};
/** The client a view reads and acts through (the page's `$bolt`), as `provideBolt` hands it to the views. */
export type ViewBolt = {
	read<T = Page>(collection: string, options: Value): Q<T>;
	/** `{ revision }`: the record as of that revision (L-BOLT-181), for the record shell's scrubber. */
	get<T = Row | null>(
		collection: string,
		id: string,
		select?: Json,
		options?: { revision?: number }
	): Q<T>;
	aggregate<T = readonly Values[]>(collection: string, options: Value): Q<T>;
	history<T = Json>(collection: string, id: string, options?: { at?: Json }): Q<T>;
	query<T = Json>(name: string, input: Value): Q<T>;
	/** A named similarity search (§3.3.4): `similar(c, '<name>', input, { where?, select?, limit })`, nearest first. */
	similar?<T = readonly Row[]>(
		collection: string,
		search: string,
		input: Value,
		options: Value
	): Q<T>;
	live<T>(q: Q<T>, options?: { every?: string; on?: readonly string[] }): Live<T>;
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
		/** One move of the request's state machine; `reason` is the decision's reason, the comment or the resubmit note. */
		process(
			requestId: string,
			decision: { status: ApprovalStatus; reason?: string }
		): Effect.Effect<ActSuccess, ActFailure>;
		/** The approval view (§3.8): the request, its flow and decisions, and what the viewer may do; `null` when not visible. */
		get?(requestId: string): Effect.Effect<ApprovalView | null, Error>;
		/** The approval views the caller may see, open ones unless `all`, by `collection`, `records` or request `ids`. */
		list?(filter?: {
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
