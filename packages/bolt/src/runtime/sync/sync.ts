import { Context, Effect, Layer, Number as ENumber, Schema } from 'effect';
import { and, asc, eq, exists, gt, lt, max, or } from 'drizzle-orm';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import * as Collections from '#lib/runtime/collections/collections.js';
import { PendingApproval } from '#lib/runtime/collections/collections.js';
import { ApprovalConflict } from '#lib/runtime/approvals/approvals.js';
import * as Database from '#lib/runtime/facilities/database.js';
import type * as Identity from '#lib/runtime/identity/identity.js';
import * as Workspace from '#lib/runtime/workspace.js';
import { AuthoredRefusal } from '#lib/authoring/refusal.js';
import * as InvocationBudget from '#lib/runtime/budget.js';
import { decodeReferenceRow } from '#lib/runtime/collections/references.js';
import * as Compaction from '#lib/runtime/sync/compaction.js';
import {
	aliased,
	asText,
	coalesce,
	commitHorizon,
	composer,
	dynamicTable,
	executeBuilt,
	nothing,
	one,
	onlyWhen,
	qualified,
	rowJson,
	syncCursorJson,
	uuidAfter
} from '#lib/runtime/persistence.js';

const JsonObject = Schema.Record(Schema.String, Schema.Json);
const { bolt_sync_horizon: syncHorizon, bolt_sync_outbox: syncOutbox } = SYSTEM_MODEL_TABLES;

/** The `Schema.Json` predicate, built once: it is consulted for every value crossing the facility seam. */
const isJson = Schema.is(Schema.Json);
const isJsonObject = Schema.is(JsonObject);

/** Identity collections by name, for the membership checks the change stream and shape both perform. */

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
const compareCursors = (left: SyncCursor, right: SyncCursor): number =>
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
export const SyncChange = Schema.Struct({
	cursor: SyncCursor,
	collection: Schema.NonEmptyString,
	recordId: Schema.NonEmptyString,
	operation: Schema.Literals(['create', 'update', 'delete', 'reset']),
	record: Schema.optionalKey(Schema.Json)
});
export interface SyncChange extends Schema.Schema.Type<typeof SyncChange> {}

/**
 * One pass over the change log: what was examined, and what of it may be applied.
 *
 * The two are different facts and conflating them is a real defect rather than a tidiness question.
 * A subject whose policy narrows a collection to a handful of rows can be handed a page of the log
 * that contains none of theirs — and a caller told only "no changes" has nothing to advance a cursor
 * to, so its next wake rescans the same invisible range, and the one after that, forever.
 *
 * `scanned` is the last outbox row this pass *looked at*, whether or not the subject may see it.
 * `complete` says the window was not filled, which is the only honest end-of-log signal once the
 * limit bounds rows examined rather than rows returned.
 *
 * **`scanned` is not an apply cursor.** Row visibility is decided against the collection's current
 * state, so a row that is invisible now can become visible later — a record reassigned to the
 * subject's team, say. A caller that hands `scanned` to a replica as its durable position would make
 * that row permanently unreachable. It is a within-connection scan position: the server carries it
 * while it reads, and the client's own cursor advances only over changes it was actually given.
 */
export const SyncScan = Schema.Struct({
	changes: Schema.Array(SyncChange),
	scanned: SyncCursor,
	complete: Schema.Boolean
});
export interface SyncScan extends Schema.Schema.Type<typeof SyncScan> {}

/**
 * One outbox row as the scan reads it: always a position, and the rest only where the subject may
 * see it.
 *
 * The columns are nulled in SQL rather than filtered in the guest so that a row this subject may not
 * read crosses the facility boundary as a cursor and nothing else — no record body, and not even
 * which collection it belonged to.
 */
const SyncScanRow = Schema.Struct({
	cursor: SyncCursor,
	collection: Schema.NullOr(Schema.NonEmptyString),
	recordId: Schema.NullOr(Schema.NonEmptyString),
	operation: Schema.NullOr(Schema.Literals(['create', 'update', 'delete'])),
	record: Schema.Json
});

/**
 * One page of a collection's current state, taken at a cursor the log can be streamed from.
 *
 * `cursor` is the commit horizon at the moment the page was read, so everything already reflected in
 * these rows sits below it and everything after arrives through `diff`. Anything that commits while
 * the snapshot is being paged is delivered twice — once here, once from the log — which is why the
 * replica applies rows as upserts. At-least-once is the achievable guarantee; exactly-once across a
 * paged read and a live log is not, and pretending otherwise is how rows go missing.
 */
