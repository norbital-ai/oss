import { Effect, Result, Schema } from 'effect';
import { SyncCursor, type SyncChange } from '#lib/runtime/sync/sync.js';
import { compareCursors, ORIGIN_CURSOR } from '#lib/client/replica/sync-client.js';
import {
	createPGliteSql,
	bulkUpsert,
	markProvisioned,
	provision,
	readReplicaState,
	writeReplicaCursor,
	writableColumns,
	type PGliteLike,
	ProvisioningStep,
	type ProvisioningStep as ProvisioningStepType
} from '#lib/client/replica/pglite-sql.js';
import { ReplicaShape } from '#lib/client/replica/local-reads.js';
import type { LocalSql } from '#lib/client/replica/pglite-sql.js';

/**
 * Building a local database that holds the workspace, from nothing.
 *
 * Three steps in a fixed order, and the order is the correctness:
 *
 *  1. **Provision** from `sync.provisioning` — the tenant's own plan foundation plus its drizzle
 *     lineage. The client renders no DDL of its own, so a column's type here is the column's type on
 *     the server rather than a mapping that agrees with it today.
 *  2. **Snapshot** every readable collection. The log cannot serve this: only writes through
 *     `Collections` reach the outbox, so a seeded, imported or restored workspace is entirely absent
 *     from it and a log-only replica concludes the workspace is empty.
 *  3. **Stream** from the cursor the snapshot handed back.
 *
 * Anything that commits while step 2 is paging is delivered twice — once in the snapshot, once from
 * the log — which is why every write here is an upsert. At-least-once is the guarantee that is
 * actually available across a paged read and a live log; exactly-once would require tracking what had
 * already been seen, and that state can be wrong in a way an upsert cannot.
 */

export type BootstrapTransport = Readonly<{
	readonly command: (command: string, input: Schema.Json) => Effect.Effect<Schema.Json, unknown>;
}>;

const ProvisioningResponse = Schema.Struct({
	steps: Schema.Array(ProvisioningStep),
	fingerprint: Schema.String,
	collections: ReplicaShape.fields.collections,
	relations: ReplicaShape.fields.relations
});
const SnapshotRow = Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [
	Schema.Record(Schema.String, Schema.Json)
]);
const SnapshotPage = Schema.Struct({
	rows: Schema.Array(SnapshotRow),
	cursor: Schema.optionalKey(SyncCursor),
	nextAfter: Schema.optionalKey(Schema.NullOr(Schema.String))
});

/** The ordered DDL this tenant's database was provisioned with. */
const readProvisioning = Effect.fn('ReplicaBootstrap.readProvisioning')(function* (
	transport: BootstrapTransport
): Effect.fn.Return<
	{
		readonly steps: ReadonlyArray<ProvisioningStepType>;
		readonly fingerprint: string;
		readonly shape: ReplicaShape;
	},
	unknown
> {
	const raw = yield* transport.command('sync.provisioning', null);
	const answer = yield* Schema.decodeUnknownEffect(ProvisioningResponse)(raw);
	return {
		steps: answer.steps,
		fingerprint: answer.fingerprint,
		shape: { collections: answer.collections, relations: answer.relations }
	};
});

type SnapshotOutcome = Readonly<{
	/** Where the log must be streamed from so nothing between the snapshot and now is missed. */
	readonly cursor: SyncCursor;
	readonly rows: number;
}>;

type SnapshotWriter = (
	collection: string,
	rows: ReadonlyArray<Readonly<Record<string, unknown>>>
) => Effect.Effect<number, unknown>;

const oldestCursor = (
	current: SyncCursor | undefined,
	candidate: SyncCursor | undefined
): SyncCursor | undefined =>
	candidate === undefined || (current !== undefined && compareCursors(current, candidate) <= 0)
		? current
		: candidate;

/**
 * One page of one collection, decoded into what the snapshot loop needs.
 *
 * `undefined` means the server answered nothing at all — abort this collection's paging rather than
 * recording "no records". Rows are kept only when they name their `id`: an upsert cannot key
 * a row that cannot be rewritten, and one bad row failing a whole page would cost the page's good ones.
 */
