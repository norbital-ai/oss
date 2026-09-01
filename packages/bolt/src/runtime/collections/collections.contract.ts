/**
 * The collections runtime's public contract: the service interface authored code and the client
 * runtime reach against, and the input/error types it is typed with.
 *
 * `collections.ts` implements this interface; `authored.ts` builds the authoring API it prompts
 * against. Both import the contract here rather than each other, so the module graph stays acyclic.
 */
import { Context, Effect, Schema } from 'effect';
import type {
	CollectionMutateRequest,
	CollectionMutationBaseVersion,
	CollectionMutationIdempotencyKey,
	CollectionMutationSettlement,
	CollectionSearch,
	ChangeBatch,
	EffectId,
	SyncChange,
	SyncOutcome,
	SyncWriteStatus
} from '@norbital-ai/bolt-protocol';
import type { Subject } from '#lib/runtime/identity/subject.js';
import type * as Workspace from '#lib/runtime/workspace.js';
import type * as AccessControl from '#lib/runtime/access/access-control.js';
import type * as Database from '#lib/runtime/facilities/database.js';
import type { ApprovalConflict } from '#lib/runtime/approvals/approvals.js';
import type { AuthoredRefusal } from '#lib/authoring/refusal.js';
import type { NestingLimitExceeded } from '#lib/runtime/budget.js';
import type { WhereCompileError } from '#lib/runtime/access/effective-plan.js';

export const CollectionAction = Schema.Literals(['create', 'update', 'delete']);
export type CollectionAction = typeof CollectionAction.Type;

export type QueryInput = Readonly<{
	readonly collection: string;
	// `where` and `orderBy` stay `unknown`: authored handlers bind `Date` operands the wire form
	// never carries, and the where compiler is the one place that decides what is bindable.
	readonly where?: unknown | undefined;
	/** A generic surface's narrowing predicate, kept distinct from the authored predicate. */
	readonly userFilter?: unknown | undefined;
	readonly orderBy?: unknown | undefined;
	readonly limit?: number | undefined;
	/**
	 * Relations to load alongside the rows. Stays `unknown` for the same reason `where` does — the
	 * relational query planner owns what a relation spec may contain.
	 */
	readonly with?: unknown | undefined;
	/** Root projection; relations named by `with` survive independently of this field selection. */
	readonly columns?: Readonly<Record<string, boolean>> | undefined;
	/**
	 * Free text to match across the collection's searchable columns.
	 *
	 * Opt-in per column: a field must declare `search: true`. A collection that declares none is not
	 * searchable, and a search term against it matches nothing rather than quietly scanning
	 * everything — which is the difference between "no results" and "this box does nothing".
	 */
	readonly search?: CollectionSearch | undefined;
	/**
	 * Where the next page starts: the encoded ordering tuple of the previous page's last row.
	 *
	 * A seek, not an offset. Collections here are large, so an offset both degrades as the page index
	 * grows and drifts under concurrent writes — a row inserted before the offset shifts every later
	 * page by one, which shows up as a row seen twice and a row never seen at all.
	 */
	readonly after?: string | undefined;
}>;

/** A collection query always returns records; scalar JSON is not a valid database row. */
export type QueryRow = Readonly<Record<string, Schema.Json>>;

/**
 * A nearest-neighbour read: an ordinary query plus the vector to measure against.
 *
 * It reuses `QueryInput` rather than restating narrowing, because excluding rows from a vector
 * search is not a different question from excluding them from any other read. The removed version
 * carried its own `excludeIds`, which meant a second filtering vocabulary that only this one call
 * understood and that no `where` clause could extend. It also inherited the relational `with`
 * clause, which no vector read carries: a nearest query is one flat page ranked by distance.
 */
export type NearestQueryInput = Omit<QueryInput, 'after' | 'orderBy' | 'search' | 'with'> &
	Readonly<{
		readonly column: string;
		readonly probe: ReadonlyArray<number>;
		readonly metric: 'l2' | 'cosine' | 'ip';
		readonly maxDistance?: number | undefined;
	}>;

/** A nearest-neighbour row carries the measured distance beside the record's own columns. */
type NearestQueryRow = QueryRow & Readonly<{ readonly distance: number }>;

/** One complete authoritative SQL grouping. It has no paging or local-recompute semantics. */
type GroupedQueryInput = Omit<QueryInput, 'limit' | 'after'> &
	Readonly<{
		readonly groupBy: string;
		readonly lanes: ReadonlyArray<Schema.Json>;
	}>;
