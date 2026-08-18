import type { Schema } from 'effect';
import type { SyncChange } from '../../runtime/sync/sync.js';
import type { LocalSql } from './replica.js';

/**
 * The browser replica's actual PostgreSQL.
 *
 * `local-sql.ts` keeps rows in a `Map`, which can answer "give me this record by id" and nothing a
 * page actually asks — no `where` over a nested relation, no `orderBy`, no keyset page, no `with`.
 * Writing a second query evaluator to close that gap is the mistake this codebase already made once
 * with the schema plan: two implementations of one thing, free to disagree, with the disagreement
 * showing up as wrong rows rather than as an error. PGlite is the same PostgreSQL the server runs,
 * so there is no second implementation to keep honest.
 *
 * The schema is not derived here either. It arrives as the ordered DDL the tenant's own database was
 * provisioned with — `sync.provisioning`, which is the schema plan's foundation plus the drizzle
 * lineage — so a column's type in the replica is the column's type on the server by construction.
 */

/** The subset of PGlite this module uses, so a test can supply one without the wasm bundle. */
export type PGliteLike = Readonly<{
	readonly query: <T>(
		sql: string,
		parameters?: ReadonlyArray<unknown>
	) => Promise<{ readonly rows: ReadonlyArray<T> }>;
	readonly exec: (sql: string) => Promise<unknown>;
	readonly close?: () => Promise<void>;
	/**
	 * Whether this tab holds the shared database, when the engine is shared at all.
	 *
	 * Absent for a plain in-process engine — the test harness, a single-tab fallback — which is the
	 * same thing as "this tab is the only one", so a missing value reads as leader.
	 */
	readonly isLeader?: boolean;
	/**
	 * Postgres `LISTEN`, which crosses tabs because the database does.
	 *
	 * This is how a follower learns that the leader applied something. Routing invalidation through
	 * the database rather than a `BroadcastChannel` means the notification cannot arrive before the
	 * rows it describes: it is emitted by the same connection that wrote them.
	 */
	readonly listen?: (
		channel: string,
		callback: (payload: string) => void
	) => Promise<() => Promise<void>>;
	/** Fires when leadership moves, so the tab that inherits the database also inherits the sync loop. */
	readonly onLeaderChange?: (callback: () => void) => () => void;
}>;

export type ProvisioningStep = Readonly<{ readonly id: string; readonly sql: string }>;

/**
 * What the replica remembers about itself between sessions.
 *
 * The local database is persisted in IndexedDB, so the second visit opens a database that is already
 * provisioned and already holds rows. Without a record of that, provisioning re-runs and the lineage's
 * unguarded `CREATE TABLE` fails on `relation "companies" already exists` — which is the lineage being
 * correct, not wrong: entries run exactly once against a ledger, and the replica had no ledger.
 *
 * `fingerprint` is the server's own schema-plan fingerprint. When it matches, the local schema is the
 * schema the server described and provisioning is skipped entirely; when it does not, the replica is
 * rebuilt rather than migrated. Rebuilding is the honest option for a reconstructible cache: applying
 * a lineage forward would require knowing which entries this browser had already seen, and a wrong
 * answer there is a local database that silently disagrees with the server.
 */
const STATE_TABLE = 'bolt_replica_state';

const ensureStateTable = async (database: PGliteLike): Promise<void> => {
	await database.exec(
		`create table if not exists ${STATE_TABLE} (id boolean primary key default true check (id), fingerprint text not null, xid bigint not null default 0, sequence bigint not null default 0)`
	);
};

export type ReplicaState = Readonly<{
	readonly fingerprint: string;
	readonly cursor: { readonly xid: number; readonly sequence: number };
}>;

export const readReplicaState = async (database: PGliteLike): Promise<ReplicaState | undefined> => {
	await ensureStateTable(database);
	const result = await database.query<{
		fingerprint: string;
		xid: string | number;
		sequence: string | number;
	}>(`select fingerprint, xid, sequence from ${STATE_TABLE} where id`);
	const row = result.rows[0];
	return row === undefined
		? undefined
		: {
				fingerprint: row.fingerprint,
				cursor: { xid: Number(row.xid), sequence: Number(row.sequence) }
			};
};

/** Records how far the replica has streamed, so the next session resumes instead of re-snapshotting. */
export const writeReplicaCursor = async (
	database: PGliteLike,
	cursor: { readonly xid: number; readonly sequence: number }
): Promise<void> => {
	await database.query(`update ${STATE_TABLE} set xid = $1, sequence = $2 where id`, [
		cursor.xid,
		cursor.sequence
	]);
};

/**
 * Applies the provisioning DDL, stopping at the first statement that fails.
 *
 * Stopping matters: the steps are ordered by dependency — extensions, then the functions generated
 * columns call, then tables, then the constraints over them — so continuing past a failure builds a
 * database that is wrong in a way no later statement reports. The failing step is named because the
 * id says which half it came from, and "the lineage's third statement" is a different problem from
 * "the plan's `pg_trgm` extension".
 *
 * Returns whether it actually provisioned. `false` means the local database already matched this
 * fingerprint, and the caller can resume streaming rather than taking a fresh snapshot.
 */
