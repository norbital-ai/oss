import { Context, Effect, Layer, Number as ENumber, Result, Schema } from 'effect';
import { and, asc, eq, exists, gt, inArray, isNotNull, lt, max, or } from 'drizzle-orm';
import { sha256Json } from '@norbital-ai/std/reckon/hash';
import {
	EffectId,
	PROTOCOL_VERSION,
	SyncSchemaFacts,
	WireError
} from '@norbital-ai/bolt-protocol';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import {
	digestSchemaSteps,
	replicaProvisioningSteps
} from '#lib/compiler/schema-plan.js';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import * as Database from '#lib/runtime/facilities/database.js';
import type * as Identity from '#lib/runtime/identity/identity.js';
import * as TenantScope from '#lib/runtime/tenant.js';
import * as Workspace from '#lib/runtime/workspace.js';
import { decodeReferenceRow } from '#lib/runtime/collections/references.js';
import { isReplicatedCollection } from '#lib/runtime/schema/system-collections.js';
import * as Compaction from '#lib/runtime/sync/compaction.js';
import {
	aliased,
	coalesce,
	commitHorizon,
	composer,
	executeBuilt,
	jsonArrayContainsAny,
	jsonRecord,
	nothing,
	one,
	onlyWhen,
	syncReplayEventBytes,
	syncCursorJson
} from '#lib/runtime/persistence.js';

const JsonObject = Schema.Record(Schema.String, Schema.Json);
const {
	bolt_sync_generation: syncGeneration,
	bolt_sync_horizon: syncHorizon,
	bolt_sync_outbox: syncOutbox
} = SYSTEM_MODEL_TABLES;

/** The `Schema.Json` predicate, built once: it is consulted for every value crossing the facility seam. */
const isJson = Schema.is(Schema.Json);
const isJsonObject = Schema.is(JsonObject);

/**
 * The newest transaction id that is guaranteed to have no earlier writer still running.
 *
 * `pg_snapshot_xmin` of the current snapshot is the oldest transaction still in flight, so every row
 * strictly below it belongs to a transaction that has finished. Reading under this horizon is what
 * turns an insert-ordered log into a commit-ordered stream. It costs latency exactly equal to the
 * longest open write transaction, and that is the trade the alternative does not offer: without it
 * the log is fast and lossy.
 */
const COMMIT_HORIZON = commitHorizon();

/** Orders two cursors the way the outbox does. */
export const compareSyncCursors = (left: SyncCursor, right: SyncCursor): number =>
	left.xid === right.xid ? left.sequence - right.sequence : left.xid - right.xid;

export const SyncCursor = Schema.Struct({
	xid: Schema.Number.check(Schema.isInt()),
	sequence: Schema.Number.check(Schema.isInt())
});
export interface SyncCursor extends Schema.Schema.Type<typeof SyncCursor> {}

/**
 * PostgreSQL returns `bigint` columns as decimal strings through `pg`, while the in-memory test
 * facility and JSON expressions return numbers. Both are the same database fact; normalize them at
 * the database boundary so the public cursor remains the precise numeric wire shape above.
 */
const DatabaseInteger = Schema.Union([Schema.Number, Schema.NumberFromString]).check(
	Schema.isInt()
);
const DatabaseSyncCursor = Schema.Struct({
	...SyncCursor.fields,
	xid: DatabaseInteger,
	sequence: DatabaseInteger
});
export const decodeDatabaseSyncCursor = Schema.decodeUnknownEffect(DatabaseSyncCursor);

/** At most this many distinct dependency collections may be mounted in one partition pull. */
export const MAX_SYNC_PARTITION_COLLECTIONS = 64;
/** Rows examined by a pull when the caller does not choose a smaller window. */
export const DEFAULT_SYNC_PULL_LIMIT = 200;
/** A single pull cannot opt out of row backpressure by naming an arbitrarily large window. */
export const MAX_SYNC_PULL_LIMIT = 500;
/** Approximate serialized patch weight accepted by a pull when no budget is supplied. */
export const DEFAULT_SYNC_PULL_MAX_BYTES = 512 * 1024;
/** A single pull cannot opt out of backpressure by naming an arbitrarily large byte budget. */
export const MAX_SYNC_PULL_MAX_BYTES = 2 * 1024 * 1024;
/** Physical work bound for replay-cost probing; it is not a history or replay cutoff. */
export const MAX_SYNC_REPLAY_COST_SCAN_EVENTS = 2_048;
/** Server-owned A×P×B fallback when a client has no durable active-window estimate yet. */
export const DEFAULT_SYNC_REHYDRATION_ACTIVE_WINDOWS = 8;
export const DEFAULT_SYNC_REHYDRATION_ROWS_PER_WINDOW = 100;
export const DEFAULT_SYNC_REHYDRATION_ESTIMATED_BYTES_PER_ROW = 4_096;
export const DEFAULT_SYNC_REHYDRATE_BYTES =
	DEFAULT_SYNC_REHYDRATION_ACTIVE_WINDOWS *
	DEFAULT_SYNC_REHYDRATION_ROWS_PER_WINDOW *
	DEFAULT_SYNC_REHYDRATION_ESTIMATED_BYTES_PER_ROW;
/** Untrusted client cost facts are useful only inside conservative allocation bounds. */
export const MAX_SYNC_ACTIVE_WINDOWS = 256;
export const MAX_SYNC_ROWS_PER_WINDOW = 500;
export const MAX_SYNC_ESTIMATED_ROW_BYTES = 1024 * 1024;
export const MAX_SYNC_PENDING_MUTATIONS = 256;
export const MAX_SYNC_MUTATION_ID_LENGTH = 256;

const SyncPartitionCollections = Schema.Array(Schema.NonEmptyString).check(
	Schema.isNonEmpty(),
	Schema.makeFilter(
		(collections) =>
			collections.length <= MAX_SYNC_PARTITION_COLLECTIONS ||
			`at most ${MAX_SYNC_PARTITION_COLLECTIONS} sync dependency collections are accepted`
	),
	Schema.makeFilter((collections) => {
		return (
			new Set(collections).size === collections.length ||
			'a sync pull cannot declare a dependency collection twice'
		);
	})
);

export const SyncCollectionGenerations = Schema.Record(
	Schema.NonEmptyString,
	Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
).check(
	Schema.makeFilter(
		(generations) =>
			Object.keys(generations).length <= MAX_SYNC_PARTITION_COLLECTIONS ||
			`at most ${MAX_SYNC_PARTITION_COLLECTIONS} sync collection generations are accepted`
	)
);
export interface SyncCollectionGenerations
	extends Schema.Schema.Type<typeof SyncCollectionGenerations> {}