type GroupedQueryRows = Readonly<Record<string, ReadonlyArray<QueryRow>>>;

export type MutationInput = Readonly<{
	readonly collection: string;
	readonly id: string;
	readonly values: Readonly<Record<string, Schema.Json>>;
}>;

/** Host/authentication facts under which one browser mutation key has meaning. */
export type BrowserMutationScope = Readonly<{
	readonly tenantId: string;
	readonly environment: string;
	readonly principalId: string;
	/** Effective server-resolved authority (ordinary membership or a validated preview team). */
	readonly authorityId: string;
}>;

/** Read-back roots plus the complete committed transition batch for host live-query fan-out. */
export type CollectionMutationCommit = Readonly<{
	readonly records: ReadonlyArray<Readonly<Record<string, unknown>>>;
	readonly batch: ChangeBatch;
}>;

/** The compact durable answer sufficient to replay a browser mutation without executing it. */
export const BrowserMutationOutcome = Schema.TaggedUnion({
	Committed: {
		collection: Schema.NonEmptyString,
		id: Schema.NonEmptyString,
		action: CollectionAction,
		resolution: Schema.Literals(['accepted', 'rebased']),
		fromSchemaFingerprint: Schema.NonEmptyString,
		toSchemaFingerprint: Schema.NonEmptyString
	},
	PendingApproval: {
		requestId: Schema.NonEmptyString,
		collection: Schema.NonEmptyString,
		id: Schema.NonEmptyString,
		action: CollectionAction,
		schemaFingerprint: Schema.NonEmptyString
	},
	VersionConflict: {
		collection: Schema.NonEmptyString,
		id: Schema.NonEmptyString,
		baseVersion: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
		currentVersion: Schema.NullOr(
			Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))
		),
		schemaFingerprint: Schema.NonEmptyString
	},
	Rejected: {
		code: Schema.Literals(['refused', 'forbidden']),
		message: Schema.NonEmptyString,
		schemaFingerprint: Schema.NonEmptyString,
		collection: Schema.optionalKey(Schema.NonEmptyString),
		/** Refusal sites may be more precise than the root verb (for example `mutate.before`). */
		action: Schema.optionalKey(Schema.NonEmptyString)
	},
	Quarantined: {
		idempotencyKey: Schema.NonEmptyString,
		reason: Schema.NonEmptyString,
		schemaFingerprint: Schema.NonEmptyString
	}
});
export type BrowserMutationOutcome = typeof BrowserMutationOutcome.Type;

/** Internal fence passed only after dispatch has authenticated and digested the public request. */
export type BrowserMutationFence = Readonly<{
	readonly scope: BrowserMutationScope;
	readonly idempotencyKey: CollectionMutationIdempotencyKey;
	readonly requestDigest: string;
	readonly issuedAtEpochMs: number;
	readonly partitionKey: string;
	readonly schemaFingerprint: string;
	readonly currentSchemaFingerprint: string;
	readonly baseVersions: ReadonlyArray<CollectionMutationBaseVersion>;
	readonly outcome: BrowserMutationOutcome;
}>;

/** The same key was presented for a different canonical request under the same authority. */
export class MutationIdempotencyConflict extends Schema.TaggedError<MutationIdempotencyConflict>()(
	'Bolt.Collections.MutationIdempotencyConflict',
	{
		idempotencyKey: Schema.NonEmptyString
	}
) {
	readonly retryable = false;
	readonly message = 'The mutation idempotency key is already bound to a different request.';
}

/** A retry arrived after its dedup record may legally have been pruned. */
export class MutationRetryExpired extends Schema.TaggedError<MutationRetryExpired>()(
	'Bolt.Collections.MutationRetryExpired',
	{
		issuedAtEpochMs: Schema.Number
	}
) {
	readonly retryable = false;
	readonly message =
		'The mutation is outside the server retry horizon and cannot be applied safely.';
}

/** Another live invocation owns this key; the client keeps the journal entry and retries it. */
export class MutationInProgress extends Schema.TaggedError<MutationInProgress>()(
	'Bolt.Collections.MutationInProgress',
	{ retryAfterSeconds: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)) }
) {
	readonly retryable = true;
	readonly message = 'The same mutation is still being evaluated by the server.';
}

