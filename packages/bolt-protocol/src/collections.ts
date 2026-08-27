import { Schema } from 'effect';

/**
 * One record on its way into a collection, and the one thing that makes it a graph rather than a row.
 *
 * The keys are the collection's own columns, except where a key names a `many` relation the
 * workspace declared in `+relationship.ts`: that one carries an array of the records that belong to
 * this one, and each of those is a `CollectionWriteValues` in its own right, down to the depth the
 * runtime bounds at.
 *
 * That nesting is admitted rather than described, because `Schema.Json` already permits it and the
 * only party that can tell a relation name from a misspelt column is the one holding the workspace's
 * relations — which is the server. Describing it here would be a second, weaker copy of a check that
 * has to happen there anyway, and the runtime *refuses* an unrecognised key rather than dropping it,
 * so nothing is lost by leaving the discrimination where the answer is.
 */
export const CollectionWriteValues = Schema.Record(Schema.String, Schema.Json).annotate({
	identifier: 'BoltCollectionWriteValues'
});
export type CollectionWriteValues = typeof CollectionWriteValues.Type;

/**
 * A browser-generated identity for one logical mutation.
 *
 * It is deliberately independent of an invocation id: transports are allowed to retry with a new
 * invocation, while the tenant database deduplicates this value under the authenticated scope. The
 * length cap keeps an attacker-controlled key from becoming an unbounded index entry.
 */
export const CollectionMutationIdempotencyKey = Schema.NonEmptyString.check(
	Schema.isMaxLength(256),
	Schema.makeFilter((value: string) =>
		!value.includes('\u0000') || 'must not contain a NUL byte'
	)
).pipe(Schema.brand('BoltCollectionMutationIdempotencyKey'));
export type CollectionMutationIdempotencyKey =
	typeof CollectionMutationIdempotencyKey.Type;

/** Row versions begin at one and advance once for every canonical update. */
export const CollectionBaseRowVersion = Schema.Number.check(
	Schema.isInt(),
	Schema.isGreaterThanOrEqualTo(1)
);
export type CollectionBaseRowVersion = typeof CollectionBaseRowVersion.Type;

/** Maximum age at which a missing server dedup record may still authorize a retry. */
export const COLLECTION_MUTATION_RETRY_HORIZON_MILLIS = 24 * 60 * 60 * 1000;

/**
 * How long a release promises to understand a mutation journaled by an older schema.
 *
 * This is intentionally longer than the transport retry horizon above. The retry horizon answers
 * whether a missing dedup row may be recreated; this horizon answers whether the server still owns
 * a compatibility adapter for the mutation's authored schema. Once it elapses the only safe answer
 * is an explicit quarantine, never silently dropping the journal entry or guessing at its meaning.
 */
export const COLLECTION_MUTATION_SCHEMA_COMPATIBILITY_HORIZON_MILLIS =
	14 * 24 * 60 * 60 * 1000;

/** Monotone order assigned by one durable, partition-scoped browser journal. */
export const CollectionMutationDeviceSequence = Schema.Number.check(
	Schema.isInt(),
	Schema.makeFilter((value: number) => Number.isSafeInteger(value) || 'must be a safe integer'),
	Schema.isGreaterThanOrEqualTo(1)
);
export type CollectionMutationDeviceSequence =
	typeof CollectionMutationDeviceSequence.Type;

/** One authoritative whole-row version captured before an offline graph was overlaid. */
export const CollectionMutationBaseVersion = Schema.Struct({
	row: Schema.Struct({
		collection: Schema.NonEmptyString,
		recordId: Schema.NonEmptyString
	}),
	rowVersion: Schema.NullOr(CollectionBaseRowVersion)
}).annotate({ identifier: 'BoltCollectionMutationBaseVersion' });
export type CollectionMutationBaseVersion = typeof CollectionMutationBaseVersion.Type;

const CollectionMutationRetryIdentity = {
	idempotencyKey: CollectionMutationIdempotencyKey,
	/**
	 * When the browser first minted the key. A server accepts a missing dedup row only inside its
	 * bounded retry horizon, so pruning old rows can never turn a very late retry into a new write.
	 */
	issuedAtEpochMs: Schema.Number.check(
		Schema.isInt(),
		Schema.isGreaterThan(0),
		Schema.isFinite()
	)
};

