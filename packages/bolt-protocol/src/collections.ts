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
 * A client-generated idempotency key for one logical mutation.
 *
 * It is deliberately independent of an invocation id: transports are allowed to retry with a new
 * invocation, while the tenant database deduplicates this value under the authenticated scope. The
 * length cap keeps an attacker-controlled key from becoming an unbounded index entry.
 */
export const CollectionMutationIdempotencyKey = Schema.NonEmptyString.check(
	Schema.isMaxLength(256),
	Schema.makeFilter((value: string) => !value.includes('\u0000') || 'must not contain a NUL byte')
).pipe(Schema.brand('BoltCollectionMutationIdempotencyKey'));
export type CollectionMutationIdempotencyKey = typeof CollectionMutationIdempotencyKey.Type;

/** Row versions begin at one and advance once for every canonical update. */
export const CollectionBaseRowVersion = Schema.Number.check(
	Schema.isInt(),
	Schema.isGreaterThanOrEqualTo(1)
);
export type CollectionBaseRowVersion = typeof CollectionBaseRowVersion.Type;

/** Maximum age at which a missing server dedup record may still authorize a retry. */
export const COLLECTION_MUTATION_RETRY_HORIZON_MILLIS = 24 * 60 * 60 * 1000;

/**
 * How long a quarantined mutation's ledger row is kept before cleanup may drop its key.
 *
 * This is intentionally longer than the transport retry horizon above, which answers whether a
 * missing dedup row may be recreated. Once this horizon elapses, a re-push of the same key runs
 * again rather than replaying the quarantine — the only safe answer after the schema the write was
 * stated against is gone.
 */
export const COLLECTION_MUTATION_QUARANTINE_RETENTION_MILLIS = 14 * 24 * 60 * 60 * 1000;

/** One authoritative whole-row version captured before an optimistic graph was overlaid. */
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
	 * When the client first minted the key. A server accepts a missing dedup row only inside its
	 * bounded retry horizon, so pruning old rows can never turn a very late retry into a new write.
	 */
	issuedAtEpochMs: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isFinite())
};

/**
 * The declarative graph submitted for one mutation.
 *
 * Keeping the verb inside the graph makes the surrounding push envelope stable. The graph is
 * the mutation-visible payload; it cannot rewrite the idempotency key, authenticated partition
 * binding, or the versions against which it reconciles.
 * Client-authored creates carry their client-minted identity inside `values`; the authoritative
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
 * One declarative mutation push. Retry identity fields are immutable facts from the original
 * client submission.
 *
 * `partitionKey` is a client-chosen coordinate included in the canonical request digest. It is not
 * a database selector and confers no authority; tenant, environment, actor, effective subject and
 * impersonation are authenticated separately. `baseVersions` is a whole-row vector covering every
 * existing row the submitted graph may update or explicitly remove.
 */
export const CollectionMutationPush = Schema.Struct({
	protocolVersion: Schema.Literal(2),
	...CollectionMutationRetryIdentity,
	partitionKey: Schema.NonEmptyString,
	schemaFingerprint: Schema.NonEmptyString,
	graph: CollectionMutationGraph,
	baseVersions: Schema.Array(CollectionMutationBaseVersion)
}).annotate({ identifier: 'BoltCollectionMutationPush' });
export type CollectionMutationPush = typeof CollectionMutationPush.Type;

/**
 * The sole client mutation request. Subject, tenant, environment and authority are intentionally
 * absent: the authenticated command boundary supplies them. The client-chosen partition coordinate
 * participates in idempotency but grants no authority.
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
 * The explicit model-backed search command.
 *
 * Both modes are explicit discriminated commands. Keeping semantic search in a separate arm makes
 * it impossible for ordinary type-ahead traffic to reach the embedder by accident.
 */
export const CollectionLexicalSearch = Schema.Struct({
	mode: Schema.Literal('lexical'),
	term: Schema.NonEmptyString
}).annotate({ identifier: 'BoltCollectionLexicalSearch' });
export interface CollectionLexicalSearch extends Schema.Schema.Type<
	typeof CollectionLexicalSearch
> {}

export const CollectionSemanticSearch = Schema.Struct({
	mode: Schema.Literal('semantic'),
	term: Schema.NonEmptyString
}).annotate({ identifier: 'BoltCollectionSemanticSearch' });
export interface CollectionSemanticSearch extends Schema.Schema.Type<
	typeof CollectionSemanticSearch
> {}

export const CollectionSearch = Schema.Union([
	CollectionLexicalSearch,
	CollectionSemanticSearch
]).annotate({ identifier: 'BoltCollectionSearch' });
export type CollectionSearch = typeof CollectionSearch.Type;

/**
 * The collection read accepted by the browser command boundary.
 *
 * `where` is the predicate authored by the workspace. `userFilter` is the independently
 * canonicalized narrowing supplied by a generic surface. Keeping the two on the wire preserves
 * those independently authored constraints. `after` and `columns` deliberately remain request
 * concerns: neither is part of live-query identity.
 */
export const CollectionQueryRequestFields = {
	collection: Schema.NonEmptyString,
	where: Schema.optionalKey(Schema.Json),
	userFilter: Schema.optionalKey(Schema.Json),
	search: Schema.optionalKey(CollectionSearch),
	with: Schema.optionalKey(Schema.Json),
	orderBy: Schema.optionalKey(Schema.Json),
	limit: Schema.optionalKey(Schema.Number),
	after: Schema.optionalKey(Schema.String),
	columns: Schema.optionalKey(Schema.Json)
};
export const CollectionQueryRequest = Schema.Struct(CollectionQueryRequestFields).annotate({
	identifier: 'BoltCollectionQueryRequest'
});
export interface CollectionQueryRequest extends Schema.Schema.Type<typeof CollectionQueryRequest> {}

const { limit: _limit, after: _after, ...CollectionGroupedQueryBaseFields } =
	CollectionQueryRequestFields;

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
	...CollectionGroupedQueryBaseFields,
	group: CollectionGroup
};
export const CollectionGroupedQueryRequest = Schema.Struct(
	CollectionGroupedQueryRequestFields
).annotate({ identifier: 'BoltCollectionGroupedQueryRequest' });
export interface CollectionGroupedQueryRequest extends Schema.Schema.Type<
	typeof CollectionGroupedQueryRequest
> {}

/** The explicit server-side classification returned for one declarative mutation push. */
export const CollectionMutationSettlement = Schema.Union([
	Schema.Struct({
		resolution: Schema.Literal('accepted'),
		mutationId: CollectionMutationIdempotencyKey,
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
		fromSchemaFingerprint: Schema.NonEmptyString,
		toSchemaFingerprint: Schema.NonEmptyString,
		records: Schema.Array(StoredRecord)
	}),
	Schema.Struct({
		resolution: Schema.Literal('rejected'),
		mutationId: CollectionMutationIdempotencyKey,
		code: Schema.Literals(['refused', 'forbidden', 'conflict']),
		message: Schema.NonEmptyString,
		schemaFingerprint: Schema.NonEmptyString
	}),
	Schema.Struct({
		resolution: Schema.Literal('quarantined'),
		mutationId: CollectionMutationIdempotencyKey,
		schemaFingerprint: Schema.NonEmptyString,
		reason: Schema.NonEmptyString
	})
]).annotate({ identifier: 'BoltCollectionMutationSettlement' });
export type CollectionMutationSettlement = typeof CollectionMutationSettlement.Type;
