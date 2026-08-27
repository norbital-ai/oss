/**
 * The collections runtime's public contract: the service interface authored code and the client
 * runtime reach against, and the input/error types it is typed with.
 *
 * `collections.ts` implements this interface; `authored.ts` builds the authoring API it prompts
 * against. Both import the contract here rather than each other, so the module graph stays acyclic.
 */
import { Context, Effect, Schema } from 'effect';
import type {
	CollectionMutationBaseVersion,
	CollectionMutationIdempotencyKey,
	EffectId
} from '@norbital-ai/bolt-protocol';
import type { Subject } from '#lib/runtime/identity/subject.js';
import type * as Workspace from '#lib/runtime/workspace.js';
import type * as AccessControl from '#lib/runtime/access/access-control.js';
import type * as Database from '#lib/runtime/facilities/database.js';
import type { ApprovalConflict } from '#lib/runtime/approvals/approvals.js';
import type { AuthoredRefusal } from '#lib/authoring/refusal.js';
import type { NestingLimitExceeded } from '#lib/runtime/budget.js';
import type { WhereCompileError } from '#lib/runtime/collections/where.js';

export const Predicate = Schema.TaggedUnion({
	Equal: { field: Schema.NonEmptyString, value: Schema.Json },
	NotEqual: { field: Schema.NonEmptyString, value: Schema.Json },
	GreaterThan: { field: Schema.NonEmptyString, value: Schema.Json },
	In: { field: Schema.NonEmptyString, values: Schema.Array(Schema.Json) }
});
export type Predicate = typeof Predicate.Type;

export const CollectionAction = Schema.Literals(['create', 'update', 'delete']);
export type CollectionAction = typeof CollectionAction.Type;

export type QueryInput = Readonly<{
	readonly collection: string;
	readonly predicate?: Predicate;
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
	/**
	 * Free text to match across the collection's searchable columns.
	 *
	 * Opt-in per column: a field must declare `search: true`. A collection that declares none is not
	 * searchable, and a search term against it matches nothing rather than quietly scanning
	 * everything — which is the difference between "no results" and "this box does nothing".
	 */
	readonly search?: string | undefined;
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
 * understood and that no `where` clause could extend.
 */
export type NearestQueryInput = Omit<QueryInput, 'after' | 'orderBy' | 'search'> &
	Readonly<{
		readonly column: string;
		readonly probe: ReadonlyArray<number>;
		readonly metric: 'l2' | 'cosine' | 'ip';
		readonly maxDistance?: number | undefined;
	}>;

/** A nearest-neighbour row carries the measured distance beside the record's own columns. */
export type NearestQueryRow = QueryRow & Readonly<{ readonly distance: number }>;

/** One complete authoritative SQL grouping. It has no paging or local-recompute semantics. */
export type GroupedQueryInput = Omit<QueryInput, 'limit' | 'after'> &
	Readonly<{
		readonly groupBy: string;
		readonly lanes: ReadonlyArray<Schema.Json>;
	}>;
export type GroupedQueryRows = Readonly<Record<string, ReadonlyArray<QueryRow>>>;

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
	readonly command: 'collections.mutate';
}>;

/** Stable authenticated identities to which one server-issued physical partition is bound. */
export type BrowserMutationPartitionBinding = Readonly<{
	readonly tenantId: string;
	readonly environment: string;
	readonly actorId: string;
	readonly effectiveSubjectId: string;
	readonly impersonationBinding: string;
}>;

/** Structural twin of SyncPartitionIdentity kept here to avoid a runtime service dependency cycle. */
export type BrowserMutationPartitionIdentity = Readonly<{
	readonly key: string;
	readonly tenantId: string;
	readonly environment: string;
	readonly effectivePolicyHolder: string;
	readonly impersonationTarget: string | null;
	readonly authorityGeneration: number;
	readonly schemaFingerprint: string;
}>;

/** An authenticated mutation whose complete committed outbox transaction is below this cursor. */
export type BrowserMutationConfirmation = Readonly<{
	readonly mutationId: string;
	readonly cursor: Readonly<{ readonly xid: number; readonly sequence: number }>;
}>;
/** A terminal approval refusal for an authenticated mutation awaiting authoritative delivery. */
export type BrowserMutationRejection = Readonly<{
	readonly mutationId: string;
	readonly code: 'refused' | 'forbidden';
	readonly message: string;
}>;
export type BrowserMutationDelivery = Readonly<{
	readonly ownedMutationIds: ReadonlyArray<string>;
	readonly confirmations: ReadonlyArray<BrowserMutationConfirmation>;
	readonly rejections: ReadonlyArray<BrowserMutationRejection>;
}>;

/** The compact durable answer sufficient to replay a browser mutation without executing it. */
export const BrowserMutationOutcome = Schema.TaggedUnion({
	Committed: {
		collection: Schema.NonEmptyString,
		id: Schema.NonEmptyString,
		action: CollectionAction,
		resolution: Schema.Literals(['accepted', 'rebased']),
		deviceSequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
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
		/** Refusal sites may be more precise than the root verb (for example `update.before`). */
		action: Schema.optionalKey(Schema.NonEmptyString)
	},
	Quarantined: {
		idempotencyKey: Schema.NonEmptyString,
		reason: Schema.NonEmptyString,
		deviceSequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
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
	readonly deviceSequence: number;
	readonly partitionKey: string;
	readonly schemaFingerprint: string;
	readonly currentSchemaFingerprint: string;
	readonly baseVersions: ReadonlyArray<CollectionMutationBaseVersion>;
	readonly outcome: BrowserMutationOutcome;
}>;

export const BrowserMutationBegin = Schema.TaggedUnion({
	Acquired: {},
	Replay: { outcome: BrowserMutationOutcome },
	InProgress: { retryAfterSeconds: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)) }
});
export type BrowserMutationBegin = typeof BrowserMutationBegin.Type;

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
 * entry, surfaces one sync issue, and may retry it only after a release with a matching adapter is
 * active or after an explicit user resolution.
 */