const readSnapshotPage = Effect.fn('ReplicaBootstrap.readSnapshotPage')(function* (
	transport: BootstrapTransport,
	collection: string,
	pageSize: number,
	after: string | undefined
): Effect.fn.Return<
	| Readonly<{
			readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
			readonly cursor?: SyncCursor | undefined;
			readonly after?: string | undefined;
	  }>
	| undefined,
	unknown
> {
	const answer = yield* transport.command('sync.snapshot', {
		collection,
		limit: pageSize,
		...(after === undefined ? {} : { after })
	});
	const decoded = Schema.decodeUnknownResult(SnapshotPage)(answer);
	if (Result.isFailure(decoded)) return undefined;
	return {
		rows: decoded.success.rows,
		cursor: decoded.success.cursor,
		after: decoded.success.nextAfter ?? undefined
	};
});

/** Pages one collection without making the workspace-level traversal own two nested loops. */
const loadCollectionSnapshot = Effect.fn('ReplicaBootstrap.loadCollectionSnapshot')(function* (
	transport: BootstrapTransport,
	write: SnapshotWriter,
	collection: string,
	pageSize: number
): Effect.fn.Return<Readonly<{ cursor?: SyncCursor; rows: number }>, unknown> {
	let after: string | undefined;
	let cursor: SyncCursor | undefined;
	let rows = 0;
	do {
			const page = yield* readSnapshotPage(transport, collection, pageSize, after);
			if (page === undefined) break;
			// The whole page in one statement. Per-row writes made a first visit take minutes.
			rows += yield* write(collection, page.rows);
			// The oldest cursor across every collection governs the stream, so a pick up after the first
			// page was read re-delivers a little rather than missing something a later page had ahead of it.
			const pageCursor = page.cursor;
			if (pageCursor !== undefined && (cursor === undefined || compareCursors(pageCursor, cursor) < 0)) {
				cursor = pageCursor;
			}
			after = page.after;
	} while (after !== undefined);
	return cursor === undefined ? { rows } : { cursor, rows };
});

/**
 * Loads every readable collection's current state into the local database.
 *
 * The cursor returned is the *oldest* of the per-collection snapshot cursors, not the newest. Each
 * page is consistent with its own horizon, so streaming from the newest would skip changes that
 * another collection's earlier page had not yet reflected. Taking the oldest re-delivers a little and
 * misses nothing, which is the only safe direction to be wrong in.
 */
const loadSnapshot = Effect.fn('ReplicaBootstrap.loadSnapshot')(function* (
	transport: BootstrapTransport,
	write: SnapshotWriter,
	collections: ReadonlyArray<string>,
	pageSize = 500
): Effect.fn.Return<SnapshotOutcome, unknown> {
	let cursor: SyncCursor | undefined;
	let rows = 0;
	for (const collection of collections) {
		const loaded = yield* loadCollectionSnapshot(transport, write, collection, pageSize);
		rows += loaded.rows;
		cursor = oldestCursor(cursor, loaded.cursor);
	}
	return { cursor: cursor ?? ORIGIN_CURSOR, rows };
});

/** The collections this subject may read, as the server scopes them. */
const readShape = (transport: BootstrapTransport): Effect.Effect<ReadonlyArray<string>, unknown> =>
	transport
		.command('sync.shape', {})
		.pipe(
			Effect.map(
				(answer) =>
					Result.getOrElse(
						Schema.decodeUnknownResult(Schema.Array(Schema.String))(answer),
						() => null
					) ?? []
			)
		);

type LocalDatabase = Readonly<{
	readonly sql: LocalSql;
	readonly cursor: SyncCursor;
	readonly fingerprint: string;
	/** Rows loaded by the initial snapshot; zero when the replica resumed an existing database. */
	readonly rows: number;
	/** True when an existing local database was reused rather than provisioned and snapshotted. */
	readonly resumed: boolean;
	/** Persists how far the replica has streamed, alongside the rows it streamed. */
	readonly record: (cursor: SyncCursor) => Effect.Effect<void, unknown>;
	readonly close: () => Effect.Effect<void, unknown>;
	/**
	 * The engine itself, for the two things only it can answer: whether this tab leads, and
	 * `LISTEN`. Everything else goes through `sql`.
	 */
	readonly engine: PGliteLike;
	/** Collection metadata, so a local read compiles the way the server would. */
	readonly shape: ReplicaShape;
	/** The collections this subject may read, as the server reported them. */
	readonly readable: ReadonlySet<string>;
}>;