/** The complete, server-derived security and schema coordinate for one replica namespace. */
export const SyncPartitionIdentity = Schema.Struct({
	key: Schema.NonEmptyString,
	tenantId: Schema.NonEmptyString,
	environment: Schema.NonEmptyString,
	effectivePolicyHolder: Schema.NonEmptyString,
	impersonationTarget: Schema.NullOr(Schema.NonEmptyString),
	authorityGeneration: Schema.Number.check(
		Schema.isInt(),
		Schema.isGreaterThanOrEqualTo(0)
	),
	schemaFingerprint: Schema.NonEmptyString
});
export interface SyncPartitionIdentity
	extends Schema.Schema.Type<typeof SyncPartitionIdentity> {}

/** A canonical read position captured before an authoritative page query executes. */
export const SyncPartitionPosition = Schema.Struct({
	partition: SyncPartitionIdentity,
	cursor: SyncCursor,
	generations: SyncCollectionGenerations
});
export interface SyncPartitionPosition
	extends Schema.Schema.Type<typeof SyncPartitionPosition> {}

/** Bounded aggregate facts; query identities and window keys never become history coordinates. */
export const SyncRehydrationCost = Schema.Struct({
	activeWindows: Schema.Number.check(
		Schema.isInt(),
		Schema.isGreaterThanOrEqualTo(0),
		Schema.isLessThanOrEqualTo(MAX_SYNC_ACTIVE_WINDOWS)
	),
	rowsPerWindow: Schema.Number.check(
		Schema.isInt(),
		Schema.isGreaterThan(0),
		Schema.isLessThanOrEqualTo(MAX_SYNC_ROWS_PER_WINDOW)
	),
	estimatedBytesPerRow: Schema.Number.check(
		Schema.isInt(),
		Schema.isGreaterThan(0),
		Schema.isLessThanOrEqualTo(MAX_SYNC_ESTIMATED_ROW_BYTES)
	)
});
export interface SyncRehydrationCost
	extends Schema.Schema.Type<typeof SyncRehydrationCost> {}

const SyncMutationId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_SYNC_MUTATION_ID_LENGTH)
);
export const SyncPendingMutationIds = Schema.Array(SyncMutationId).check(
	Schema.makeFilter(
		(ids) =>
			ids.length <= MAX_SYNC_PENDING_MUTATIONS ||
			`at most ${MAX_SYNC_PENDING_MUTATIONS} pending mutation ids are accepted`
	),
	Schema.makeFilter(
		(ids) => new Set(ids).size === ids.length || 'a sync status request cannot repeat a mutation id'
	)
);

/** Authenticated write-only status lookup; it deliberately accepts no collection dependency. */
export const SyncPartitionStatusRequest = Schema.Struct({
	pendingMutationIds: Schema.optionalKey(SyncPendingMutationIds)
});
export interface SyncPartitionStatusRequest
	extends Schema.Schema.Type<typeof SyncPartitionStatusRequest> {}

/**
 * Private Bolt projections whose internal browser surfaces stay live by invalidation only.
 *
 * These names never enter `shape`, partition generations, replica provisioning, row deltas, or the
 * authored API. They are fixed here so an SSE query parameter cannot turn an arbitrary private
 * system table into an observable change signal. The guest still authenticates the subject and
 * verifies its internal read predicate before admitting the stream.
 */
const SYNC_INVALIDATION_ONLY_COLLECTIONS = Object.freeze([
	'agent_mailbox',
	'agent_run',
	'automation_run',
	'chat_message',
	'chat_session'
] as const);
const SyncInvalidationOnlyCollections = Schema.Array(Schema.NonEmptyString).check(
	Schema.makeFilter(
		(names) =>
			names.length <= SYNC_INVALIDATION_ONLY_COLLECTIONS.length ||
			`at most ${SYNC_INVALIDATION_ONLY_COLLECTIONS.length} private invalidation collections are accepted`
	),
	Schema.makeFilter(
		(names) =>
			new Set(names).size === names.length ||
			'a sync subscription cannot repeat a private invalidation collection'
	)
);

/**
 * The public pull request, excluding the subject the dispatch boundary authenticates and injects.
 *
 * Collections are dependency subscriptions, not query/page identities. The one cursor and generation
 * map are durable O6 positions for the whole O2 partition.
 */
export const SyncPullRequest = Schema.Struct({
	collections: SyncPartitionCollections,
	/** Fixed internal names authenticated by the guest; no rows or replica positions exist for them. */
	invalidations: Schema.optionalKey(SyncInvalidationOnlyCollections),
	cursor: Schema.NullOr(SyncCursor),
	generations: SyncCollectionGenerations,
	rehydration: Schema.optionalKey(SyncRehydrationCost),
	pendingMutationIds: Schema.optionalKey(SyncPendingMutationIds),
	limit: Schema.optionalKey(
		Schema.Number.check(
			Schema.isInt(),
			Schema.isGreaterThan(0),
			Schema.isLessThanOrEqualTo(MAX_SYNC_PULL_LIMIT)
		)
	),
	maxBytes: Schema.optionalKey(
		Schema.Number.check(
			Schema.isInt(),
			Schema.isGreaterThan(0),
			Schema.isLessThanOrEqualTo(MAX_SYNC_PULL_MAX_BYTES)
		)
	)
});
export interface SyncPullRequest extends Schema.Schema.Type<typeof SyncPullRequest> {}

const SyncDeltaBase = {
	cursor: SyncCursor,
	collection: Schema.NonEmptyString,
	recordId: Schema.NonEmptyString,
	/** Cursor is the primary lifecycle fence; this is the same-cursor row/tombstone tie-breaker. */
	rowVersion: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
	mutationId: Schema.NullOr(SyncMutationId)
};
export const SyncPartitionUpsert = Schema.Struct({
	...SyncDeltaBase,
	op: Schema.Literal('upsert'),
	row: JsonObject
});
export const SyncPartitionRemove = Schema.Struct({
	...SyncDeltaBase,
	op: Schema.Literal('remove')
});
export const SyncPartitionDelta = Schema.Union([SyncPartitionUpsert, SyncPartitionRemove]);
export type SyncPartitionDelta = Schema.Schema.Type<typeof SyncPartitionDelta>;

export const SyncPullCost = Schema.Struct({
	replayEvents: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
	/** False means the bounded probe is a lower bound and rehydration is advised. */
	replayEstimateComplete: Schema.Boolean,
	estimatedBytesPerEvent: Schema.Number.check(
		Schema.isInt(),
		Schema.isGreaterThanOrEqualTo(0)
	),
	estimatedReplayBytes: Schema.Number.check(
		Schema.isInt(),
		Schema.isGreaterThanOrEqualTo(0)
	),
	estimatedRehydrateBytes: Schema.NullOr(
		Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
	)
});
export interface SyncPullCost extends Schema.Schema.Type<typeof SyncPullCost> {}