/** The authoritative row changed after the browser read the version it submitted. */
export class MutationVersionConflict extends Schema.TaggedError<MutationVersionConflict>()(
	'Bolt.Collections.MutationVersionConflict',
	{
		collection: Schema.NonEmptyString,
		id: Schema.NonEmptyString,
		baseVersion: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
		currentVersion: Schema.NullOr(
			Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))
		)
	}
) {
	readonly retryable = false;
	readonly message =
		this.currentVersion === null
			? `${this.collection} ${this.id} no longer exists at row version ${this.baseVersion}.`
			: `${this.collection} ${this.id} changed from row version ${this.baseVersion} to ${this.currentVersion}.`;
}

/**
 * The mutation remains durable client-side because this release cannot safely interpret it.
 *
 * This is not a rejection: removing the overlay would lose user work. A client keeps the journal
 * entry, surfaces one sync issue, and may retry it only after a new release with a matching schema
 * fingerprint is active or after an explicit user resolution.
 */
export class MutationQuarantined extends Schema.TaggedError<MutationQuarantined>()(
	'Bolt.Collections.MutationQuarantined',
	{
		idempotencyKey: Schema.NonEmptyString,
		schemaFingerprint: Schema.NonEmptyString,
		reason: Schema.NonEmptyString
	}
) {
	readonly retryable = false;
	readonly message = this.reason;
}

/**
 * `AuthoredRefusal` is a member of all three channels because authored code runs on all three
 * paths: hooks on every mutation, the import pipeline under `import`, the export pipeline under
 * `export`, and `mutate.after` again when an approval resumes. It is stated rather than left to
 * inference so that a caller which handles these unions exhaustively has to decide what a business
 * rule refusing means for it — which is the distinction the whole change exists to make available.
 */
export type CollectionHistorySnapshot = Readonly<{
	readonly values: Readonly<Record<string, Schema.Json>>;
	readonly validFrom: string;
	readonly validTo: string | null;
	readonly version: number;
}>;

export type CollectionAuditEntry = Readonly<{
	readonly kind: 'data-write' | 'browser-outcome' | 'approval-decision';
	readonly createdAt: string;
	readonly actor: string;
	readonly effectId: string | null;
	readonly governingRequest: string | null;
	readonly payload: Schema.Json;
}>;

export type MutationError =
	| Workspace.WorkspaceLookupError
	| AccessControl.AccessDenied
	| Database.FacilityError
	| ApprovalConflict
	| PendingApproval
	| MutationIdempotencyConflict
	| MutationRetryExpired
	| MutationInProgress
	| MutationVersionConflict
	| MutationQuarantined
	| AuthoredRefusal
	| NestingLimitExceeded;
/**
 * What the batched `mutate` adds, and why it is not a member of `MutationError`.
 *
 * Only the batched `mutate` reports a phase; `delete` unwraps a phase failure to the refusal
 * underneath before returning, so its callers keep an error union that says only what they can
 * actually raise. Widening `MutationError` would have put the phase on `delete`, `import` and
 * `resume` alike: a type that says something false about several paths in order to say something
 * true about one.
 */
export type BatchMutationError = MutationError | MutationPhaseFailure;
/**
 * Resume re-enters the write lifecycle with the stored graph, so it carries the lifecycle's failure
 * classes: the approved re-entry re-checks the browser fence (a row that moved since the hold is a
 * `MutationVersionConflict`), re-verifies the ledger, and can still be refused by authored code or
 * the policy — the same union `mutate` reports, which is the honest statement of what a caller
 * must decide about.
 */
export type { BatchMutationError as ResumeError };

/** Query paths add the where-compiler failure so an unsupported filter surfaces instead of silently widening the result. */
export type QueryError =
	| Workspace.WorkspaceLookupError
	| AccessControl.AccessDenied
	| Database.FacilityError
	| WhereCompileError
	| AuthoredRefusal
	| NestingLimitExceeded;

/** Which of a batch's three phases a failure came out of. */
export const MutationPhase = Schema.Literals(['prepare', 'commit', 'settle']);
export type MutationPhase = typeof MutationPhase.Type;

/** Holds a collection mutation until every required approval step is complete. */
export class PendingApproval extends Schema.TaggedError<PendingApproval>()(
	'Bolt.Collections.PendingApproval',
	{
		requestId: Schema.NonEmptyString,
		collection: Schema.NonEmptyString,
		id: Schema.NonEmptyString,
		action: CollectionAction
	}
) {
	readonly category = 'pending-approval' as const;
	readonly retryable = false;
}