export const provision = async (
	database: PGliteLike,
	steps: ReadonlyArray<ProvisioningStep>,
	fingerprint?: string
): Promise<boolean> => {
	const state = fingerprint === undefined ? undefined : await readReplicaState(database);
	if (fingerprint !== undefined && state?.fingerprint === fingerprint) return false;
	if (fingerprint !== undefined) {
		// Cleared whenever the recorded fingerprint is not this one — including when there is no record
		// at all. "No record but tables exist" is precisely what a previous provisioning that failed
		// part-way leaves behind, and it is the state this function used to walk straight into: the
		// steps ran again and the lineage's own `create table "companies"` refused. A local database
		// nothing vouches for is not a database to build on, and the replica is reconstructible, so it
		// is dropped rather than reasoned about.
		await database.exec('drop schema public cascade; create schema public;');
	}
	for (const step of steps) {
		try {
			await database.exec(step.sql);
		} catch (cause) {
			throw new Error(
				`Replica provisioning failed at ${step.id}: ${cause instanceof Error ? cause.message : String(cause)}`
			);
		}
	}
	return true;
};

/**
 * Records that the replica is both provisioned *and* populated.
 *
 * Deliberately not written by `provision`. The fingerprint is what a later session reads to decide it
 * can skip the expensive half, so writing it when the schema exists but the snapshot has not run yet
 * makes a failed bootstrap indistinguishable from a healthy one — the next visit resumes an empty
 * database and reports a workspace with nothing in it. The row means "this replica holds the
 * workspace", so it is written once that is true.
 */
export const markProvisioned = async (
	database: PGliteLike,
	fingerprint: string,
	cursor: { readonly xid: number; readonly sequence: number }
): Promise<void> => {
	await ensureStateTable(database);
	await database.query(
		`insert into ${STATE_TABLE} (id, fingerprint, xid, sequence) values (true, $1, $2, $3) on conflict (id) do update set fingerprint = excluded.fingerprint, xid = excluded.xid, sequence = excluded.sequence`,
		[fingerprint, cursor.xid, cursor.sequence]
	);
};

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
	value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: undefined;

/**
 * Writes one row, as an upsert keyed by `norbital_id`.
 *
 * Upsert rather than insert because the stream is at-least-once by construction: a snapshot is paged
 * while the workspace is being written, so a row that commits mid-page arrives once from the snapshot
 * and once from the log. Insisting on exactly-once across those two would mean tracking which of them
 * had already seen each row — state that can be wrong — where an upsert simply converges.
 *
 * Columns are restricted to those the local table actually has. A change carries whatever the server
 * wrote, and a replica provisioned from an older lineage would otherwise fail the whole batch on one
 * unknown column rather than storing what it can understand.
 */
const upsert = async (
	database: PGliteLike,
	columns: ReadonlySet<string>,
	collection: string,
	recordId: string,
	record: Readonly<Record<string, unknown>>
): Promise<void> => {
	const entries = Object.entries({ ...record, norbital_id: recordId }).filter(([name]) =>
		columns.has(name)
	);
	if (entries.length === 0) return;
	const names = entries.map(([name]) => quoteIdentifier(name));
	const placeholders = entries.map((_entry, index) => `$${index + 1}`);
	// `norbital_id` is the conflict target and must not be in the update list: assigning a row's key to
	// itself is noise, and an update list that ends up empty is a syntax error rather than a no-op.
	const assignments = entries
		.filter(([name]) => name !== 'norbital_id')
		.map(([name]) => `${quoteIdentifier(name)} = excluded.${quoteIdentifier(name)}`);
	const conflict =
		assignments.length === 0
			? 'on conflict (norbital_id) do nothing'
			: `on conflict (norbital_id) do update set ${assignments.join(', ')}`;
	await database.query(
		`insert into ${quoteIdentifier(collection)} (${names.join(', ')}) values (${placeholders.join(', ')}) ${conflict}`,
		entries.map(([, value]) => value)
	);
};

/**
 * The columns of a local table that may actually be written.
 *
 * Generated columns are excluded, and that is not an optimisation: Postgres rejects any attempt to
 * supply one — `column "usage_mode" is a generated column` — and the snapshot serves whole rows via
 * `to_jsonb`, so every generated column arrives in the payload. The server's own write path drops
 * them for the same reason. The replica loses nothing by it: the schema came from the tenant's
 * lineage, so the same expression recomputes the same value locally.
 *
 * Restricting to known columns also means a change naming a column this replica does not have is
 * trimmed rather than failing the batch.
 */