/**
 * The declarative graph kept verbatim in the journal.
 *
 * Keeping the verb inside the graph makes the surrounding push envelope stable across schema
 * adapters. An adapter transforms only this value; it can never rewrite the idempotency key,
 * device order, authenticated partition binding, or the versions against which it reconciles.
 * Browser-authored creates carry their client-minted identity inside `values`; the authoritative
 * runtime validates and preserves those identities because only it knows which nested values are
 * relationship rows.
 */
export const CollectionMutationGraph = Schema.Union([
	Schema.Struct({
		action: Schema.Literal('create'),
		collection: Schema.NonEmptyString,
		values: CollectionWriteValues
	}),
	Schema.Struct({
		action: Schema.Literal('update'),
		collection: Schema.NonEmptyString,
		values: CollectionWriteValues
	}),
	Schema.Struct({
		action: Schema.Literal('delete'),
		collection: Schema.NonEmptyString,
		id: Schema.NonEmptyString
	})
]).annotate({ identifier: 'BoltCollectionMutationGraph' });
export type CollectionMutationGraph = typeof CollectionMutationGraph.Type;

/**
 * M4 journal push. Identity fields are immutable facts from the original local transaction.
 *
 * `partitionKey` is the exact opaque physical O2 key previously issued by `sync.partition`. The
 * server registry binds that issuance to tenant/environment/actor/effective subject/impersonation;
 * the key is not a database selector and confers no authority by itself. `baseVersions` is a
 * whole-row vector covering every existing row the submitted graph may update or explicitly remove.
 */
export const CollectionMutationPush = Schema.Struct({
	protocolVersion: Schema.Literal(2),
	...CollectionMutationRetryIdentity,
	deviceSequence: CollectionMutationDeviceSequence,
	partitionKey: Schema.NonEmptyString,
	schemaFingerprint: Schema.NonEmptyString,
	graph: CollectionMutationGraph,
	baseVersions: Schema.Array(CollectionMutationBaseVersion)
}).annotate({ identifier: 'BoltCollectionMutationPush' });
export type CollectionMutationPush = typeof CollectionMutationPush.Type;

/**
 * The sole browser mutation request. Subject, tenant, environment and authority are intentionally
 * absent: the authenticated command boundary supplies them and resolves the opaque partition key
 * against the durable issuance registry.
 */
export const CollectionMutateRequest = CollectionMutationPush.annotate({
	identifier: 'BoltCollectionMutateRequest'
});
export type CollectionMutateRequest = typeof CollectionMutateRequest.Type;

/** One row exactly as the database holds it, defaults and generated columns included. */
export const StoredRecord = Schema.Record(Schema.String, Schema.Json).annotate({
	identifier: 'BoltStoredRecord'
});
export type StoredRecord = typeof StoredRecord.Type;

/**
 * The collection read accepted by the browser command boundary.
 *
 * `where` is the predicate authored by the workspace. `userFilter` is the independently
 * canonicalized narrowing supplied by a generic surface. Keeping the two on the wire prevents the
 * sync engine from losing the distinction when it assigns one growing window to a query. `after`
 * and `columns` deliberately remain request concerns: neither is part of window identity.
 */
export const CollectionQueryRequestFields = {
	collection: Schema.NonEmptyString,
	where: Schema.optionalKey(Schema.Json),
	userFilter: Schema.optionalKey(Schema.Json),
	search: Schema.optionalKey(Schema.String),
	with: Schema.optionalKey(Schema.Json),
	orderBy: Schema.optionalKey(Schema.Json),
	limit: Schema.optionalKey(Schema.Number),
	after: Schema.optionalKey(Schema.String),
	columns: Schema.optionalKey(Schema.Json)
};
export const CollectionQueryRequest = Schema.Struct(CollectionQueryRequestFields).annotate({
	identifier: 'BoltCollectionQueryRequest'
});
export interface CollectionQueryRequest
	extends Schema.Schema.Type<typeof CollectionQueryRequest> {}

/** Exact server-side grouping requested by a board-like collection surface. */
export const CollectionGroup = Schema.Struct({
	by: Schema.NonEmptyString,
	lanes: Schema.optionalKey(Schema.Array(Schema.Json))
}).annotate({ identifier: 'BoltCollectionGroup' });
export interface CollectionGroup extends Schema.Schema.Type<typeof CollectionGroup> {}