/**
 * Which phase of a batched write failed, wrapped around the failure that says why.
 *
 * The three phases mean three different things to whoever is handling the failure, and until this
 * existed they were indistinguishable — every one of them arrived as whatever error happened to be
 * raised, with no way to tell how much of the write had happened by then.
 *
 * - `prepare` — decode, `prepare`, and the `before` hooks, all outside the transaction. **Nothing
 *   was written.** A caller may retry the whole batch, or show the refusal and stop.
 * - `commit` — the one transaction. It is atomic, so **nothing was written** here either, and a
 *   caller may retry. This is separated from `prepare` because the causes are unalike: a `prepare`
 *   failure is almost always a business rule and a `commit` failure is almost always the database.
 * - `settle` — the read-back, the `after` hooks and the enqueue. **The write already happened.** A
 *   caller must not retry the batch: it would write it a second time. `committed` names the rows
 *   that are now facts so the caller can report or reconcile them.
 *
 * `cause` is kept rather than replaced, and this is the part that matters more than the tag. An
 * `AuthoredRefusal` mapped to a 422 and a `PendingApproval` answered as a 202 are decisions made
 * far downstream by `instanceof`, so a wrapper that swallowed the original would silently turn every
 * business rule in the workspace back into a 500 — the exact regression `AuthoredRefusal` was built
 * to end. `runtime/app.ts` unwraps this before its own mapping runs, so the phase is additive: it
 * adds a fact nobody had, and takes nothing away.
 */
export class MutationPhaseFailure extends Schema.TaggedError<MutationPhaseFailure>()(
	'Bolt.Collections.MutationPhaseFailure',
	{
		phase: MutationPhase,
		/** The exact post-commit operation, when `phase` is `settle`. */
		step: Schema.optionalKey(
			Schema.Literals([
				'wake',
				'sync-commit',
				'after-hook',
				'change-events',
				'embedding-refresh'
			])
		),
		collection: Schema.NonEmptyString,
		committed: Schema.Array(Schema.NonEmptyString),
		cause: Schema.Unknown
	}
) {
	readonly retryable = false;
	/** The failure this wrapped, for a caller that would rather test than unwrap by hand. */
	get underlying(): unknown {
		return this.cause;
	}
}

/**
 * The failure a phase raised, or the phase failure it already is.
 *
 * A batch's phases are entered from `mutate`, which is itself reachable from a hook running inside
 * another batch's `prepare`. Wrapping a wrapper would report the inner batch's phase as the outer
 * one's, so the innermost — the one that actually knows what was written — wins.
 */
export const mutationPhaseFailure = (
	phase: MutationPhase,
	collection: string,
	committed: ReadonlyArray<string>,
	cause: unknown,
	step?: MutationPhaseFailure['step']
): MutationPhaseFailure =>
	cause instanceof MutationPhaseFailure
		? cause
		: new MutationPhaseFailure({
				phase,
				/**
				 * Never the empty string, because this field would rather throw than hold one.
				 *
				 * `collection` is `NonEmptyString`, and a `Schema.TaggedError` whose own field rejects its
				 * value throws from the constructor — with the message "Schema validation failed", no
				 * `_tag`, and no properties at all. Every `instanceof` downstream then misses it, it falls
				 * through to the generic 500, and the failure this was built to *carry* is destroyed by the
				 * act of wrapping it. A wrapper that can annihilate its own cause is worse than no wrapper,
				 * and an unnamed collection is a far smaller loss than the reason the write failed.
				 */
				collection: collection.trim() === '' ? '(unnamed collection)' : collection,
				committed,
				cause,
				...(step === undefined ? {} : { step })
			});

type MutationRoot = Readonly<{ readonly id: string; readonly action: 'create' | 'update' }>;

type MutateOptions = {
	/** Explicit only for an invocation-bound create/update whose chosen id must not imply action. */
	readonly root?: MutationRoot;
	/** Exact root identities/actions for a multi-root atomic invocation such as an import chunk. */
	readonly roots?: ReadonlyArray<MutationRoot>;
	/** Browser-only exactly-once fence; authored callers never construct or receive this. */
	readonly browserMutation?: BrowserMutationFence;
};