export class MutationQuarantined extends Schema.TaggedError<MutationQuarantined>()(
	'Bolt.Collections.MutationQuarantined',
	{
		idempotencyKey: Schema.NonEmptyString,
		deviceSequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
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
 * `export`, and `create.after` again when an approval resumes. It is stated rather than left to
 * inference so that a caller which handles these unions exhaustively has to decide what a business
 * rule refusing means for it — which is the distinction the whole change exists to make available.
 */
export type CollectionHistorySnapshot = Readonly<{
	readonly values: Readonly<Record<string, Schema.Json>>;
	readonly validFrom: string;
	readonly validTo: string | null;
	readonly version: number;
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
 * What the *batched* path adds, and why it is not a member of `MutationError`.
 *
 * Only the batched `mutate` reports a phase. `update` runs a graph too now, but it unwraps a phase
 * failure to the refusal underneath before returning, so its callers — `agents.execute` among them —
 * keep an error union that says only what they can actually raise. Widening `MutationError` would
 * have put the phase on `create`, `update`, `delete`, `import` and `resume` alike: a type that says
 * something false about five paths in order to say something true about one.
 */
export type BatchMutationError = MutationError | MutationPhaseFailure;
export type ResumeError =
	| Workspace.WorkspaceLookupError
	| AccessControl.AccessDenied
	| Database.FacilityError
	| ApprovalConflict
	| AuthoredRefusal
	| MutationPhaseFailure
	| NestingLimitExceeded;

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
		step: Schema.optionalKey(Schema.Literals(['wake', 'after-hook', 'change-events'])),
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

export type Interface = Readonly<{
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
	readonly findGrouped: (
		effectId: EffectId,
		subject: Subject,
		input: GroupedQueryInput
	) => Effect.Effect<GroupedQueryRows, QueryError>;
	readonly create: (
		effectId: EffectId,
		subject: Subject,
		input: MutationInput
	) => Effect.Effect<void, MutationError>;
	readonly createMany: (
		effectId: EffectId,
		subject: Subject,
		inputs: ReadonlyArray<MutationInput>
	) => Effect.Effect<void, MutationError>;
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
		options?: {
			readonly batchSize?: number;
			readonly declarative?: boolean;
			/** Explicit only for an invocation-bound create/update whose chosen id must not imply action. */
			readonly root?: Readonly<{ readonly id: string; readonly action: 'create' | 'update' }>;
			/** Browser-only exactly-once fence; authored callers never construct or receive this. */
			readonly browserMutation?: BrowserMutationFence;
		}
	) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, BatchMutationError>;
	readonly update: (
		effectId: EffectId,
		subject: Subject,
		input: MutationInput
	) => Effect.Effect<void, MutationError>;
	readonly delete: (
		effectId: EffectId,
		subject: Subject,
		collection: string,
		id: string,
		options?: Readonly<{
			readonly baseVersion?: number;
			readonly browserMutation?: BrowserMutationFence;
		}>
	) => Effect.Effect<void, MutationError>;
	readonly browserMutationOutcome: (
		effectId: EffectId,
		scope: BrowserMutationScope,
		idempotencyKey: CollectionMutationIdempotencyKey,
		requestDigest: string
	) => Effect.Effect<
		BrowserMutationOutcome | undefined,
		Database.FacilityError | MutationIdempotencyConflict
	>;
	readonly registerBrowserMutationPartition: (
		effectId: EffectId,
		binding: BrowserMutationPartitionBinding,
		identity: BrowserMutationPartitionIdentity
	) => Effect.Effect<BrowserMutationPartitionIdentity, Database.FacilityError>;
	readonly browserMutationPartition: (
		effectId: EffectId,
		binding: BrowserMutationPartitionBinding,
		partitionKey: string
	) => Effect.Effect<BrowserMutationPartitionIdentity | undefined, Database.FacilityError>;
	readonly browserMutationDelivery: (
		effectId: EffectId,
		scope: BrowserMutationScope,
		idempotencyKeys: ReadonlyArray<string>,
		through: Readonly<{ readonly xid: number; readonly sequence: number }>
	) => Effect.Effect<BrowserMutationDelivery, Database.FacilityError>;
	readonly rememberBrowserMutationOutcome: (
		effectId: EffectId,
		fence: BrowserMutationFence,
		outcome: BrowserMutationOutcome
	) => Effect.Effect<
		BrowserMutationOutcome | undefined,
		Database.FacilityError | MutationIdempotencyConflict
	>;
	readonly beginBrowserMutation: (
		effectId: EffectId,
		fence: BrowserMutationFence
	) => Effect.Effect<BrowserMutationBegin, Database.FacilityError | MutationIdempotencyConflict>;
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
}>;

export const Service = Context.Service<Interface>('@norbital-ai/bolt/Collections');
