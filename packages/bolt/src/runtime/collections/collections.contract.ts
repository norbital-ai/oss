/**
 * The collections runtime's public contract: the service interface authored code and the client
 * runtime reach against, and the input/error types it is typed with.
 *
 * `collections.ts` implements this interface; `authored.ts` builds the authoring API it prompts
 * against. Both import the contract here rather than each other, so the module graph stays acyclic.
 */
import { Context, Effect, Schema } from 'effect';
import type { EffectId } from '@norbital-ai/bolt-protocol';
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
	readonly orderBy?: unknown | undefined;
	readonly limit?: number | undefined;
	/**
	 * Relations to load alongside the rows. Stays `unknown` for the same reason `where` does — the
	 * prefetch resolver owns what a relation spec may contain.
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

export type MutationInput = Readonly<{
	readonly collection: string;
	readonly id: string;
	readonly values: Readonly<Record<string, Schema.Json>>;
}>;

/**
 * One nearest-neighbour read against a pgvector column.
 *
 * The operands stay `unknown` for the reason `QueryInput.where` does: they arrive from authored
 * code, and the one place that decides what a vector search may be given is the place that renders
 * the SQL for it. Everything here was previously spread into an ordinary `findMany`, which knows no
 * `column`, no `probe` and no `metric` — so the whole config was dropped on the floor and the caller
 * received the collection's first hundred rows as its "nearest" neighbours.
 */
export type NearestInput = Readonly<{
	readonly collection: string;
	readonly column: unknown;
	readonly probe: unknown;
	readonly metric: unknown;
	readonly limit: unknown;
	readonly maxDistance?: unknown;
	readonly excludeIds?: unknown;
}>;

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
	| AuthoredRefusal
	| NestingLimitExceeded;
/**
 * What the *batched* path adds, and why it is not a member of `MutationError`.
 *
 * Only `mutate` runs in phases, so only `mutate` can say which one failed. Widening `MutationError`
 * would have put the phase on `create`, `update`, `delete`, `import` and `resume` as well, and on
 * every service that declares an error union containing theirs — `sync.mutate` and `agents.execute`
 * both do — none of which can ever raise it. That is a type that says something false about five
 * paths in order to say something true about one.
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
				collection,
				committed,
				cause,
				...(step === undefined ? {} : { step })
			});

export type Interface = Readonly<{
	readonly findMany: (
		effectId: EffectId,
		subject: Subject,
		input: QueryInput
	) => Effect.Effect<ReadonlyArray<Schema.Json>, QueryError>;
	/** Reads the approval inbox through the same authorization and field-masking path as collections. */
	readonly approvalFindFirst: (
		effectId: EffectId,
		subject: Subject,
		input: Omit<QueryInput, 'collection'>
	) => Effect.Effect<Schema.Json | undefined, QueryError>;
	readonly findFirst: (
		effectId: EffectId,
		subject: Subject,
		input: QueryInput
	) => Effect.Effect<Schema.Json | undefined, QueryError>;
	readonly findNearest: (
		effectId: EffectId,
		subject: Subject,
		input: NearestInput
	) => Effect.Effect<ReadonlyArray<Schema.Json>, QueryError>;
	readonly count: (
		effectId: EffectId,
		subject: Subject,
		input: QueryInput
	) => Effect.Effect<number, QueryError>;
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
		id: string
	) => Effect.Effect<void, MutationError>;
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