const SyncSnapshotPage = Schema.Struct({
	collection: Schema.NonEmptyString,
	rows: Schema.Array(Schema.Json),
	cursor: SyncCursor,
	/** The id to pass as `after` for the next page; `null` when the collection is exhausted. */
	nextAfter: Schema.NullOr(Schema.String)
});
interface SyncSnapshotPage extends Schema.Schema.Type<typeof SyncSnapshotPage> {}

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
	/**
	 * One window of the log after `cursor`: at most `limit` rows examined, and what of them applies.
	 *
	 * `limit` bounds rows *read*, not changes returned. That is what makes one pass constant work
	 * regardless of how much of the log this subject can see — the previous shape applied the
	 * visibility predicate first and the limit after, so filling a page for a narrowly-scoped subject
	 * could scan the whole log, and failing to fill one always did.
	 */
	readonly scan: (
		effectId: EffectId,
		subject: Identity.Subject,
		cursor: SyncCursor,
		limit: number
	) => Effect.Effect<
		SyncScan,
		Database.FacilityError | SyncDecodeError | AccessControl.AccessDenied
	>;
	/** `scan` projected to the rows the caller may apply, for a caller with nothing to advance. */
	readonly diff: (
		effectId: EffectId,
		subject: Identity.Subject,
		cursor: SyncCursor,
		limit: number
	) => Effect.Effect<
		ReadonlyArray<SyncChange>,
		Database.FacilityError | SyncDecodeError | AccessControl.AccessDenied
	>;
	readonly shape: (
		subject: Identity.Subject
	) => Effect.Effect<ReadonlyArray<string>, AccessControl.AccessDenied>;
	/**
	 * The current state of one collection, plus the cursor the caller should stream on from.
	 *
	 * A replica still starts from a snapshot rather than replaying an unbounded log. Database triggers
	 * capture collection writes regardless of whether they came through `Collections`, a seed, an import,
	 * or a runtime projection; the snapshot supplies current state while its cursor makes later outbox
	 * changes an ordered continuation.
	 */
	readonly snapshot: (
		effectId: EffectId,
		subject: Identity.Subject,
		collection: string,
		after: string | undefined,
		limit: number
	) => Effect.Effect<
		SyncSnapshotPage,
		Database.FacilityError | SyncDecodeError | AccessControl.AccessDenied
	>;
	/** Collapses superseded log rows and prunes past the retention window. Returns what it removed. */
	readonly compact: (
		effectId: EffectId,
		retentionDays: number
	) => Effect.Effect<
		{ readonly collapsed: number; readonly pruned: number },
		Database.FacilityError | SyncDecodeError
	>;
	readonly schema: () => { readonly cursor: 'xid-sequence'; readonly version: 1 };
	/** Fails with whatever the underlying collection write fails with: refusal, conflict, or a held approval. */
	readonly mutate: (
		effectId: EffectId,
		subject: Identity.Subject,
		changes: ReadonlyArray<SyncChange>
	) => Effect.Effect<
		void,
		| Database.FacilityError
		| AccessControl.AccessDenied
		| Workspace.WorkspaceLookupError
		| ApprovalConflict
		| PendingApproval
		// A client mutation is an ordinary collection write, so it can be refused by an authored
		// rule or stopped by the hook-recursion bound exactly as any other write can. Declared
		// rather than inferred so a caller that handles this union exhaustively has to decide what
		// a refused sync change means for the replica that sent it — which is a real decision, and
		// a different one from "the write failed".
		| AuthoredRefusal
		| InvocationBudget.NestingLimitExceeded
	>;
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
		const collections = yield* Collections.Service;
		// Named rather than returned inline so `diff` can be exactly `scan` projected, instead of a
		// second query that has to be kept in step with it.
		const service: Interface = {
			head: Effect.fn('Sync.head')(function* (effectId) {
				// Bounded by the same horizon `diff` serves under. A head taken from `max(xid)` would name a
				// position `diff` refuses to reach while any transaction below it is still open, so a client
				// that stored it would sit one poll behind forever and a client comparing its cursor against
				// it would conclude it had fallen off history.
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
			}),
			scan: Effect.fn('Sync.scan')(function* (effectId, subject, cursor, limit) {
				// Read from the mark retention writes, not from the oldest surviving row. The old test —
				// "is the cursor behind the first row still in the table" — could never be true, because
				// nothing ever deleted a row; the reset path was unreachable and a stranded client had no way
				// to be told. A cursor at the origin is a new replica and is never reset: it is about to be
				// served the whole log, or a snapshot.
				const marked = yield* executeBuilt(
					effectId,
					database,
					composer
						.select({ xid: syncHorizon.xid, sequence: syncHorizon.sequence })
						.from(syncHorizon)
						.where(eq(syncHorizon.singleton, true))
						.limit(1)
				);
				const incompleteBelow =
					marked.rows[0] === undefined
						? undefined
						: yield* decodeDatabaseSyncCursor(marked.rows[0]).pipe(
								Effect.mapError(() => new SyncDecodeError({ message: 'Invalid sync horizon row' }))
							);
				if (
					incompleteBelow !== undefined &&
					cursor.xid > 0 &&
					compareCursors(cursor, incompleteBelow) < 0
				) {
					// Not `complete`: the mark is a new starting point rather than the end of the log, so the
					// caller has to keep reading from it.
					return {
						changes: [
							{
								cursor: incompleteBelow,
								collection: '*',
								recordId: 'reset',
								operation: 'reset' as const
							}
						],
						scanned: incompleteBelow,
						complete: false
					};
				}
				const readable = workspace.definition.collections.flatMap((collection) => {
					if (collection.sync === false) return [];
					const predicate = access.predicate(subject, 'read', collection.name);
					return predicate.allowed ? [{ name: collection.name, predicate }] : [];
				});
				// Nothing to examine rather than nothing found: a subject who may read no collection at all
				// has no log to walk, so there is no position to advance to.
				if (readable.length === 0) return { changes: [], scanned: cursor, complete: true };
				const visibility = readable.map(({ name, predicate }) => {
					const visibleId = qualified('visible', 'id');
					const visibleRows = composer
						.select({ one: one() })
						.from(dynamicTable(name, 'visible'))
						.where(
							and(
								eq(asText(visibleId), syncOutbox.record_id),
								AccessControl.predicateExpression(predicate)
							)
						);
					return and(
						eq(syncOutbox.collection_name, name),
						or(eq(syncOutbox.operation, 'delete'), exists(visibleRows))
					);
				});
				// `or` is nullable and there is no readable collection left for it to be null on — the
				// early return above took that case. `nothing()` rather than `always()` all the same: the
				// fallback for a visibility expression has to be the one that shows nothing.
				const visible = or(...visibility) ?? nothing();
				const size = ENumber.clamp({ minimum: 1, maximum: 500 })(limit);
				// The commit-horizon predicate is what makes the stream lossless. Rows are inserted in
				// transaction order but become visible in commit order; withholding every transaction at or
				// above the oldest in-flight xid means no late commit can appear behind a cursor already served.
				//
				// Visibility moved out of the `where` and into the projection, and that is the whole of the
				// scan-cursor fix: the limit now bounds the window this pass reads, so the last row of the
				// window is a position the caller can advance to whether or not any of it was theirs.
				const result = yield* executeBuilt(
					effectId,
					database,
					composer
						.select({
							cursor: aliased(syncCursorJson(syncOutbox.xid, syncOutbox.sequence), 'cursor'),
							collection: aliased(onlyWhen(visible, syncOutbox.collection_name), 'collection'),
							recordId: aliased(onlyWhen(visible, syncOutbox.record_id), 'recordId'),
							operation: aliased(onlyWhen(visible, syncOutbox.operation), 'operation'),
							record: aliased(onlyWhen(visible, syncOutbox.record), 'record')
						})
						.from(syncOutbox)
						.where(
							and(
								or(
									gt(syncOutbox.xid, cursor.xid),
									and(eq(syncOutbox.xid, cursor.xid), gt(syncOutbox.sequence, cursor.sequence))
								),
								lt(syncOutbox.xid, COMMIT_HORIZON)
							)
						)
						.orderBy(asc(syncOutbox.xid), asc(syncOutbox.sequence))
						.limit(size)
				);
				const rows = yield* Schema.decodeUnknownEffect(Schema.Array(SyncScanRow))(result.rows).pipe(
					Effect.mapError(() => new SyncDecodeError({ message: 'Invalid sync diff rows' }))
				);
				// Row visibility is decided in SQL above; *column* visibility is decided here, by the same
				// `access.mask` a direct read goes through. Without it the outbox's `to_jsonb(r)` hands the
				// whole row over — a field-restricted policy would be enforced on every server read and then
				// quietly undone by the replica, which persists what it receives in the browser.
				const changes = rows.flatMap((row) =>
					row.collection === null || row.recordId === null || row.operation === null
						? []
						: [
								{
									cursor: row.cursor,
									collection: row.collection,
									recordId: row.recordId,
									operation: row.operation,
									record:
										row.record == null
											? row.record
											: maskRecord(subject, row.collection, row.record)
								}
							]
				);
				return {
					changes,
					scanned: rows[rows.length - 1]?.cursor ?? cursor,
					complete: rows.length < size
				};
			}),
			diff: Effect.fn('Sync.diff')(function* (effectId, subject, cursor, limit) {
				return (yield* service.scan(effectId, subject, cursor, limit)).changes;
			}),
			shape: Effect.fn('Sync.shape')(function* (subject) {
				return workspace.definition.collections
					.flatMap((collection) =>
						collection.sync === false
							? []
							: access.predicate(subject, 'read', collection.name).allowed
								? [collection.name]
								: []
					)
					.toSorted();
			}),
			snapshot: Effect.fn('Sync.snapshot')(function* (effectId, subject, collection, after, limit) {
				const predicate = access.predicate(subject, 'read', collection);
				if (!predicate.allowed) {
					return yield* new AccessControl.AccessDenied({
						action: 'read',
						resource: collection,
						reason: 'the subject may not read this collection'
					});
				}
				const size = ENumber.clamp({ minimum: 1, maximum: 500 })(limit);
				// Keyset paging on the primary key, not offset: a snapshot of a live table is paged while it
				// is being written, and `offset` re-reads shifted rows — skipping some and repeating others.
				// Ordering by `id` also makes `after` a position rather than a count.
				const snapshotId = qualified('snapshot_row', 'id');
				// The horizon is read in the same statement as the rows, so it names the state these rows are
				// consistent with rather than a moment before or after them.
				const result = yield* executeBuilt(
					effectId,
					database,
					composer
						.select({
							snapshotXid: aliased(coalesce(COMMIT_HORIZON, 0), 'snapshotXid'),
							record: aliased(rowJson('snapshot_row'), 'record'),
							id: aliased(asText(snapshotId), 'id')
						})
						.from(dynamicTable(collection, 'snapshot_row'))
						.where(
							and(
								after === undefined ? undefined : uuidAfter(snapshotId, after),
								AccessControl.predicateExpression(predicate)
							)
						)
						.orderBy(snapshotId)
						.limit(size + 1)
				);
				const rows = result.rows.slice(0, size);
				const read = (row: Schema.Json, key: string): unknown =>
					row !== null && typeof row === 'object' && !Array.isArray(row)
						? Reflect.get(row, key)
						: undefined;
				const snapshotXid = Number(read(result.rows[0] ?? null, 'snapshotXid') ?? 0);
				const lastId = read(rows[rows.length - 1] ?? null, 'id');
				return {
					collection,
					// Masked for the same reason the diff is: a snapshot is the bulk half of the same
					// delivery, and a column the subject may not read must not reach the browser through
					// either half.
					rows: rows.map((row) => {
						const record = read(row, 'record');
						return maskRecord(subject, collection, isJson(record) ? record : null);
					}),
					// `sequence: 0` with the horizon's xid: the client streams from strictly below the first
					// transaction that could still have been open, so nothing committed after this read is
					// assumed to be already present.
					cursor: { xid: Number.isFinite(snapshotXid) ? snapshotXid : 0, sequence: 0 },
					nextAfter: result.rows.length > size && typeof lastId === 'string' ? lastId : null
				};
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
			schema: () => ({ cursor: 'xid-sequence', version: 1 }),
			mutate: Effect.fn('Sync.mutate')(function* (effectId, subject, changes) {
				// A client mutation is an ordinary collection write. Routing it through Collections is
				// what makes it real: access predicates, approval interception, history, and the sync
				// outbox all live there, so the caller's own replica learns of it like any other write.
				// It used to be appended to `bolt_sync_inbox`, a table nothing ever read.
				for (const change of changes) {
					if (change.operation === 'reset') continue;
					const values = Schema.is(JsonObject)(change.record) ? change.record : {};
					const id = EffectId.make(
						`${effectId}:${change.collection}:${change.recordId}:${change.operation}`
					);
					if (change.operation === 'create') {
						yield* collections.create(id, subject, {
							collection: change.collection,
							id: change.recordId,
							values
						});
					} else if (change.operation === 'update') {
						yield* collections.update(id, subject, {
							collection: change.collection,
							id: change.recordId,
							values
						});
					} else {
						yield* collections.delete(id, subject, change.collection, change.recordId);
					}
				}
			}),
			wakeHint: (cursor) => ({ topic: 'bolt.sync', cursor })
		};
		return Service.of(service);
	})
);