/**
 * A grouped query is one complete authoritative aggregate, not a hidden 500-row page.
 *
 * It therefore accepts neither a page cursor nor a page size. `columns` remains a read-time
 * projection and is excluded from canonical identity just as it is for ordinary page windows.
 */
export const CollectionGroupedQueryRequestFields = {
	collection: CollectionQueryRequest.fields.collection,
	where: CollectionQueryRequest.fields.where,
	userFilter: CollectionQueryRequest.fields.userFilter,
	search: CollectionQueryRequest.fields.search,
	with: CollectionQueryRequest.fields.with,
	orderBy: CollectionQueryRequest.fields.orderBy,
	columns: CollectionQueryRequest.fields.columns,
	group: CollectionGroup
};
export const CollectionGroupedQueryRequest = Schema.Struct(
	CollectionGroupedQueryRequestFields
).annotate({ identifier: 'BoltCollectionGroupedQueryRequest' });
export interface CollectionGroupedQueryRequest
	extends Schema.Schema.Type<typeof CollectionGroupedQueryRequest> {}

/** The commit position sampled immediately before an authoritative query executes. */
export const CollectionReadCursor = Schema.Struct({
	xid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
	sequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
}).annotate({ identifier: 'BoltCollectionReadCursor' });
export interface CollectionReadCursor extends Schema.Schema.Type<typeof CollectionReadCursor> {}

/** Query semantics the local PGlite evaluator and authoritative PostgreSQL evaluator share. */
export const CollectionQuerySemantics = Schema.Struct({
	version: Schema.Literal(1),
	/** `none` means this query does not execute a collation-sensitive operation. */
	collation: Schema.Literals(['none', 'postgres-c-v1']),
	/** The exact authored operator vocabulary exercised by this query. */
	operators: Schema.Array(Schema.NonEmptyString)
}).annotate({ identifier: 'BoltCollectionQuerySemantics' });
export interface CollectionQuerySemantics
	extends Schema.Schema.Type<typeof CollectionQuerySemantics> {}

/**
 * Whether an installed window may own a local exactness proof.
 *
 * Server-proof windows are still durable and immediately renderable. They are never represented as
 * exact while offline; dependency generations only decide when their bounded authoritative refill
 * is due.
 */
export const CollectionQueryReproducibility = Schema.TaggedUnion({
	LocalExact: { semantics: CollectionQuerySemantics },
	ServerProof: {
		reasons: Schema.Array(
			Schema.Literals([
				'aggregate',
				'grouped',
				'local-relationships-unavailable',
				'local-search-unavailable',
				'unpinned-collation',
				'unsupported-operator',
				'unknown-query-shape'
			])
		)
	}
}).annotate({ identifier: 'BoltCollectionQueryReproducibility' });
export type CollectionQueryReproducibility = typeof CollectionQueryReproducibility.Type;

const CollectionDependencyGenerations = Schema.Record(
	Schema.String,
	Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
);

const CollectionQueryProofFields = {
	readCursor: CollectionReadCursor,
	partitionKey: Schema.NonEmptyString,
	confirmedDependencies: Schema.Array(Schema.NonEmptyString),
	dependencyGenerations: CollectionDependencyGenerations,
	reproducibility: CollectionQueryReproducibility
};

/** One normalized full permitted row installed once in the O3 base store. */
export const CollectionHydrationRow = Schema.Struct({
	collection: Schema.NonEmptyString,
	recordId: Schema.NonEmptyString,
	rowVersion: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
	row: StoredRecord
}).annotate({ identifier: 'BoltCollectionHydrationRow' });
export interface CollectionHydrationRow
	extends Schema.Schema.Type<typeof CollectionHydrationRow> {}

/**
 * A normalized edge from a window row to a related base row.
 *
 * These refs are membership, not a second payload: storage uses them to protect join targets for as
 * long as the window can render through that relationship.
 */
export const CollectionRelationshipMembership = Schema.Struct({
	sourceCollection: Schema.NonEmptyString,
	sourceRecordId: Schema.NonEmptyString,
	relation: Schema.NonEmptyString,
	targetCollection: Schema.NonEmptyString,
	targetRecordId: Schema.NonEmptyString
}).annotate({ identifier: 'BoltCollectionRelationshipMembership' });
export interface CollectionRelationshipMembership
	extends Schema.Schema.Type<typeof CollectionRelationshipMembership> {}

