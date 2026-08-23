import { Option, Schema } from 'effect';

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
 * The body of the browser's one declarative collection write.
 *
 * `values` is one root record and every explicitly included `many` relationship is the complete
 * desired state of that relationship. Rows carrying an `id` are updated, rows without one are
 * inserted, and stored related rows omitted from an included relationship are deleted. A
 * relationship key that is absent is deliberately untouched. The collection runtime validates the
 * actual relationship names because only the compiled workspace knows them; this neutral wire
 * package can state only that the submitted value is a JSON graph.
 *
 * There is no top-level `id`: the root's identity belongs to the root record itself, which gives the
 * same shape to roots and nested records. There is also no `subject`; the command boundary injects
 * it from the authenticated credential, so a request body cannot write as another tenant member.
 */
export const CollectionMutateRequest = Schema.Struct({
	collection: Schema.NonEmptyString,
	values: CollectionWriteValues
}).annotate({ identifier: 'BoltCollectionMutateRequest' });
export interface CollectionMutateRequest extends Schema.Schema.Type<
	typeof CollectionMutateRequest
> {}

/** One row exactly as the database holds it, defaults and generated columns included. */
export const StoredRecord = Schema.Record(Schema.String, Schema.Json).annotate({
	identifier: 'BoltStoredRecord'
});
export type StoredRecord = typeof StoredRecord.Type;

/**
 * What a collection write answers with: the rows as stored, never the values that were submitted.
 *
 * The distinction is the whole reason this shape exists. A submitted value is not what the database
 * holds once a column default, a generated column and a `create.before` hook have run — a payroll
 * run is posted with four fields and stored with ten — so a client that echoed its own submission
 * back into its cache was caching a record that has never existed anywhere. Every write answers
 * from the read-back the runtime already performs, so the cache holds what a subsequent read would
 * return.
 *
 * `records` remains an array at the transport boundary even though `collections.mutate` submits one
 * root. A server may include the readable roots already produced by its canonical pipeline, but the
 * browser mutation does not require one: a write-only policy can authorize the command while denying
 * readback. Live queries own stored values and refresh after success. Related rows are likewise
 * reached through declared relations on the next read.
 */
export const CollectionWriteResult = Schema.Struct({
	records: Schema.Array(StoredRecord)
}).annotate({ identifier: 'BoltCollectionWriteResult' });
export interface CollectionWriteResult extends Schema.Schema.Type<typeof CollectionWriteResult> {}

/**
 * A mutation accepted for approval rather than committed.
 *
 * HTTP 202 is successful at the transport layer, so this body is part of the collection wire
 * vocabulary instead of a malformed stored-row response. The browser surfaces it as a typed
 * rejection because returning it alongside a row would force every generic editor to decide
 * whether an approval request should close that editor.
 */
export const CollectionPendingApproval = Schema.Struct({
	pending: Schema.Literal(true),
	requestId: Schema.NonEmptyString,
	collection: Schema.NonEmptyString,
	id: Schema.NonEmptyString,
	action: Schema.Literals(['create', 'update', 'delete'])
}).annotate({ identifier: 'BoltCollectionPendingApproval' });
export interface CollectionPendingApproval extends Schema.Schema.Type<
	typeof CollectionPendingApproval
> {}

/**
 * Reads the stored rows out of a write response, or `undefined` when it carries none.
 *
 * Shared by both halves rather than decoded differently at each call site: a client that guesses at
 * the envelope and falls back to something plausible turns "the server answered in a shape I do not
 * recognise" into "the write succeeded and returned nothing". `undefined` means *unrecognised*,
 * and the caller is expected to fail on it.
 */
export const storedRecordsOf = (value: unknown): ReadonlyArray<StoredRecord> | undefined => {
	const decoded = Schema.decodeUnknownOption(CollectionWriteResult)(value);
	return Option.getOrUndefined(Option.map(decoded, ({ records }) => records));
};

/** Reads a successful pending-approval response without conflating it with a stored-row result. */
export const pendingApprovalOf = (value: unknown): CollectionPendingApproval | undefined =>
	Option.getOrUndefined(Schema.decodeUnknownOption(CollectionPendingApproval)(value));
