import { Effect, Result, Schema } from 'effect';
import { SyncCursor, type SyncChange } from '#lib/runtime/sync/sync.js';
import { compareCursors, ORIGIN_CURSOR } from '#lib/client/replica/sync-client.js';
import {
	clearProvisioned,
	createPGliteStore,
	markProvisioned,
	provision,
	readReplicaState,
	writeReplicaCursor,
	type PGliteLike,
	ProvisioningStep,
	type ProvisioningStep as ProvisioningStepType
} from '#lib/client/replica/pglite-sql.js';
import { ReplicaShape } from '#lib/client/replica/local-reads.js';
import type { LocalReplicaStore } from '#lib/client/replica/pglite-sql.js';

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
/**
 * The `sync.snapshot` envelope, with nothing in it optional.
 *
 * Every answer the runtime command produces states both keys — `nextAfter` is the next id or `null`,
 * never absent. Accepting their absence made a page this client could not read indistinguishable from
 * a collection that had ended, which is the one confusion the paging loop below must not have. The
 * rows are decoded one at a time afterwards, because a row and a page fail for different reasons.
 */
const SnapshotPage = Schema.Struct({
	rows: Schema.Array(Schema.Json),
	cursor: SyncCursor,
	nextAfter: Schema.NullOr(Schema.String)
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
 * An unreadable page is a failure, and the failure aborts the whole bootstrap. Answering it with
 * `undefined` made it the same signal as "this collection is exhausted": the loop stopped, the
 * partial load was reported as a success, and the fingerprint was stamped over a workspace that held
 * one page of it — which every later session then resumed instead of rebuilding.
 *
 * Rows are kept only when they name their `id`. A field-restricted subject can be masked out of `id`
 * itself, and an upsert cannot key a row that cannot be rewritten; dropping that row costs one row,
 * while failing its page would cost every good one beside it.
 */
const readSnapshotPage = Effect.fn('ReplicaBootstrap.readSnapshotPage')(function* (
	transport: BootstrapTransport,
	collection: string,
	pageSize: number,
	after: string | undefined
): Effect.fn.Return<
	Readonly<{
		readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
		readonly cursor: SyncCursor;
		readonly after?: string | undefined;
	}>,
	unknown
> {
	const answer = yield* transport.command('sync.snapshot', {
		collection,
		limit: pageSize,
		...(after === undefined ? {} : { after })
	});
	const decoded = yield* Schema.decodeUnknownEffect(SnapshotPage)(answer).pipe(
		Effect.mapError(
			(cause) =>
				new Error(`Replica snapshot page for ${collection} could not be read: ${String(cause)}`)
		)
	);
	return {
		rows: decoded.rows.flatMap((row) => {
			const keyed = Schema.decodeUnknownResult(SnapshotRow)(row);
			return Result.isFailure(keyed) ? [] : [keyed.success];
		}),
		cursor: decoded.cursor,
		after: decoded.nextAfter ?? undefined
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
		// The whole page in one statement. Per-row writes made a first visit take minutes.
		rows += yield* write(collection, page.rows);
		// The oldest cursor across every collection governs the stream, so a pick up after the first
		// page was read re-delivers a little rather than missing something a later page had ahead of it.
		if (cursor === undefined || compareCursors(page.cursor, cursor) < 0) cursor = page.cursor;
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

/**
 * How long a tab that does not hold the database waits for the tab that does to finish building it.
 *
 * Provisioning drops the schema, so it cannot be something every tab does on its own: two tabs
 * opening together both dropped, and each one's snapshot landed in a database the other was about to
 * empty. Leadership already decides who holds the database — the same election that decides who
 * streams — so the leader builds it and every other tab waits for the fingerprint to appear and then
 * resumes what it built.
 *
 * A wait with no end would be worse than no replica at all, because the page would sit behind a tab
 * that may never bootstrap. Giving up returns the tab to reading over the wire, which is the same
 * degradation a browser that cannot run the engine already gets.
 */
const FOLLOWER_PROVISION_TIMEOUT_MILLIS = 30_000;
const FOLLOWER_PROVISION_POLL_MILLIS = 50;

const awaitProvisioned = Effect.fn('ReplicaBootstrap.awaitProvisioned')(function* (
	database: PGliteLike,
	steps: ReadonlyArray<ProvisioningStepType>,
	fingerprint: string
): Effect.fn.Return<boolean, unknown> {
	const deadline = Date.now() + FOLLOWER_PROVISION_TIMEOUT_MILLIS;
	for (;;) {
		const state = yield* readReplicaState(database);
		// Built and stamped by the leader: this tab reads that database and provisions nothing.
		if (state?.fingerprint === fingerprint) return false;
		// Leadership moves when the leading tab closes. A follower promoted while waiting is now the
		// tab that has to build it, and the drop is safe precisely because it is the only one holding it.
		if (database.isLeader !== false) return yield* provision(database, steps, fingerprint);
		if (Date.now() >= deadline) {
			return yield* Effect.fail(
				new Error('Local replica timed out waiting for the leading tab to provision it')
			);
		}
		yield* Effect.sleep(FOLLOWER_PROVISION_POLL_MILLIS);
	}
});

type LocalDatabase = Readonly<{
	readonly store: LocalReplicaStore;
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
	 * `LISTEN`. Everything else goes through the structured store.
	 */
	readonly engine: PGliteLike;
	/** Collection metadata, so a local read compiles the way the server would. */
	readonly shape: ReplicaShape;
	/** The collections this subject may read, as the server reported them. */
	readonly readable: ReadonlySet<string>;
	/** Replaces a divergent projection with a new authoritative snapshot without rebuilding its DDL. */
	readonly resnapshot: () => Effect.Effect<
		{ readonly cursor: SyncCursor; readonly rows: number },
		unknown
	>;
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
	// repository-health:allow SQL1 -- session bootstrap for the sync engine's reconstructible mirror;
	// this is neither application data access nor an exposed statement capability.
	yield* database.exec('set session_replication_role = replica');
	// Only the tab holding the database rebuilds it; see `awaitProvisioned`. An absent `isLeader` means
	// an unshared engine — the test harness, or a browser without workers — which is the same thing as
	// being the only tab.
	const provisioned =
		database.isLeader === false
			? yield* awaitProvisioned(database, provisioning.steps, provisioning.fingerprint)
			: yield* provision(database, provisioning.steps, provisioning.fingerprint);
	const fieldsByCollection = Object.fromEntries(
		provisioning.shape.collections.map((collection) => [collection.name, collection.fields])
	);
	const store = yield* createPGliteStore(database, fieldsByCollection);
	const readable = yield* readShape(transport);
	const snapshotCurrent = () =>
		loadSnapshot(transport, (collection, rows) => store.applySnapshot(collection, rows), readable);
	const resnapshot = () =>
		Effect.gen(function* () {
			// Unstamped for as long as it is incomplete. A repair empties the tables before it refills
			// them, so a page that fails halfway leaves exactly the truncated projection the bootstrap
			// refuses to create — and a fingerprint standing over that is what makes the next session
			// resume it instead of rebuilding.
			yield* clearProvisioned(database);
			yield* store.reset();
			const snapshot = yield* snapshotCurrent();
			yield* markProvisioned(database, provisioning.fingerprint, snapshot.cursor);
			return snapshot;
		});
	if (!provisioned) {
		// The local database already matches this schema and still holds its rows, so the expensive half
		// is skipped entirely: no DDL, and no snapshot of a workspace it already has. It resumes from the
		// cursor it recorded, which is the whole point of persisting the replica rather than rebuilding
		// it on every visit.
		const state = yield* readReplicaState(database);
		return {
			store,
			cursor: state?.cursor ?? ORIGIN_CURSOR,
			fingerprint: provisioning.fingerprint,
			rows: 0,
			resumed: true,
			record: (cursor) => writeReplicaCursor(database, cursor),
			close: database.close,
			engine: database,
			shape: provisioning.shape,
			readable: new Set(readable),
			resnapshot
		};
	}
	const snapshot = yield* snapshotCurrent();
	// Marked only now: until the snapshot has landed, this database does not hold the workspace, and a
	// later session that read the fingerprint would resume an empty one.
	yield* markProvisioned(database, provisioning.fingerprint, snapshot.cursor);
	return {
		store,
		cursor: snapshot.cursor,
		fingerprint: provisioning.fingerprint,
		rows: snapshot.rows,
		resumed: false,
		record: (cursor) => writeReplicaCursor(database, cursor),
		close: database.close,
		engine: database,
		shape: provisioning.shape,
		readable: new Set(readable),
		resnapshot
	};
});