/**
 * One bounded authoritative extension of a canonical query window.
 *
 * `rows` contains full permitted rows for the requested visible page followed by `lookahead`
 * trailing rows. A continuation starts after the final returned row and extends the same window;
 * it never creates a page-shaped sibling proof.
 */
export const CollectionQueryPage = Schema.Struct({
	rows: Schema.Array(StoredRecord),
	/** Root and related records normalized for one-copy base-store installation. */
	baseRows: Schema.Array(CollectionHydrationRow),
	/** Relationship membership protecting normalized related rows from eviction. */
	relationshipRefs: Schema.Array(CollectionRelationshipMembership),
	/** Public page turn: starts after the visible prefix, before retained lookahead. */
	pageCursor: Schema.NullOr(Schema.NonEmptyString),
	/** Hydration continuation: starts after every returned row and extends this window. */
	nextCursor: Schema.NullOr(Schema.NonEmptyString),
	lookahead: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
	...CollectionQueryProofFields
}).annotate({ identifier: 'BoltCollectionQueryPage' });
export interface CollectionQueryPage extends Schema.Schema.Type<typeof CollectionQueryPage> {}

/**
 * Exact authoritative groups plus normalized one-copy hydration rows.
 *
 * The public `groups` retain their immediate nested relationship shape. Durable storage keeps only
 * each lane's ordered root ids, `baseRows`, and `relationshipRefs`; it never persists nested rows a
 * second time.
 */
export const CollectionGroupedWindow = Schema.Struct({
	groups: Schema.Record(Schema.String, Schema.Array(StoredRecord)),
	baseRows: Schema.Array(CollectionHydrationRow),
	relationshipRefs: Schema.Array(CollectionRelationshipMembership),
	...CollectionQueryProofFields
}).annotate({ identifier: 'BoltCollectionGroupedWindow' });
export interface CollectionGroupedWindow
	extends Schema.Schema.Type<typeof CollectionGroupedWindow> {}

/** Counts are always server-proof because a bounded working set cannot prove a global aggregate. */
export const CollectionCountWindow = Schema.Struct({
	count: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
	...CollectionQueryProofFields
}).annotate({ identifier: 'BoltCollectionCountWindow' });
export interface CollectionCountWindow
	extends Schema.Schema.Type<typeof CollectionCountWindow> {}

/** The explicit server-side M4 classification returned for one local-first journal push. */
export const CollectionMutationSettlement = Schema.Union([
	Schema.Struct({
		resolution: Schema.Literal('accepted'),
		mutationId: CollectionMutationIdempotencyKey,
		deviceSequence: CollectionMutationDeviceSequence,
		schemaFingerprint: Schema.NonEmptyString,
		records: Schema.Array(StoredRecord),
		/** Present when policy accepted the mutation into an approval flow but has not committed it. */
		pendingApproval: Schema.optionalKey(
			Schema.Struct({
				requestId: Schema.NonEmptyString,
				collection: Schema.NonEmptyString,
				id: Schema.NonEmptyString,
				action: Schema.Literals(['create', 'update', 'delete'])
			})
		)
	}),
	Schema.Struct({
		resolution: Schema.Literal('rebased'),
		mutationId: CollectionMutationIdempotencyKey,
		deviceSequence: CollectionMutationDeviceSequence,
		fromSchemaFingerprint: Schema.NonEmptyString,
		toSchemaFingerprint: Schema.NonEmptyString,
		records: Schema.Array(StoredRecord)
	}),
	Schema.Struct({
		resolution: Schema.Literal('rejected'),
		mutationId: CollectionMutationIdempotencyKey,
		deviceSequence: CollectionMutationDeviceSequence,
		code: Schema.Literals(['refused', 'forbidden', 'conflict']),
		message: Schema.NonEmptyString,
		schemaFingerprint: Schema.NonEmptyString
	}),
	Schema.Struct({
		resolution: Schema.Literal('quarantined'),
		mutationId: CollectionMutationIdempotencyKey,
		deviceSequence: CollectionMutationDeviceSequence,
		schemaFingerprint: Schema.NonEmptyString,
		reason: Schema.NonEmptyString
	})
]).annotate({ identifier: 'BoltCollectionMutationSettlement' });
export type CollectionMutationSettlement = typeof CollectionMutationSettlement.Type;