export type Interface = Readonly<{
	/** Exact tenant-authored collection names plus the one generic system exception. */
	readonly authoringCollectionNames: ReadonlySet<string>;
	/**
	 * Runs an authored automation in the current I/O flow, or admits its explicit delay.
	 * Kept on the collections runtime because the handler receives this same collection API.
	 */
	readonly runAutomation: (
		effectId: EffectId,
		name: string,
		input: Schema.Json,
		scope?: Readonly<Record<string, Schema.Json>>,
		options?: Readonly<{
			readonly after?: string | number;
			readonly taskId?: string;
			readonly parentDepth?: number;
		}>
	) => Effect.Effect<{ readonly taskId: string }, unknown>;
	readonly findMany: (
		effectId: EffectId,
		subject: Subject,
		input: QueryInput
	) => Effect.Effect<ReadonlyArray<QueryRow>, QueryError>;
	readonly findFirst: (
		effectId: EffectId,
		subject: Subject,
		input: QueryInput
	) => Effect.Effect<QueryRow | undefined, QueryError>;
	readonly count: (
		effectId: EffectId,
		subject: Subject,
		input: QueryInput
	) => Effect.Effect<number, QueryError>;
	readonly findNearest: (
		effectId: EffectId,
		subject: Subject,
		input: NearestQueryInput
	) => Effect.Effect<ReadonlyArray<NearestQueryRow>, QueryError>;
	/**
	 * Fills in missing record embeddings for every collection that declares one.
	 *
	 * A backfill rather than only a write-path hook, because rows arrive without passing through
	 * `mutate`: the seed loader writes its corpus as bulk SQL, so a workspace can be fully populated
	 * and hold no vectors at all. Bounded per call and re-runnable — it selects only rows whose
	 * embedding is null, so calling it twice embeds nothing twice.
	 */
	readonly embedRecords: (
		effectId: EffectId,
		limit?: number
	) => Effect.Effect<
		ReadonlyArray<{ readonly collection: string; readonly embedded: number }>,
		QueryError
	>;
	readonly findGrouped: (
		effectId: EffectId,
		subject: Subject,
		input: GroupedQueryInput
	) => Effect.Effect<GroupedQueryRows, QueryError>;
	/**
	 * The batched write, and the one every batch goes through.
	 *
	 * On the interface rather than only behind the authoring api because it is not an authoring
	 * convenience: it is the write path, and a command surface that wants a batch should reach the
	 * same one a hook does rather than loop a single create.
	 */
	readonly mutate: (
		effectId: EffectId,
		subject: Subject,
		collection: string,
		payloads: ReadonlyArray<Readonly<Record<string, unknown>>>,
		elevated?: boolean,
		depth?: number,
		options?: MutateOptions
	) => Effect.Effect<CollectionMutationCommit, BatchMutationError>;
	readonly delete: (
		effectId: EffectId,
		subject: Subject,
		collection: string,
		id: string,
		options?: Readonly<{
			readonly baseVersion?: number;
			readonly browserMutation?: BrowserMutationFence;
		}>
	) => Effect.Effect<CollectionMutationCommit, MutationError>;
	/** Commits made anywhere in this invocation, drained once by the bundle boundary. */
	readonly drainChanges: Effect.Effect<ReadonlyArray<SyncChange>>;
	readonly mutateBrowser: (
		effectId: EffectId,
		actor: Subject,
		subject: Subject,
		impersonatedTeam: string | null,
		input: CollectionMutateRequest
	) => Effect.Effect<CollectionMutationSettlement, unknown>;
	readonly lookupBrowserMutations: (
		effectId: EffectId,
		actor: Subject,
		subject: Subject,
		impersonatedTeam: string | null,
		ids: ReadonlyArray<CollectionMutationIdempotencyKey>
	) => Effect.Effect<ReadonlyArray<SyncOutcome>, Database.FacilityError>;
	readonly resume: (effectId: EffectId, requestId: string) => Effect.Effect<void, ResumeError>;
	readonly discard: (effectId: EffectId, requestId: string) => Effect.Effect<void, ResumeError>;
	readonly import: (
		effectId: EffectId,
		subject: Subject,
		inputs: ReadonlyArray<MutationInput>
	) => Effect.Effect<number, MutationError>;
	readonly export: (
		effectId: EffectId,
		subject: Subject,
		input: QueryInput
	) => Effect.Effect<ReadonlyArray<Schema.Json>, QueryError>;
	readonly history: (
		effectId: EffectId,
		subject: Subject,
		collection: string,
		id: string
	) => Effect.Effect<ReadonlyArray<CollectionHistorySnapshot>, QueryError>;
	readonly audit: (
		effectId: EffectId,
		subject: Subject,
		collection: string,
		id: string,
		limit?: number
	) => Effect.Effect<ReadonlyArray<CollectionAuditEntry>, QueryError>;
}>;

export const Service = Context.Service<Interface>('@norbital-ai/bolt/Collections');