/**
 * Brings up the local database, from provisioning through snapshot.
 *
 * `open` is injected rather than imported so this module carries no dependency on the wasm bundle: a
 * test supplies an in-process PGlite, and the browser supplies one loaded on demand. Loading it
 * eagerly would put several megabytes of WebAssembly in front of the first paint of every page, which
 * is the opposite of what the replica exists to achieve.
 */
export const openLocalDatabase = Effect.fn('ReplicaBootstrap.openLocalDatabase')(function* (
	transport: BootstrapTransport,
	open: (steps: ReadonlyArray<ProvisioningStepType>) => Effect.Effect<PGliteLike, unknown>
): Effect.fn.Return<LocalDatabase, unknown> {
	const provisioning = yield* readProvisioning(transport);
	const database = yield* open(provisioning.steps);
	/**
	 * The replica mirrors a database whose integrity is already decided, so it does not re-decide it.
	 *
	 * A snapshot arrives collection by collection, in whatever order `sync.shape` lists them, so a
	 * child row routinely lands before its parent — `companies` before `jurisdictions` is enough to
	 * fail on `jurisdiction_id is not present in table "jurisdictions"`. Ordering the load by
	 * dependency would only narrow the window: the live stream has the same property, because a batch
	 * is bounded by row count rather than by referential closure.
	 *
	 * `replica` is exactly the role Postgres defines for this — the setting logical replication itself
	 * runs under, for the same reason. The server accepted these rows against these constraints; the
	 * mirror's job is to hold them, not to audit them a second time in an order nobody guarantees.
	 */
	yield* database.exec('set session_replication_role = replica');
	const provisioned = yield* provision(database, provisioning.steps, provisioning.fingerprint);
	const fieldsByCollection = Object.fromEntries(
		provisioning.shape.collections.map((collection) => [collection.name, collection.fields])
	);
	const sql = yield* createPGliteSql(database, fieldsByCollection);
	if (!provisioned) {
		// The local database already matches this schema and still holds its rows, so the expensive half
		// is skipped entirely: no DDL, and no snapshot of a workspace it already has. It resumes from the
		// cursor it recorded, which is the whole point of persisting the replica rather than rebuilding
		// it on every visit.
		const state = yield* readReplicaState(database);
		const readable = yield* readShape(transport);
		return {
			sql,
			cursor: state?.cursor ?? ORIGIN_CURSOR,
			fingerprint: provisioning.fingerprint,
			rows: 0,
			resumed: true,
			record: (cursor) => writeReplicaCursor(database, cursor),
			close: database.close,
			engine: database,
			shape: provisioning.shape,
			readable: new Set(readable)
		};
	}
	const columnsFor = yield* writableColumns(database);
	const readable = yield* readShape(transport);
	const snapshot = yield* loadSnapshot(
		transport,
		(collection, rows) =>
			Effect.gen(function* () {
				const fields = fieldsByCollection[collection];
				if (fields === undefined)
					return yield* Effect.fail(
						new Error(`sync.shape named collection ${collection} without provisioning metadata`)
					);
				const columns = yield* columnsFor(collection);
				return yield* bulkUpsert(database, columns, collection, rows, fields);
			}),
		readable
	);
	// Marked only now: until the snapshot has landed, this database does not hold the workspace, and a
	// later session that read the fingerprint would resume an empty one.
	yield* markProvisioned(database, provisioning.fingerprint, snapshot.cursor);
	return {
		sql,
		cursor: snapshot.cursor,
		fingerprint: provisioning.fingerprint,
		rows: snapshot.rows,
		resumed: false,
		record: (cursor) => writeReplicaCursor(database, cursor),
		close: database.close,
		engine: database,
		shape: provisioning.shape,
		readable: new Set(readable)
	};
});