const columnsOf = async (
	database: PGliteLike,
	collection: string
): Promise<ReadonlySet<string>> => {
	const result = await database.query<{ column_name: string }>(
		"select column_name from information_schema.columns where table_schema = current_schema() and table_name = $1 and is_generated <> 'ALWAYS' and coalesce(identity_generation, '') <> 'ALWAYS'",
		[collection]
	);
	return new Set(result.rows.map((row) => row.column_name));
};

/**
 * Writes a whole page of snapshot rows in one statement.
 *
 * A row at a time is the obvious shape and unusable: a snapshot of this workspace is roughly seven
 * thousand rows across twenty-one collections, and one round trip into WebAssembly per row put the
 * bootstrap into minutes — long enough that the first visit looks broken rather than slow. One
 * multi-row `insert ... on conflict` per page turns that into one round trip per five hundred rows.
 *
 * The column list is taken from the writable columns of the table intersected with the keys the
 * source actually sent, and every row is padded to it, because a single `values` list has to be
 * rectangular even where the source omitted a null.
 */
export const bulkUpsert = async (
	database: PGliteLike,
	columns: ReadonlySet<string>,
	collection: string,
	rows: ReadonlyArray<Readonly<Record<string, unknown>>>
): Promise<number> => {
	if (rows.length === 0) return 0;
	const present = new Set<string>();
	for (const row of rows)
		for (const name of Object.keys(row)) if (columns.has(name)) present.add(name);
	if (!present.has('norbital_id')) return 0;
	const names = [...present];
	const parameters: Array<unknown> = [];
	const tuples = rows.map((row) => {
		const placeholders = names.map((name) => `$${parameters.push(row[name] ?? null)}`);
		return `(${placeholders.join(', ')})`;
	});
	const assignments = names
		.filter((name) => name !== 'norbital_id')
		.map((name) => `${quoteIdentifier(name)} = excluded.${quoteIdentifier(name)}`);
	const conflict =
		assignments.length === 0
			? 'on conflict (norbital_id) do nothing'
			: `on conflict (norbital_id) do update set ${assignments.join(', ')}`;
	await database.query(
		`insert into ${quoteIdentifier(collection)} (${names.map(quoteIdentifier).join(', ')}) values ${tuples.join(', ')} ${conflict}`,
		parameters
	);
	return rows.length;
};

/** The writable columns of a local table, or an empty set when the replica has no such table. */
export const writableColumns = (
	database: PGliteLike
): ((collection: string) => Promise<ReadonlySet<string>>) => {
	const cache = new Map<string, ReadonlySet<string>>();
	return async (collection) => {
		const cached = cache.get(collection);
		if (cached !== undefined) return cached;
		const columns = await columnsOf(database, collection);
		cache.set(collection, columns);
		return columns;
	};
};

/**
 * Binds a PGlite instance as the replica's local SQL.
 *
 * The column cache is per-instance and never invalidated, because the schema of a replica cannot
 * change while it exists: a workspace whose lineage moved on produces a new provisioning fingerprint,
 * and the caller rebuilds rather than migrating a cache in place.
 */
export const createPGliteSql = (database: PGliteLike): LocalSql => {
	const columnCache = new Map<string, ReadonlySet<string>>();
	const columnsFor = async (collection: string): Promise<ReadonlySet<string>> => {
		const cached = columnCache.get(collection);
		if (cached !== undefined) return cached;
		const columns = await columnsOf(database, collection);
		columnCache.set(collection, columns);
		return columns;
	};

	return {
		query: async (sql, parameters) => {
			const result = await database.query<Schema.Json>(sql, [...parameters]);
			return result.rows;
		},
		applyChange: async (change) => {
			const entry = asRecord(change) as SyncChange | undefined;
			if (entry === undefined) return;
			if (entry.operation === 'reset') return;
			const columns = await columnsFor(entry.collection);
			// A collection the replica has no table for is skipped rather than failing the batch. That is
			// what a policy granted after provisioning looks like from here, and the rebuild that follows
			// a changed fingerprint is what makes it visible.
			if (columns.size === 0) return;
			if (entry.operation === 'delete') {
				await database.query(
					`delete from ${quoteIdentifier(entry.collection)} where norbital_id = $1`,
					[entry.recordId]
				);
				return;
			}
			const record = asRecord(entry.record);
			if (record === undefined) return;
			await upsert(database, columns, entry.collection, entry.recordId, record);
		},
		reset: async () => {
			// Truncating every collection table rather than dropping the database: the schema came from
			// the server's own provisioning and is still correct, and rebuilding it would cost a second
			// round trip for DDL that has not changed.
			const tables = await database.query<{ table_name: string }>(
				"select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE' and table_name not like 'bolt_%' and table_name not like '\\_\\_%'"
			);
			if (tables.rows.length === 0) return;
			await database.query(
				`truncate ${tables.rows.map((row) => quoteIdentifier(row.table_name)).join(', ')} cascade`
			);
		}
	};
};