export const SyncMutationConfirmation = Schema.Struct({
	mutationId: SyncMutationId,
	cursor: SyncCursor
});
export interface SyncMutationConfirmation
	extends Schema.Schema.Type<typeof SyncMutationConfirmation> {}

export const SyncMutationRejection = Schema.Struct({
	mutationId: SyncMutationId,
	code: Schema.Literals(['refused', 'forbidden']),
	message: Schema.String
});
export interface SyncMutationRejection
	extends Schema.Schema.Type<typeof SyncMutationRejection> {}

/**
 * Server-issued O2 identity and exact actor-scoped terminal mutation status.
 *
 * This command is the completion path for a caller with no readable dependency, so it carries no
 * collection names, rows or existence signal. A visible replica continues to retire mutations from
 * pull confirmations only after applying the corresponding authoritative batch.
 */
export const SyncPartitionStatusResponse = Schema.Struct({
	partition: SyncPartitionIdentity,
	mutationConfirmations: Schema.Array(SyncMutationConfirmation),
	mutationRejections: Schema.Array(SyncMutationRejection)
});
export interface SyncPartitionStatusResponse
	extends Schema.Schema.Type<typeof SyncPartitionStatusResponse> {}

/**
 * One bounded pull answer.
 *
 * Recovery is a discriminated move. Expiry and advised rehydration never carry deltas, and clients
 * must not persist their returned head position until rebuilding active windows commits.
 */
export const SyncPullResponse = Schema.Struct({
	partition: SyncPartitionIdentity,
	kind: Schema.Literals(['delta', 'cursorExpired', 'rehydrateAdvised']),
	deltas: Schema.Array(SyncPartitionDelta),
	cursor: SyncCursor,
	headCursor: SyncCursor,
	generations: SyncCollectionGenerations,
	affectedCollections: Schema.Array(Schema.NonEmptyString),
	refillCollections: Schema.Array(Schema.NonEmptyString),
	cost: SyncPullCost,
	mutationConfirmations: Schema.Array(SyncMutationConfirmation),
	mutationRejections: Schema.Array(SyncMutationRejection),
	complete: Schema.Boolean
});
export interface SyncPullResponse extends Schema.Schema.Type<typeof SyncPullResponse> {}

/** One host aggregation pass is deliberately small enough to keep its SQL projection bounded. */
export const MAX_SYNC_DISTRIBUTE_ENTRIES = MAX_SYNC_PARTITION_COLLECTIONS;
/** A session credential is opaque, but an unbounded opaque string is still an allocation attack. */
export const MAX_SYNC_DISTRIBUTE_CREDENTIAL_LENGTH = 4096;

/**
 * One public, host-signed distribution request.
 *
 * The host forwards the same opaque credential an individual `sync.pull` would carry. The guest
 * authenticates it inside the tenant immediately before reading; no `Subject` crosses this wire.
 */
export const SyncDistributeEntry = Schema.Struct({
	requestId: Schema.NonEmptyString,
	credential: Schema.String.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(MAX_SYNC_DISTRIBUTE_CREDENTIAL_LENGTH)
	),
	impersonatedTeam: Schema.optionalKey(Schema.NonEmptyString),
	pull: SyncPullRequest
});
export interface SyncDistributeEntry extends Schema.Schema.Type<typeof SyncDistributeEntry> {}

const SyncDistributeEntries = Schema.Array(SyncDistributeEntry).check(
	Schema.isNonEmpty(),
	Schema.makeFilter(
		(entries) =>
			entries.length <= MAX_SYNC_DISTRIBUTE_ENTRIES ||
			`at most ${MAX_SYNC_DISTRIBUTE_ENTRIES} sync pulls are accepted in one distribution batch`
	),
	Schema.makeFilter((entries) => {
		const ids = entries.map(({ requestId }) => requestId);
		return new Set(ids).size === ids.length || 'a distribution batch cannot repeat a request id';
	}),
	Schema.makeFilter(
		(entries) =>
			entries.reduce((total, entry) => total + entry.pull.collections.length, 0) <= 1_024 ||
			'at most 1024 total sync dependency collections are accepted in one distribution batch'
	)
);

export const SyncDistributeRequest = Schema.Struct({ entries: SyncDistributeEntries });
export interface SyncDistributeRequest
	extends Schema.Schema.Type<typeof SyncDistributeRequest> {}

export const SyncDistributeSuccess = Schema.Struct({
	requestId: Schema.NonEmptyString,
	status: Schema.Literal(200),
	value: SyncPullResponse
});
export const SyncDistributeFailure = Schema.Struct({
	requestId: Schema.NonEmptyString,
	status: Schema.Union([Schema.Literal(401), Schema.Literal(403)]),
	error: WireError
});
export const SyncDistributeResult = Schema.Union([
	SyncDistributeSuccess,
	SyncDistributeFailure
]);
export type SyncDistributeResult = Schema.Schema.Type<typeof SyncDistributeResult>;
export const SyncDistributeResponse = Schema.Struct({
	results: Schema.Array(SyncDistributeResult)
});
export interface SyncDistributeResponse
	extends Schema.Schema.Type<typeof SyncDistributeResponse> {}

/** The already-authenticated service entry; only dispatch may turn a wire credential into this. */
export type SyncDistributionServiceEntry = Readonly<{
	readonly requestId: string;
	readonly subject: Identity.Subject;
	readonly pull: SyncPullRequest;
}>;

export type SyncDistributionServiceResult = Readonly<
	| { readonly requestId: string; readonly response: SyncPullResponse }
	| { readonly requestId: string; readonly error: AccessControl.AccessDenied }
>;

const SyncPullRow = Schema.Struct({
	cursor: SyncCursor,
	collection: Schema.NonEmptyString,
	recordId: Schema.NullOr(Schema.NonEmptyString),
	beforeVisible: Schema.Boolean,
	afterVisible: Schema.Boolean,
	beforeRecord: Schema.Json,
	afterRecord: Schema.Json,
	invalidatedCollections: Schema.Array(Schema.NonEmptyString),
	mutationId: Schema.NullOr(SyncMutationId)
});
const SyncGenerationRow = Schema.Struct({
	collection: Schema.NonEmptyString,
	generation: DatabaseInteger
});
const SyncReplayProbeRow = Schema.Struct({
	relevant: Schema.Boolean,
	eventBytes: DatabaseInteger
});

type PartitionPullEvaluation = Readonly<{
	response: SyncPullResponse;
	currentGenerations: SyncCollectionGenerations;
	recoveryCollections: ReadonlyArray<string>;
}>;

type PartitionGenerationState = Readonly<{
	authorityGeneration: number;
	generations: SyncCollectionGenerations;
}>;

