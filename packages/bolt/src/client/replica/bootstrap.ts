import { Schema } from 'effect';
import type { SyncChange, SyncCursor } from '../../runtime/sync/sync.js';
import { compareCursors, ORIGIN_CURSOR } from './sync-client.js';
import {
	createPGliteSql,
	bulkUpsert,
	markProvisioned,
	provision,
	readReplicaState,
	writeReplicaCursor,
	writableColumns,
	type PGliteLike,
	type ProvisioningStep
} from './pglite-sql.js';
import type { ReplicaShape } from './local-reads.js';
import type { LocalSql } from './replica.js';

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
	readonly command: (command: string, input: Schema.Json) => Promise<Schema.Json>;
}>;

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
	value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: undefined;

/** The ordered DDL this tenant's database was provisioned with. */
export const readProvisioning = async (
	transport: BootstrapTransport
): Promise<{
	readonly steps: ReadonlyArray<ProvisioningStep>;
	readonly fingerprint: string;
	readonly shape: ReplicaShape;
}> => {
	const answer = asRecord(await transport.command('sync.provisioning', null));
	const steps = answer?.['steps'];
	const fingerprint = answer?.['fingerprint'];
	if (!Array.isArray(steps)) throw new Error('sync.provisioning returned no steps');
	const collections = answer?.['collections'];
	const relations = answer?.['relations'];
	return {
		steps: steps.flatMap((step) => {
			const entry = asRecord(step);
			return typeof entry?.['id'] === 'string' && typeof entry['sql'] === 'string'
				? [{ id: entry['id'], sql: entry['sql'] }]
				: [];
		}),
		fingerprint: typeof fingerprint === 'string' ? fingerprint : 'unknown',
		/**
		 * Absent when the server predates this field, and an empty shape simply means no query is ever
		 * answered locally — the replica still streams, reads still work, they just go to the server.
		 */
		shape: {
			collections: Array.isArray(collections)
				? collections.flatMap((entry) => {
						const record = asRecord(entry);
						const name = record?.['name'];
						const fields = asRecord(record?.['fields']);
						return typeof name === 'string' && fields !== undefined
							? [{ name, fields: fields as ReplicaShape['collections'][number]['fields'] }]
							: [];
					})
				: [],
			relations: Array.isArray(relations) ? (relations as ReplicaShape['relations']) : []
		}
	};
};

export type SnapshotOutcome = Readonly<{
	/** Where the log must be streamed from so nothing between the snapshot and now is missed. */
	readonly cursor: SyncCursor;
	readonly rows: number;
}>;

/**
 * Loads every readable collection's current state into the local database.
 *
 * The cursor returned is the *oldest* of the per-collection snapshot cursors, not the newest. Each
 * page is consistent with its own horizon, so streaming from the newest would skip changes that
 * another collection's earlier page had not yet reflected. Taking the oldest re-delivers a little and
 * misses nothing, which is the only safe direction to be wrong in.
 */
export const loadSnapshot = async (
	transport: BootstrapTransport,
	write: (
		collection: string,
		rows: ReadonlyArray<Readonly<Record<string, unknown>>>
	) => Promise<number>,
	collections: ReadonlyArray<string>,
	pageSize = 500
): Promise<SnapshotOutcome> => {
	let cursor: SyncCursor | undefined;
	let rows = 0;
	for (const collection of collections) {
		let after: string | undefined;
		do {
			const page = asRecord(
				await transport.command('sync.snapshot', {
					collection,
					limit: pageSize,
					...(after === undefined ? {} : { after })
				})
			);
			if (page === undefined) break;
			// The whole page in one statement. Per-row writes made a first visit take minutes.
			const pageRows = (Array.isArray(page['rows']) ? page['rows'] : []).flatMap((row) => {
				const record = asRecord(row);
				return record !== undefined && typeof record['norbital_id'] === 'string' ? [record] : [];
			});
			rows += await write(collection, pageRows);
			const pageCursor = asRecord(page['cursor']);
			if (pageCursor !== undefined) {
				const candidate: SyncCursor = {
					xid: Number(pageCursor['xid'] ?? 0),
					sequence: Number(pageCursor['sequence'] ?? 0)
				};
				if (cursor === undefined || compareCursors(candidate, cursor) < 0) cursor = candidate;
			}
			const next = page['nextAfter'];
			after = typeof next === 'string' ? next : undefined;
		} while (after !== undefined);
	}
	return { cursor: cursor ?? ORIGIN_CURSOR, rows };
};

/** The collections this subject may read, as the server scopes them. */
export const readShape = async (transport: BootstrapTransport): Promise<ReadonlyArray<string>> => {
	const answer = await transport.command('sync.shape', {});
	return Array.isArray(answer)
		? answer.filter((entry): entry is string => typeof entry === 'string')
		: [];
};

export type LocalDatabase = Readonly<{
	readonly sql: LocalSql;
	readonly cursor: SyncCursor;
	readonly fingerprint: string;
	/** Rows loaded by the initial snapshot; zero when the replica resumed an existing database. */
	readonly rows: number;
	/** True when an existing local database was reused rather than provisioned and snapshotted. */
	readonly resumed: boolean;
	/** Persists how far the replica has streamed, alongside the rows it streamed. */
	readonly record: (cursor: SyncCursor) => Promise<void>;
	readonly close: () => Promise<void>;
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
export const openLocalDatabase = async (
	transport: BootstrapTransport,
	open: (steps: ReadonlyArray<ProvisioningStep>) => Promise<PGliteLike>
): Promise<LocalDatabase> => {
	const provisioning = await readProvisioning(transport);
	const database = await open(provisioning.steps);
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
	await database.exec('set session_replication_role = replica');
	const provisioned = await provision(database, provisioning.steps, provisioning.fingerprint);
	const sql = createPGliteSql(database);
	if (!provisioned) {
		// The local database already matches this schema and still holds its rows, so the expensive half
		// is skipped entirely: no DDL, and no snapshot of a workspace it already has. It resumes from the
		// cursor it recorded, which is the whole point of persisting the replica rather than rebuilding
		// it on every visit.
		const state = await readReplicaState(database);
		return {
			sql,
			cursor: state?.cursor ?? ORIGIN_CURSOR,
			fingerprint: provisioning.fingerprint,
			rows: 0,
			resumed: true,
			record: (cursor) => writeReplicaCursor(database, cursor),
			close: async () => {
				await database.close?.();
			},
			engine: database,
			shape: provisioning.shape,
			readable: new Set(await readShape(transport))
		};
	}
	const columnsFor = writableColumns(database);
	const readable = await readShape(transport);
	const snapshot = await loadSnapshot(
		transport,
		async (collection, rows) =>
			bulkUpsert(database, await columnsFor(collection), collection, rows),
		readable
	);
	// Marked only now: until the snapshot has landed, this database does not hold the workspace, and a
	// later session that read the fingerprint would resume an empty one.
	await markProvisioned(database, provisioning.fingerprint, snapshot.cursor);
	return {
		sql,
		cursor: snapshot.cursor,
		fingerprint: provisioning.fingerprint,
		rows: snapshot.rows,
		resumed: false,
		record: (cursor) => writeReplicaCursor(database, cursor),
		close: async () => {
			await database.close?.();
		},
		engine: database,
		shape: provisioning.shape,
		readable: new Set(readable)
	};
};
