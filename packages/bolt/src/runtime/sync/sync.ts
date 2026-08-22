import { Context, Effect, Layer, Number as ENumber, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
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

const JsonObject = Schema.Record(Schema.String, Schema.Json);

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
const COMMIT_HORIZON = 'pg_snapshot_xmin(pg_current_snapshot())::text::bigint';

/** Orders two cursors the way the outbox does. */
const compareCursors = (left: SyncCursor, right: SyncCursor): number =>
	left.xid === right.xid ? left.sequence - right.sequence : left.xid - right.xid;

export const SyncCursor = Schema.Struct({
	xid: Schema.Number.check(Schema.isInt()),
	sequence: Schema.Number.check(Schema.isInt())
});
export interface SyncCursor extends Schema.Schema.Type<typeof SyncCursor> {}
export const SyncChange = Schema.Struct({
	cursor: SyncCursor,
	collection: Schema.NonEmptyString,
	recordId: Schema.NonEmptyString,
	operation: Schema.Literals(['create', 'update', 'delete', 'reset']),
	record: Schema.optionalKey(Schema.Json)
});
export interface SyncChange extends Schema.Schema.Type<typeof SyncChange> {}

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
export interface SyncSnapshotPage extends Schema.Schema.Type<typeof SyncSnapshotPage> {}

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
	 * A replica cannot be built from the log alone: only writes through `Collections` reach the outbox,
	 * so seeded, imported and directly-written rows are absent from it entirely. Replaying from the
	 * origin against a freshly seeded workspace yields nothing and the replica concludes, correctly by
	 * its own reasoning and wrongly in fact, that the workspace is empty.
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
		return Service.of({
			head: Effect.fn('Sync.head')(function* (effectId) {
				// Bounded by the same horizon `diff` serves under. A head taken from `max(xid)` would name a
				// position `diff` refuses to reach while any transaction below it is still open, so a client
				// that stored it would sit one poll behind forever and a client comparing its cursor against
				// it would conclude it had fallen off history.
				const result = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: `select coalesce(max(xid), 0) as xid, coalesce(max(sequence), 0) as sequence from bolt_sync_outbox where xid < ${COMMIT_HORIZON}`,
					parameters: []
				});
				return yield* Schema.decodeUnknownEffect(SyncCursor)(
					result.rows[0] ?? { xid: 0, sequence: 0 }
				).pipe(Effect.mapError(() => new SyncDecodeError({ message: 'Invalid sync head row' })));
			}),
			diff: Effect.fn('Sync.diff')(function* (effectId, subject, cursor, limit) {
				// Read from the mark retention writes, not from the oldest surviving row. The old test —
				// "is the cursor behind the first row still in the table" — could never be true, because
				// nothing ever deleted a row; the reset path was unreachable and a stranded client had no way
				// to be told. A cursor at the origin is a new replica and is never reset: it is about to be
				// served the whole log, or a snapshot.
				const marked = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: 'select xid, sequence from bolt_sync_horizon where singleton',
					parameters: []
				});
				const incompleteBelow =
					marked.rows[0] === undefined
						? undefined
						: yield* Schema.decodeUnknownEffect(SyncCursor)(marked.rows[0]).pipe(
								Effect.mapError(() => new SyncDecodeError({ message: 'Invalid sync horizon row' }))
							);
				if (
					incompleteBelow !== undefined &&
					cursor.xid > 0 &&
					compareCursors(cursor, incompleteBelow) < 0
				) {
					return [
						{
							cursor: incompleteBelow,
							collection: '*',
							recordId: 'reset',
							operation: 'reset' as const
						}
					];
				}
				const readable = workspace.definition.collections.flatMap((collection) => {
					if (collection.sync === false) return [];
					const predicate = access.predicate(subject, 'read', collection.name);
					return predicate.allowed ? [{ name: collection.name, predicate }] : [];
				});
				if (readable.length === 0) return [];
				const visibilityParameters: Array<Schema.Json> = [];
				const visibilitySql = readable
					.map(({ name, predicate }) => {
						const collectionIndex = visibilityParameters.push(name);
						const predicateOffset = visibilityParameters.length;
						visibilityParameters.push(...predicate.parameters);
						const sql = predicate.sql.replaceAll(
							/\$(\d+)/g,
							(_token, index: string) => `$${Number(index) + predicateOffset + 3}`
						);
						const table = `"${name.replaceAll('"', '""')}"`;
						return `(o.collection_name = $${collectionIndex + 3} and (o.operation = 'delete' or exists (select 1 from ${table} visible where visible.id::text = o.record_id and (${sql}))))`;
					})
					.join(' or ');
				const result = yield* database.execute(effectId, {
					_tag: 'Query',
					// `o.xid < ${COMMIT_HORIZON}` is what makes the stream lossless, and it is the whole of the
					// fix for a bug that silently dropped writes. Rows are ordered by `(xid, sequence)`, which
					// is *insert* order, while they become visible in *commit* order. A transaction that began
					// before another and committed after it therefore carries a lower cursor than rows the
					// client has already consumed, so the client's next `>` request skips it — permanently, with
					// no error anywhere. Serving only rows below the oldest in-flight transaction means no row
					// can ever appear behind a cursor that has already passed: a client is delayed by an open
					// write, never robbed of one.
					sql: `select jsonb_build_object('xid', o.xid, 'sequence', o.sequence) as cursor, o.collection_name as collection, o.record_id as "recordId", o.operation, o.record from bolt_sync_outbox o where (o.xid, o.sequence) > ($1, $2) and o.xid < ${COMMIT_HORIZON} and (${visibilitySql}) order by o.xid, o.sequence limit $3`,
					parameters: [
						cursor.xid,
						cursor.sequence,
						ENumber.clamp({ minimum: 1, maximum: 500 })(limit),
						...visibilityParameters
					]
				});
				const changes = yield* Schema.decodeUnknownEffect(Schema.Array(SyncChange))(
					result.rows
				).pipe(Effect.mapError(() => new SyncDecodeError({ message: 'Invalid sync diff rows' })));
				// Row visibility is decided in SQL above; *column* visibility is decided here, by the same
				// `access.mask` a direct read goes through. Without it the outbox's `to_jsonb(r)` hands the
				// whole row over — a field-restricted policy would be enforced on every server read and then
				// quietly undone by the replica, which persists what it receives in the browser.
				return changes.map((change) =>
					change.record === null || change.record === undefined
						? change
						: { ...change, record: maskRecord(subject, change.collection, change.record) }
				);
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
				const table = `"${collection.replaceAll('"', '""')}"`;
				// Keyset paging on the primary key, not offset: a snapshot of a live table is paged while it
				// is being written, and `offset` re-reads shifted rows — skipping some and repeating others.
				// Ordering by `id` also makes `after` a position rather than a count.
				const parameters: Array<Schema.Json> = [];
				const afterClause =
					after === undefined ? 'true' : `r.id > $${parameters.push(after)}::uuid`;
				const predicateOffset = parameters.length;
				parameters.push(...predicate.parameters);
				const visibility = predicate.sql.replaceAll(
					/\$(\d+)/g,
					(_token, index: string) => `$${Number(index) + predicateOffset}`
				);
				const pageSize = parameters.push(size + 1);
				// The horizon is read in the same statement as the rows, so it names the state these rows are
				// consistent with rather than a moment before or after them.
				const result = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: `select (select coalesce(${COMMIT_HORIZON}, 0)) as "snapshotXid", to_jsonb(r) as record, r.id::text as id from ${table} r where ${afterClause} and (${visibility}) order by r.id limit $${pageSize}`,
					parameters
				});
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
				// Only below the commit horizon: a row from a transaction that may still be open has no
				// settled position, and collapsing around it would decide an ordering the database has not.
				const collapsed = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: `delete from bolt_sync_outbox o where o.xid < ${COMMIT_HORIZON} and exists (select 1 from bolt_sync_outbox newer where newer.collection_name = o.collection_name and newer.record_id = o.record_id and newer.xid < ${COMMIT_HORIZON} and (newer.xid, newer.sequence) > (o.xid, o.sequence)) returning 1`,
					parameters: []
				});
				// Retention is the only operation that can strand a replica, because it can remove the newest
				// row a record ever had. The mark moves to the highest cursor it deleted, and `diff` answers
				// anything below that with a rebuild instead of a silently incomplete stream.
				const pruned = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: `delete from bolt_sync_outbox o where o.xid < ${COMMIT_HORIZON} and o.created_at < now() - ($1 || ' days')::interval returning o.xid, o.sequence`,
					parameters: [String(days)]
				});
				const cursors = pruned.rows.flatMap((row) =>
					row !== null && typeof row === 'object' && !Array.isArray(row)
						? [
								{
									xid: Number(Reflect.get(row, 'xid') ?? 0),
									sequence: Number(Reflect.get(row, 'sequence') ?? 0)
								}
							]
						: []
				);
				const highest = cursors.reduce<SyncCursor | undefined>(
					(best, entry) => (best === undefined || compareCursors(entry, best) > 0 ? entry : best),
					undefined
				);
				if (highest !== undefined) {
					yield* database.execute(effectId, {
						_tag: 'Query',
						// `greatest` because a later compaction must never move the mark backwards: that would
						// re-admit cursors already declared stranded.
						sql: 'update bolt_sync_horizon set xid = greatest(xid, $1), sequence = case when $1 > xid then $2 else greatest(sequence, $2) end where singleton',
						parameters: [highest.xid, highest.sequence]
					});
				}
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
		});
	})
);