type PreparedPartitionPull = Readonly<{
	predicates: ReadonlyMap<string, AccessControl.RowPredicate>;
	/** Guest-authenticated internal names; carried only as admission proof, never queried as rows. */
	invalidations: ReadonlySet<string>;
	state: PartitionGenerationState;
	partition: SyncPartitionIdentity;
	currentHead: SyncCursor;
	initialHorizon?: SyncCursor | undefined;
}>;

const estimatedRehydrateBytes = (cost: SyncRehydrationCost | undefined): number =>
	cost === undefined
		? DEFAULT_SYNC_REHYDRATE_BYTES
		: cost.activeWindows * cost.rowsPerWindow * cost.estimatedBytesPerRow;

/** Applies a member's bounded cost facts after the common partition history was evaluated once. */
const adviseRehydration = (
	evaluation: PartitionPullEvaluation,
	rehydration: SyncRehydrationCost | undefined
): SyncPullResponse => {
	const rehydrateBytes = estimatedRehydrateBytes(rehydration);
	const cost = {
		...evaluation.response.cost,
		estimatedRehydrateBytes: rehydrateBytes
	};
	if (
		evaluation.response.kind !== 'delta' ||
		(evaluation.response.cost.replayEstimateComplete &&
			(evaluation.response.cost.replayEvents === 0 ||
				rehydrateBytes >= evaluation.response.cost.estimatedReplayBytes))
	) {
		return { ...evaluation.response, cost };
	}
	const recoveryCollections = [...new Set(evaluation.recoveryCollections)].toSorted();
	return {
		...evaluation.response,
		kind: 'rehydrateAdvised',
		deltas: [],
		cursor: evaluation.response.headCursor,
		generations: evaluation.currentGenerations,
		affectedCollections: recoveryCollections,
		refillCollections: recoveryCollections,
		cost,
		mutationConfirmations: [],
		mutationRejections: [],
		complete: true
	};
};

/** Carries sync decode error through the typed sync failure channel without losing diagnostic context. */
class SyncDecodeError extends Schema.TaggedError<SyncDecodeError>()('Bolt.Sync.DecodeError', {
	message: Schema.NonEmptyString
}) {
	readonly category = 'sync-decode' as const;
	readonly retryable = false;
	readonly phase = 'decode' as const;
}

