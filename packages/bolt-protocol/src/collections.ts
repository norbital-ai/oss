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
 * The body of `collections.create`, and the two fields it deliberately does not have.
 *
 * **No `id`.** It used to be required, and the browser minted it with `crypto.randomUUID()` before
 * posting. A key chosen by the caller is a key chosen before the write is authorized, before
 * `create.before` has run and before the database has applied a default — so the client held an
 * identifier for a row that might never exist, and a nested write could not be expressed at all,
 * because a child's foreign key names a parent whose id the client would have had to invent for it
 * too. The server assigns every id now, at the point the row is actually being built, and answers
 * with it.
 *
 * **No `subject`.** It is injected at the command boundary from the credential the request
 * authenticated with, for the same reason it is absent from every other tenant-data command: a body
 * that can name its own subject is a body that can write into someone else's tenant.
 */
export const CollectionCreateRequest = Schema.Struct({
	collection: Schema.NonEmptyString,
	values: CollectionWriteValues
}).annotate({ identifier: 'BoltCollectionCreateRequest' });
export interface CollectionCreateRequest extends Schema.Schema.Type<
	typeof CollectionCreateRequest
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
 * `records` is plural because a batch is the general case and a single create is a batch of one.
 * It carries the rows of the collection that was written, not the children a nested write also
 * created: reading those back would cost a query per child collection, and they are reachable
 * through the parent's declared relations on the next read.
 */
export const CollectionWriteResult = Schema.Struct({
	records: Schema.Array(StoredRecord)
}).annotate({ identifier: 'BoltCollectionWriteResult' });
export interface CollectionWriteResult extends Schema.Schema.Type<typeof CollectionWriteResult> {}

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