export type Interface = Readonly<{
	readonly head: (
		effectId: EffectId
	) => Effect.Effect<SyncCursor, Database.FacilityError | SyncDecodeError>;
	/** Server-derived O2 identity without accepting or revealing a collection dependency. */
	readonly partition: (
		effectId: EffectId,
		subject: Identity.Subject
	) => Effect.Effect<SyncPartitionIdentity, Database.FacilityError | SyncDecodeError>;
	/** Server-derived partition identity plus the pre-query O6 cursor and dependency generations. */
	readonly positions: (
		effectId: EffectId,
		subject: Identity.Subject,
		collections: ReadonlyArray<string>
	) => Effect.Effect<
		SyncPartitionPosition,
		Database.FacilityError | SyncDecodeError | AccessControl.AccessDenied
	>;
	/** Partition-oriented, byte- and row-bounded pull used by browser replicas. */
	readonly pull: (
		effectId: EffectId,
		subject: Identity.Subject,
		request: SyncPullRequest
	) => Effect.Effect<
		SyncPullResponse,
		Database.FacilityError | SyncDecodeError | AccessControl.AccessDenied
	>;
	/** Resolves many already-authenticated pulls from one shared outbox window. */
	readonly distribute: (
		effectId: EffectId,
		entries: ReadonlyArray<SyncDistributionServiceEntry>
	) => Effect.Effect<
		ReadonlyArray<SyncDistributionServiceResult>,
		Database.FacilityError | SyncDecodeError
	>;
	readonly shape: (
		subject: Identity.Subject
	) => Effect.Effect<ReadonlyArray<string>, AccessControl.AccessDenied>;
	/** Collapses superseded log rows and prunes past the retention window. Returns what it removed. */
	readonly compact: (
		effectId: EffectId,
		retentionDays: number
	) => Effect.Effect<
		{ readonly collapsed: number; readonly pruned: number },
		Database.FacilityError | SyncDecodeError
	>;
	/** Immutable release facts. The host alone adds its durable tenant schema generation. */
	readonly schema: () => SyncSchemaFacts;
	readonly wakeHint: (cursor: SyncCursor) => {
		readonly topic: string;
		readonly cursor: SyncCursor;
	};
}>;
/** Identifies the sync service in Effect's context so dependency wiring remains explicit and type checked. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/Sync');

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const database = yield* Database.Service;
		const access = yield* AccessControl.Service;
		const workspace = yield* Workspace.Service;
		const tenant = yield* TenantScope.Service;
		/**
		 * Applies column masking to a record on its way out of the sync engine.
		 *
		 * Reuses `access.mask` rather than restating the rule, so a read through `collections.findMany` and
		 * a row arriving through the replica cannot disagree about which columns exist. A record that is
		 * not an object — a delete carries none — passes through untouched.
		 */
		const maskRecord = (
			subject: Identity.Subject,
			collection: string,
			record: Schema.Json
		): Schema.Json => {
			if (!isJsonObject(record)) return record;
			const fields = workspace.definition.collections.find(
				(entry) => entry.name === collection
			)?.fields;
			const logical = fields === undefined ? record : decodeReferenceRow(record, fields);
			return access.mask(
				subject,
				'read',
				collection,
				logical as Readonly<Record<string, Schema.Json>>
			) as Schema.Json;
		};
		const provisioningSteps = replicaProvisioningSteps(workspace.definition);
		const schemaFingerprint = workspace.definition.mutationCompatibility?.currentSchemaFingerprint;
		if (schemaFingerprint === undefined)
			throw new TypeError(
				'Compiled workspace is missing its mutation compatibility fingerprint.'
			);
		const schemaFacts = SyncSchemaFacts.make({
			cursor: 'xid-sequence',
			version: 1,
			fingerprint: schemaFingerprint,
			minimumProtocolVersion: PROTOCOL_VERSION,
			migrationDigest: digestSchemaSteps(provisioningSteps),
			// A release cannot know which previous release a particular tenant is leaving, so the only
			// conservatively correct affected set is every collection this release can materialize.
			affectedCollections: [
				...new Set(
					workspace.definition.collections
						.filter(isReplicatedCollection)
						.map(({ name }) => name)
				)
			].toSorted((left, right) => left.localeCompare(right))
		});
		const readHead = Effect.fn('Sync.readHead')(function* (effectId: EffectId) {
			const result = yield* executeBuilt(
				effectId,
				database,
				composer
					.select({
						xid: aliased(coalesce(max(syncOutbox.xid), 0), 'xid'),
						sequence: aliased(coalesce(max(syncOutbox.sequence), 0), 'sequence')
					})
					.from(syncOutbox)
					.where(lt(syncOutbox.xid, COMMIT_HORIZON))
			);
			return yield* decodeDatabaseSyncCursor(result.rows[0] ?? { xid: 0, sequence: 0 }).pipe(
				Effect.mapError(() => new SyncDecodeError({ message: 'Invalid sync head row' }))
			);
		});
		const readHorizon = Effect.fn('Sync.readHorizon')(function* (effectId: EffectId) {
			const result = yield* executeBuilt(
				effectId,
				database,
				composer
					.select({ xid: syncHorizon.xid, sequence: syncHorizon.sequence })
					.from(syncHorizon)
					.where(eq(syncHorizon.singleton, true))
					.limit(1)
			);
			if (result.rows[0] === undefined) return undefined;
			return yield* decodeDatabaseSyncCursor(result.rows[0]).pipe(
				Effect.mapError(() => new SyncDecodeError({ message: 'Invalid sync horizon row' }))
			);
		});
		const subscriptionPredicates = Effect.fn('Sync.subscriptionPredicates')(function* (
			subject: Identity.Subject,
			names: ReadonlyArray<string>
		) {
			if (
				names.length === 0 ||
				names.length > MAX_SYNC_PARTITION_COLLECTIONS ||
				new Set(names).size !== names.length
			) {
				return yield* new AccessControl.AccessDenied({
					action: 'read',
					resource: 'sync.subscription',
					reason: 'sync subscription unavailable'
				});
			}
			const predicates = new Map<string, AccessControl.RowPredicate>();
			for (const name of names) {
				const definition = workspace.definition.collections.find(
					(collection) => collection.name === name
				);
				const predicate = access.predicate(subject, 'read', name);
				if (definition === undefined || !isReplicatedCollection(definition) || !predicate.allowed) {
					// Unknown, disabled and unauthorized are intentionally indistinguishable. The caller
					// already supplied the spelling; the response must not confirm whether it exists.
					return yield* new AccessControl.AccessDenied({
						action: 'read',
						resource: 'sync.subscription',
						reason: 'sync subscription unavailable'
					});
				}
				predicates.set(name, predicate);
			}
			return predicates;
		});
		const invalidationOnlyNames = new Set<string>(SYNC_INVALIDATION_ONLY_COLLECTIONS);
		const subscriptionInvalidations = Effect.fn('Sync.subscriptionInvalidations')(function* (
			subject: Identity.Subject,
			names: ReadonlyArray<string>
		) {
			const admitted = new Set<string>();
			for (const name of names) {
				if (!invalidationOnlyNames.has(name)) {
					// Unknown, private-but-unapproved and unauthorized names are intentionally identical.
					return yield* new AccessControl.AccessDenied({
						action: 'read',
						resource: 'sync.invalidation',
						reason: 'sync subscription unavailable'
					});
				}
				const definition = workspace.definition.collections.find(
					(collection) => collection.name === name
				);
				if (definition === undefined || isReplicatedCollection(definition)) {
					return yield* new AccessControl.AccessDenied({
						action: 'read',
						resource: 'sync.invalidation',
						reason: 'sync subscription unavailable'
					});
				}
				const predicate = access.predicate(subject, 'read', name);
				if (!predicate.allowed) {
					return yield* new AccessControl.AccessDenied({
						action: 'read',
						resource: 'sync.invalidation',
						reason: 'sync subscription unavailable'
					});
				}
				admitted.add(name);
			}
			return admitted;
		});
		const generationState = Effect.fn('Sync.generationState')(function* (
			effectId: EffectId,
			names: ReadonlyArray<string>
		) {
			const requested = [...new Set([...names, '__authority__'])];
			const result = yield* executeBuilt(
				effectId,
				database,
				composer
					.select({
						collection: aliased(syncGeneration.collection_name, 'collection'),
						generation: aliased(syncGeneration.generation, 'generation')
					})
					.from(syncGeneration)
					.where(inArray(syncGeneration.collection_name, requested))
			);
			const rows = yield* Schema.decodeUnknownEffect(Schema.Array(SyncGenerationRow))(
				result.rows
			).pipe(
				Effect.mapError(() => new SyncDecodeError({ message: 'Invalid sync generation rows' }))
			);
			const found = new Map(rows.map(({ collection, generation }) => [collection, generation]));
			return {
				authorityGeneration: found.get('__authority__') ?? 0,
				generations: Object.fromEntries(names.map((name) => [name, found.get(name) ?? 0]))
			};
		});
		const partitionIdentity = (
			subject: Identity.Subject,
			authorityGeneration: number
		): SyncPartitionIdentity => {
			let actorBound = false;
			const policySurface = workspace.definition.collections
				.filter(isReplicatedCollection)
				.map(({ name }) => {
					const predicate = access.predicate(subject, 'read', name);
					actorBound ||= predicate.actorBound;
					return predicate.allowed
						? [
								name,
								predicate.sql,
								predicate.parameters,
								[...(predicate.fields ?? [])].toSorted()
							]
						: [name, 'denied'];
				})
				.toSorted((left, right) => String(left[0]).localeCompare(String(right[0])));
			const effectivePolicyHolder = actorBound
				? `actor:${subject.userId}`
				: subject.admin === true
					? 'administrator'
					: subject.policies.length > 0
						? `static:${[...subject.policies].toSorted().join(',')}`
						: subject.teamPath[0] === undefined
							? 'authenticated'
							: `team:${subject.teamPath[0].toLocaleLowerCase()}`;
			const impersonationTarget =
				subject.impersonatedBy === undefined ? null : (subject.teamPath[0] ?? subject.userId);
			const identity = {
				tenantId: tenant.tenantId,
				environment: tenant.environment.trim() === '' ? 'unknown' : tenant.environment,
				effectivePolicyHolder,
				impersonationTarget,
				authorityGeneration,
				schemaFingerprint: schemaFacts.fingerprint
			};
			return {
				key: `sha256:${sha256Json({ ...identity, policySurface })}`,
				...identity
			};
		};
		const readPartitionIdentity = Effect.fn('Sync.readPartitionIdentity')(function* (
			effectId: EffectId,
			subject: Identity.Subject
		) {
			const state = yield* generationState(EffectId.make(`${effectId}:authority-generation`), []);
			return partitionIdentity(subject, state.authorityGeneration);
		});
		const readPositions = Effect.fn('Sync.readPositions')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			names: ReadonlyArray<string>
		) {
			yield* subscriptionPredicates(subject, names);
			const head = yield* readHead(EffectId.make(`${effectId}:head`));
			const state = yield* generationState(EffectId.make(`${effectId}:generations`), names);
			return {
				partition: partitionIdentity(subject, state.authorityGeneration),
				cursor: head,
				generations: state.generations
			};
		});
		const evaluatePartition = Effect.fn('Sync.evaluatePartition')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			request: SyncPullRequest,
			prepared?: PreparedPartitionPull
		) {
			if (prepared === undefined) {
				yield* subscriptionInvalidations(subject, request.invalidations ?? []);
			}
			const predicates =
				prepared?.predicates ??
				(yield* subscriptionPredicates(subject, request.collections));
			let initialHorizon = prepared?.initialHorizon;
			let currentHead = prepared?.currentHead;
			if (currentHead === undefined) {
				const outboxHead = yield* readHead(EffectId.make(`${effectId}:head`));
				initialHorizon = yield* readHorizon(EffectId.make(`${effectId}:horizon`));
				currentHead =
					initialHorizon !== undefined && compareSyncCursors(initialHorizon, outboxHead) > 0
						? initialHorizon
						: outboxHead;
			}
			const state =
				prepared?.state ??
				(yield* generationState(
					EffectId.make(`${effectId}:generations`),
					request.collections
				));
			const partition =
				prepared?.partition ?? partitionIdentity(subject, state.authorityGeneration);
			const generationMismatch = request.collections.filter(
				(collection) =>
					!Object.hasOwn(request.generations, collection) ||
					request.generations[collection] !== state.generations[collection]
			);
			const recoveryCollections =
				generationMismatch.length === 0 ? request.collections : generationMismatch;
			const noReplayCost: SyncPullCost = {
				replayEvents: 0,
				replayEstimateComplete: true,
				estimatedBytesPerEvent: 0,
				estimatedReplayBytes: 0,
				estimatedRehydrateBytes: null
			};
			const recovery = (
				kind: 'cursorExpired' | 'rehydrateAdvised',
				affectedCollections: ReadonlyArray<string>,
				cost: SyncPullCost = noReplayCost
			): SyncPullResponse => ({
				partition,
				kind,
				deltas: [],
				cursor: currentHead,
				headCursor: currentHead,
				generations: state.generations,
				affectedCollections: [...new Set(affectedCollections)].toSorted(),
				refillCollections: [...new Set(affectedCollections)].toSorted(),
				cost,
				mutationConfirmations: [],
				mutationRejections: [],
				complete: true
			});
			const evaluated = (response: SyncPullResponse): PartitionPullEvaluation => ({
				response,
				currentGenerations: state.generations,
				recoveryCollections
			});
			if (request.cursor === null) {
				// No durable position is a bootstrap, not an expired cursor. The client rebuilds its active
				// windows and commits this head only with that rehydration.
				return evaluated(recovery('rehydrateAdvised', request.collections));
			}
			const requestedCursor = request.cursor;
			if (
				requestedCursor.xid === 0 &&
				requestedCursor.sequence === 0 &&
				Object.keys(request.generations).length === 0
			) {
				return evaluated(recovery('rehydrateAdvised', request.collections));
			}
			if (
				compareSyncCursors(requestedCursor, currentHead) > 0 ||
				(initialHorizon !== undefined &&
					compareSyncCursors(requestedCursor, initialHorizon) < 0)
			) {
				return evaluated(recovery('cursorExpired', recoveryCollections));
			}

			const relevant =
				or(
					inArray(syncOutbox.collection_name, request.collections),
					jsonArrayContainsAny(syncOutbox.invalidated_collections, request.collections)
				) ?? nothing();
			const afterCursor = or(
				gt(syncOutbox.xid, requestedCursor.xid),
				and(
					eq(syncOutbox.xid, requestedCursor.xid),
					gt(syncOutbox.sequence, requestedCursor.sequence)
				)
			);
			const estimateResult = yield* executeBuilt(
				EffectId.make(`${effectId}:cost`),
				database,
				composer
					.select({
						relevant: aliased(relevant, 'relevant'),
						eventBytes: aliased(
							syncReplayEventBytes(
								syncOutbox.before_record,
								syncOutbox.after_record,
								syncOutbox.invalidated_collections
							),
							'eventBytes'
						)
					})
					.from(syncOutbox)
					.where(and(afterCursor, lt(syncOutbox.xid, COMMIT_HORIZON)))
					.orderBy(asc(syncOutbox.xid), asc(syncOutbox.sequence))
					.limit(MAX_SYNC_REPLAY_COST_SCAN_EVENTS + 1)
			);
			const probe = yield* Schema.decodeUnknownEffect(Schema.Array(SyncReplayProbeRow))(
				estimateResult.rows
			).pipe(
				Effect.mapError(() => new SyncDecodeError({ message: 'Invalid sync replay cost row' }))
			);
			const replayEstimateComplete = probe.length <= MAX_SYNC_REPLAY_COST_SCAN_EVENTS;
			const relevantProbe = probe
				.slice(0, MAX_SYNC_REPLAY_COST_SCAN_EVENTS)
				.filter(({ relevant: isRelevant }) => isRelevant);
			const replayEvents = relevantProbe.length;
			const replayBytes = relevantProbe.reduce(
				(total, row) => total + Number(row.eventBytes),
				0
			);
			const estimatedBytesPerEvent =
				replayEvents === 0 ? 0 : Math.ceil(replayBytes / replayEvents);
			const replayCost: SyncPullCost = {
				replayEvents,
				replayEstimateComplete,
				estimatedBytesPerEvent,
				// This is N×E over a bounded probe. An incomplete probe forces advice instead of pretending
				// the lower bound is a complete replay estimate.
				estimatedReplayBytes: replayEvents * estimatedBytesPerEvent,
				estimatedRehydrateBytes: null
			};

			const beforeVisibility =
				or(
					...[...predicates].map(([name, predicate], index) =>
						and(
							eq(syncOutbox.collection_name, name),
							isNotNull(syncOutbox.before_record),
							exists(
								composer
									.select({ one: one() })
									.from(jsonRecord(name, syncOutbox.before_record, `sync_before_${index}`))
									.where(AccessControl.predicateExpression(predicate))
							)
						)
					)
				) ?? nothing();
			const afterVisibility =
				or(
					...[...predicates].map(([name, predicate], index) =>
						and(
							eq(syncOutbox.collection_name, name),
							isNotNull(syncOutbox.after_record),
							exists(
								composer
									.select({ one: one() })
									.from(jsonRecord(name, syncOutbox.after_record, `sync_after_${index}`))
									.where(AccessControl.predicateExpression(predicate))
							)
						)
					)
				) ?? nothing();
			const size = ENumber.clamp({ minimum: 1, maximum: 500 })(
				request.limit ?? DEFAULT_SYNC_PULL_LIMIT
			);
			const budget = ENumber.clamp({ minimum: 1, maximum: MAX_SYNC_PULL_MAX_BYTES })(
				request.maxBytes ?? DEFAULT_SYNC_PULL_MAX_BYTES
			);
			const result = yield* executeBuilt(
				EffectId.make(`${effectId}:rows`),
				database,
				composer
					.select({
						cursor: aliased(syncCursorJson(syncOutbox.xid, syncOutbox.sequence), 'cursor'),
						collection: aliased(syncOutbox.collection_name, 'collection'),
						recordId: aliased(
							onlyWhen(or(beforeVisibility, afterVisibility) ?? nothing(), syncOutbox.record_id),
							'recordId'
						),
						beforeVisible: aliased(beforeVisibility, 'beforeVisible'),
						afterVisible: aliased(afterVisibility, 'afterVisible'),
						beforeRecord: aliased(
							onlyWhen(beforeVisibility, syncOutbox.before_record),
							'beforeRecord'
						),
						afterRecord: aliased(
							onlyWhen(afterVisibility, syncOutbox.after_record),
							'afterRecord'
						),
						invalidatedCollections: aliased(
							syncOutbox.invalidated_collections,
							'invalidatedCollections'
						),
						mutationId: aliased(syncOutbox.mutation_id, 'mutationId')
					})
					.from(syncOutbox)
					.where(and(afterCursor, relevant, lt(syncOutbox.xid, COMMIT_HORIZON)))
					.orderBy(asc(syncOutbox.xid), asc(syncOutbox.sequence))
					.limit(size)
			);
			const rows = yield* Schema.decodeUnknownEffect(Schema.Array(SyncPullRow))(result.rows).pipe(
				Effect.mapError(() => new SyncDecodeError({ message: 'Invalid partition delta rows' }))
			);
			const afterReadHorizon = yield* readHorizon(
				EffectId.make(`${effectId}:horizon-after`)
			);
			if (
				afterReadHorizon !== undefined &&
				compareSyncCursors(afterReadHorizon, requestedCursor) > 0 &&
				(initialHorizon === undefined || compareSyncCursors(afterReadHorizon, initialHorizon) > 0)
			) {
				return evaluated(recovery('cursorExpired', recoveryCollections, replayCost));
			}

			const subscribed = new Set(request.collections);
			// Broad activity and mandatory proof withdrawal are separate facts. A direct jobs row can be
			// applied with M1 while a job_assignments row in the same batch still requires M2 for jobs.
			const affected = new Set(generationMismatch);
			const refill = new Set<string>();
			const deltas: Array<SyncPartitionDelta> = [];
			let cursor = requestedCursor;
			let examined = 0;
			let weight = 0;
			for (const row of rows) {
				let delta: SyncPartitionDelta | undefined;
				if (subscribed.has(row.collection) && row.afterVisible) {
					if (row.recordId === null || !isJsonObject(row.afterRecord)) {
						return yield* new SyncDecodeError({ message: 'Visible sync upsert has no full row' });
					}
					const rowVersion = Number(row.afterRecord['row_version']);
					if (!Number.isSafeInteger(rowVersion) || rowVersion < 1) {
						return yield* new SyncDecodeError({ message: 'Visible sync upsert has no row version' });
					}
					const masked = maskRecord(subject, row.collection, row.afterRecord);
					if (!isJsonObject(masked)) {
						return yield* new SyncDecodeError({ message: 'Visible sync upsert is not an object' });
					}
					delta = {
						cursor: row.cursor,
						collection: row.collection,
						op: 'upsert',
						recordId: row.recordId,
						rowVersion,
						mutationId: row.mutationId,
						row: masked
					};
				} else if (subscribed.has(row.collection) && row.beforeVisible) {
					if (row.recordId === null || !isJsonObject(row.beforeRecord)) {
						return yield* new SyncDecodeError({ message: 'Visible sync removal has no prior row' });
					}
					const previousVersion = Number(row.beforeRecord['row_version']);
					if (
						!Number.isSafeInteger(previousVersion) ||
						previousVersion < 1 ||
						previousVersion >= Number.MAX_SAFE_INTEGER
					) {
						return yield* new SyncDecodeError({ message: 'Visible sync removal has no row version' });
					}
					delta = {
						cursor: row.cursor,
						collection: row.collection,
						op: 'remove',
						recordId: row.recordId,
						rowVersion: previousVersion + 1,
						mutationId: row.mutationId
					};
				}
				const deltaWeight = delta === undefined ? 0 : JSON.stringify(delta).length;
				if (deltas.length > 0 && weight + deltaWeight > budget) break;
				for (const invalidated of row.invalidatedCollections) {
					if (!subscribed.has(invalidated)) continue;
					affected.add(invalidated);
					refill.add(invalidated);
				}
				if (delta !== undefined) affected.add(delta.collection);
				examined += 1;
				cursor = row.cursor;
				if (delta !== undefined) deltas.push(delta);
				weight += deltaWeight;
				if (weight >= budget) break;
			}
			const complete = examined === rows.length && rows.length < size;
			if (complete) cursor = currentHead;
			if (complete && replayEvents === 0) {
				for (const collection of generationMismatch) refill.add(collection);
			}
			return evaluated({
				partition,
				kind: 'delta' as const,
				deltas,
				cursor,
				headCursor: currentHead,
				generations: complete
					? state.generations
					: Object.fromEntries(
							request.collections.map((collection) => [
								collection,
								request.generations[collection] ?? 0
							])
						),
				affectedCollections: [...affected].toSorted(),
				refillCollections: [...refill].toSorted(),
				cost: replayCost,
				mutationConfirmations: [],
				mutationRejections: [],
				complete
			});
		});
		const pullPartition = Effect.fn('Sync.pullPartition')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			request: SyncPullRequest
		) {
			return adviseRehydration(
				yield* evaluatePartition(effectId, subject, request),
				request.rehydration
			);
		});
		const service: Interface = {
			head: readHead,
			partition: readPartitionIdentity,
			positions: readPositions,
			pull: pullPartition,
			distribute: Effect.fn('Sync.distribute')(function* (
				effectId: EffectId,
				entries: ReadonlyArray<SyncDistributionServiceEntry>
			) {
				if (entries.length === 0)
					return [] as ReadonlyArray<SyncDistributionServiceResult>;
				const denied = new Map<number, AccessControl.AccessDenied>();
				type AdmissionGroup = Readonly<{
					subject: Identity.Subject;
					subjectKey: string;
					collections: ReadonlyArray<string>;
					invalidations: ReadonlyArray<string>;
					collectionKey: string;
					members: Array<number>;
				}>;
				type AdmittedGroup = AdmissionGroup &
					Readonly<{
						predicates: ReadonlyMap<string, AccessControl.RowPredicate>;
						admittedInvalidations: ReadonlySet<string>;
					}>;
				type Bucket = Readonly<{
					subject: Identity.Subject;
					pull: SyncPullRequest;
					members: Array<number>;
					prepared: PreparedPartitionPull;
				}>;
				// Authentication has already happened in dispatch. Exact subject coordinates and the same
				// dependency set have exactly the same subscription decision; grouping on the complete
				// minted subject preserves actor/impersonation isolation while avoiding duplicate policy work.
				const admissionGroups = new Map<string, AdmissionGroup>();
				for (const [index, entry] of entries.entries()) {
					const collections = [...entry.pull.collections].toSorted();
					const invalidations = [...(entry.pull.invalidations ?? [])].toSorted();
					const collectionKey = sha256Json(collections);
					const subjectKey = sha256Json(entry.subject);
					const key = sha256Json({ subjectKey, collections, invalidations });
					const held = admissionGroups.get(key);
					if (held === undefined) {
						admissionGroups.set(key, {
							subject: entry.subject,
							subjectKey,
							collections,
							invalidations,
							collectionKey,
							members: [index]
						});
					} else held.members.push(index);
				}
				const admittedGroups: Array<AdmittedGroup> = [];
				for (const group of admissionGroups.values()) {
					const admitted = yield* Effect.result(
						Effect.all({
							predicates: subscriptionPredicates(group.subject, group.collections),
							invalidations: subscriptionInvalidations(group.subject, group.invalidations)
						})
					);
					if (Result.isFailure(admitted)) {
						for (const index of group.members) denied.set(index, admitted.failure);
						continue;
					}
					admittedGroups.push({
						...group,
						predicates: admitted.success.predicates,
						admittedInvalidations: admitted.success.invalidations
					});
				}
				const buckets = new Map<string, Bucket>();
				if (admittedGroups.length > 0) {
					// Head/horizon are tenant-global. Sampling once before generation state preserves pull's
					// head-before-generations ordering while giving every bucket one coherent batch horizon.
					const outboxHead = yield* readHead(EffectId.make(`${effectId}:shared-head`));
					const initialHorizon = yield* readHorizon(
						EffectId.make(`${effectId}:shared-horizon`)
					);
					const currentHead =
						initialHorizon !== undefined && compareSyncCursors(initialHorizon, outboxHead) > 0
							? initialHorizon
							: outboxHead;
					const states = new Map<string, PartitionGenerationState>();
					const partitions = new Map<string, SyncPartitionIdentity>();
					let stateIndex = 0;
					for (const group of admittedGroups) {
						let state = states.get(group.collectionKey);
						if (state === undefined) {
							state = yield* generationState(
								EffectId.make(`${effectId}:generations:${(stateIndex += 1)}`),
								group.collections
							);
							states.set(group.collectionKey, state);
						}
						const partitionKey = `${group.subjectKey}\u0000${state.authorityGeneration}`;
						const partition =
							partitions.get(partitionKey) ??
							partitionIdentity(group.subject, state.authorityGeneration);
						partitions.set(partitionKey, partition);
						const prepared: PreparedPartitionPull = {
							predicates: group.predicates,
							invalidations: group.admittedInvalidations,
							state,
							partition,
							currentHead,
							initialHorizon
						};
						for (const index of group.members) {
							const entry = entries[index];
							if (entry === undefined)
								throw new Error('Sync distribution lost an admitted member');
							const key = sha256Json({
								partition: partition.key,
								collections: group.collections,
								invalidations: group.invalidations,
								cursor: entry.pull.cursor,
								generations: entry.pull.generations,
								limit: entry.pull.limit ?? DEFAULT_SYNC_PULL_LIMIT,
								maxBytes: entry.pull.maxBytes ?? DEFAULT_SYNC_PULL_MAX_BYTES
							});
							const bucket = buckets.get(key);
							if (bucket === undefined) {
								buckets.set(key, {
									subject: entry.subject,
									pull: entry.pull,
									members: [index],
									prepared
								});
							} else bucket.members.push(index);
						}
					}
				}
				const completed = new Map<number, SyncPullResponse>();
				for (const [bucketIndex, bucket] of [...buckets.values()].entries()) {
					const outcome = yield* Effect.result(
							evaluatePartition(
								EffectId.make(`${effectId}:partition-pull:${bucketIndex}`),
								bucket.subject,
								bucket.pull,
								bucket.prepared
							)
					);
					if (Result.isFailure(outcome)) {
						if (outcome.failure instanceof AccessControl.AccessDenied) {
							for (const index of bucket.members) denied.set(index, outcome.failure);
							continue;
						}
						return yield* outcome.failure;
					}
					for (const index of bucket.members) {
						const member = entries[index];
						if (member === undefined) {
							throw new Error('Sync distribution lost a partition cost member');
						}
						completed.set(
							index,
							adviseRehydration(outcome.success, member.pull.rehydration)
						);
					}
				}
				return entries.map((entry, index): SyncDistributionServiceResult => {
					const error = denied.get(index);
					if (error !== undefined) return { requestId: entry.requestId, error };
					const response = completed.get(index);
					if (response === undefined) {
						throw new Error('Sync distribution lost an admitted partition member');
					}
					return { requestId: entry.requestId, response };
				});
			}),
			shape: Effect.fn('Sync.shape')(function* (subject) {
				return workspace.definition.collections
					.flatMap((collection) =>
						!isReplicatedCollection(collection)
							? []
							: access.predicate(subject, 'read', collection.name).allowed
								? [collection.name]
								: []
					)
					.toSorted();
			}),
			compact: Effect.fn('Sync.compact')(function* (effectId, retentionDays) {
				const days = Math.max(1, Math.trunc(retentionDays));
				// Three calls rather than one batch, and each under its own effect id. The facility answers a
				// transaction with its *last* statement's rows, so two counts cannot come back from one batch;
				// and every facility is idempotent on `(scope, effectId)`, so three statements sharing this
				// invocation's id would be answered with the first one's cached result.
				const collapsed = yield* executeBuilt(
					EffectId.make(`${effectId}:collapse`),
					database,
					Compaction.collapse().returning({ removed: one() })
				);
				// Marked before anything is pruned, never after: the mark is what makes a gap detectable, so a
				// crash between these two leaves replicas told to rebuild rather than silently short.
				yield* executeBuilt(
					EffectId.make(`${effectId}:mark`),
					database,
					Compaction.markRetained(days)
				);
				const pruned = yield* executeBuilt(
					EffectId.make(`${effectId}:prune`),
					database,
					Compaction.prune(days).returning({ removed: one() })
				);
				return { collapsed: collapsed.rows.length, pruned: pruned.rows.length };
			}),
			schema: () => schemaFacts,
			wakeHint: (cursor) => ({ topic: 'bolt.sync', cursor })
		};
		return Service.of(service);
	})
);
