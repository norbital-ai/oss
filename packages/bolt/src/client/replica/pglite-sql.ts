import { Cache, Effect, Result, Schema } from 'effect';
import type { SyncChange } from '#lib/runtime/sync/sync.js';
import type { FieldDefinition } from '#lib/authoring/workspace-schema.js';
import { encodeReferenceValues } from '#lib/runtime/collections/references.js';

export type LocalSql = Readonly<{
	readonly query: (
		sql: string,
		parameters: ReadonlyArray<Schema.Json>
	) => Effect.Effect<ReadonlyArray<Schema.Json>, unknown>;
	readonly applyChange: (change: SyncChange) => Effect.Effect<void, unknown>;
	readonly reset: () => Effect.Effect<void, unknown>;
}>;

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
 *
 * ## Statement ownership
 *
 * PGlite has no query builder, so this module owns one small parameterized statement port. Every
 * replica query travels through `executeReplicaStatement`; values remain positional parameters and
 * the few dynamic identifiers are quoted before a statement is constructed. That keeps SQL assembly
 * in one infrastructure boundary while preserving the server compiler's clauses verbatim.
 */

/**
 * The subset of PGlite this module uses, so a test can supply one without the wasm bundle.
 *
 * The actual PGlite Promise API is adapted once in `pglite-loader.ts`. Everything downstream sees
 * Effects, so interruption, failure and concurrent startup remain in one control model.
 */
export interface PGliteLike {
	query<T>(
		sql: string,
		parameters?: ReadonlyArray<unknown>
	): Effect.Effect<
		{
			readonly rows: ReadonlyArray<T>;
		},
		unknown
	>;
	exec(sql: string): Effect.Effect<unknown, unknown>;
	close(): Effect.Effect<void, unknown>;
	/**
	 * Whether this tab holds the shared database, when the engine is shared at all.
	 *
	 * Absent for a plain in-process engine — the test harness, a single-tab fallback — which is the
	 * same thing as "this tab is the only one", so a missing value reads as leader.
	 */
	readonly isLeader: boolean;
	/**
	 * Postgres `LISTEN`, which crosses tabs because the database does.
	 *
	 * This is how a follower learns that the leader applied something. Routing invalidation through
	 * the database rather than a `BroadcastChannel` means the notification cannot arrive before the
	 * rows it describes: it is emitted by the same connection that wrote them.
	 */
	listen(
		channel: string,
		callback: (payload: string) => void
	): Effect.Effect<() => Effect.Effect<void, unknown>, unknown>;
	/** Fires when leadership moves, so the tab that inherits the database also inherits the sync loop. */
	onLeaderChange(callback: () => void): () => void;
}

/** One parameterized statement accepted by the local replica database. */
export type ReplicaStatement = Readonly<{
	readonly text: string;
	readonly parameters: ReadonlyArray<unknown>;
}>;

/** Constructs the only statement shape the replica execution port accepts. */
export const replicaStatement = (
	text: string,
	parameters: ReadonlyArray<unknown> = []
): ReplicaStatement => ({ text, parameters });

/** Executes a parameterized statement through the PGlite adapter. */
export const executeReplicaStatement = <Row>(
	database: PGliteLike,
	statement: ReplicaStatement
): Effect.Effect<{ readonly rows: ReadonlyArray<Row> }, unknown> =>
	database.query<Row>(statement.text, statement.parameters);

export const ProvisioningStep = Schema.Struct({ id: Schema.String, sql: Schema.String });
export interface ProvisioningStep extends Schema.Schema.Type<typeof ProvisioningStep> {}

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
const SCHEMA_STATE_TABLE = 'bolt_schema_state';
const SYNC_HORIZON_TABLE = 'bolt_sync_horizon';

type ReplicaState = Readonly<{
	readonly fingerprint: string;
	readonly cursor: { readonly xid: number; readonly sequence: number };
}>;

export const readReplicaState = Effect.fn('ReplicaSql.readState')(function* (database: PGliteLike) {
	const catalogue = yield* executeReplicaStatement<{
		schema_state: string | null;
		sync_horizon: string | null;
	}>(
		database,
		replicaStatement(
			`select to_regclass('public.${SCHEMA_STATE_TABLE}')::text as schema_state, to_regclass('public.${SYNC_HORIZON_TABLE}')::text as sync_horizon`
		)
	);
	if (catalogue.rows[0]?.schema_state == null || catalogue.rows[0]?.sync_horizon == null)
		return undefined;
	const result = yield* executeReplicaStatement<{
		fingerprint: string;
		xid: string | number;
		sequence: string | number;
	}>(
		database,
		replicaStatement(
			`select state.fingerprint, horizon.xid, horizon.sequence from ${SCHEMA_STATE_TABLE} state cross join ${SYNC_HORIZON_TABLE} horizon where horizon.singleton order by state.applied_at desc limit 1`
		)
	);
	const row = result.rows[0];
	return row === undefined
		? undefined
		: {
				fingerprint: row.fingerprint,
				cursor: { xid: Number(row.xid), sequence: Number(row.sequence) }
			};
});

/** Records how far the replica has streamed, so the next session resumes instead of re-snapshotting. */
export const writeReplicaCursor = (
	database: PGliteLike,
	cursor: { readonly xid: number; readonly sequence: number }
): Effect.Effect<void, unknown> =>
	executeReplicaStatement(
		database,
		replicaStatement(`update ${SYNC_HORIZON_TABLE} set xid = $1, sequence = $2 where singleton`, [
			cursor.xid,
			cursor.sequence
		])
	).pipe(Effect.asVoid);

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
export const provision = Effect.fn('ReplicaSql.provision')(function* (
	database: PGliteLike,
	steps: ReadonlyArray<ProvisioningStep>,
	fingerprint?: string
): Effect.fn.Return<boolean, unknown> {
	const state = fingerprint === undefined ? undefined : yield* readReplicaState(database);
	if (fingerprint !== undefined && state?.fingerprint === fingerprint) return false;
	if (fingerprint !== undefined) {
		// Cleared whenever the recorded fingerprint is not this one — including when there is no record
		// at all. "No record but tables exist" is precisely what a previous provisioning that failed
		// part-way leaves behind, and it is the state this function used to walk straight into: the
		// steps ran again and the lineage's own `create table "companies"` refused. A local database
		// nothing vouches for is not a database to build on, and the replica is reconstructible, so it
		// is dropped rather than reasoned about.
		yield* database.exec('drop schema public cascade; create schema public;');
	}
	for (const step of steps) {
		yield* database
			.exec(step.sql)
			.pipe(
				Effect.mapError(
					(cause) => new Error(`Replica provisioning failed at ${step.id}: ${String(cause)}`)
				)
			);
	}
	return true;
});

/**
 * Records that the replica is both provisioned *and* populated.
 *
 * Deliberately not written by `provision`. The fingerprint is what a later session reads to decide it
 * can skip the expensive half, so writing it when the schema exists but the snapshot has not run yet
 * makes a failed bootstrap indistinguishable from a healthy one — the next visit resumes an empty
 * database and reports a workspace with nothing in it. The row means "this replica holds the
 * workspace", so it is written once that is true.
 */
export const markProvisioned = Effect.fn('ReplicaSql.markProvisioned')(function* (
	database: PGliteLike,
	fingerprint: string,
	cursor: { readonly xid: number; readonly sequence: number }
): Effect.fn.Return<void, unknown> {
	yield* executeReplicaStatement(database, replicaStatement(`delete from ${SCHEMA_STATE_TABLE}`));
	yield* executeReplicaStatement(
		database,
		replicaStatement(`insert into ${SCHEMA_STATE_TABLE} (fingerprint) values ($1)`, [fingerprint])
	);
	yield* executeReplicaStatement(
		database,
		replicaStatement(
			`insert into ${SYNC_HORIZON_TABLE} (singleton, xid, sequence) values (true, $1, $2) on conflict (singleton) do update set xid = excluded.xid, sequence = excluded.sequence`,
			[cursor.xid, cursor.sequence]
		)
	);
});

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

const JsonObject = Schema.Record(Schema.String, Schema.Json);

/**
 * Writes one row, as an upsert keyed by `id`.
 *
 * Upsert rather than insert because the stream is at-least-once by construction: a snapshot is paged
 * while the workspace is being written, so a row that commits mid-page arrives once from the snapshot
 * and once from the log. Insisting on exactly-once across those two would mean tracking which of them
 * had already seen each row — state that can be wrong — where an upsert simply converges.
 *
 * Columns are restricted to those the local table can write. Snapshot rows include database-generated
 * values, and logical reference fields encode into hidden arm columns; neither public input belongs in
 * the insert after that transformation.
 */
const upsert = (
	database: PGliteLike,
	columns: ReadonlySet<string>,
	collection: string,
	recordId: string,
	record: Readonly<Record<string, unknown>>,
	fields: Readonly<Record<string, FieldDefinition>>
): Effect.Effect<void, unknown> => {
	const physical = encodeReferenceValues(record, fields);
	const entries = Object.entries({ ...physical, id: recordId }).filter(([name]) =>
		columns.has(name)
	);
	if (entries.length === 0) return Effect.void;
	const names = entries.map(([name]) => quoteIdentifier(name));
	const placeholders = entries.map((_entry, index) => `$${index + 1}`);
	// `id` is the conflict target and must not be in the update list: assigning a row's key to
	// itself is noise, and an update list that ends up empty is a syntax error rather than a no-op.
	const assignments = entries
		.filter(([name]) => name !== 'id')
		.map(([name]) => `${quoteIdentifier(name)} = excluded.${quoteIdentifier(name)}`);
	const conflict =
		assignments.length === 0
			? 'on conflict (id) do nothing'
			: `on conflict (id) do update set ${assignments.join(', ')}`;
	return executeReplicaStatement(
		database,
		replicaStatement(
			`insert into ${quoteIdentifier(collection)} (${names.join(', ')}) values (${placeholders.join(', ')}) ${conflict}`,
			entries.map(([, value]) => value)
		)
	).pipe(Effect.asVoid);
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
 * Restricting to known writable columns keeps generated and logical-only values out of SQL.
 */
const columnsOf = (
	database: PGliteLike,
	collection: string
): Effect.Effect<ReadonlySet<string>, unknown> =>
	executeReplicaStatement<{ column_name: string }>(
		database,
		replicaStatement(
			"select column_name from information_schema.columns where table_schema = current_schema() and table_name = $1 and is_generated <> 'ALWAYS' and coalesce(identity_generation, '') <> 'ALWAYS'",
			[collection]
		)
	).pipe(Effect.map((result) => new Set(result.rows.map((row) => row.column_name))));

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
export const bulkUpsert = (
	database: PGliteLike,
	columns: ReadonlySet<string>,
	collection: string,
	rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
	fields: Readonly<Record<string, FieldDefinition>>
): Effect.Effect<number, unknown> => {
	if (rows.length === 0) return Effect.succeed(0);
	const physicalRows = rows.map((row) => encodeReferenceValues(row, fields));
	const present = new Set<string>();
	for (const row of physicalRows)
		for (const name of Object.keys(row)) if (columns.has(name)) present.add(name);
	if (!present.has('id')) return Effect.succeed(0);
	const names = [...present];
	const parameters: Array<unknown> = [];
	const tuples = physicalRows.map((row) => {
		const placeholders = names.map((name) => `$${parameters.push(row[name] ?? null)}`);
		return `(${placeholders.join(', ')})`;
	});
	const assignments = names
		.filter((name) => name !== 'id')
		.map((name) => `${quoteIdentifier(name)} = excluded.${quoteIdentifier(name)}`);
	const conflict =
		assignments.length === 0
			? 'on conflict (id) do nothing'
			: `on conflict (id) do update set ${assignments.join(', ')}`;
	return executeReplicaStatement(
		database,
		replicaStatement(
			`insert into ${quoteIdentifier(collection)} (${names.map(quoteIdentifier).join(', ')}) values ${tuples.join(', ')} ${conflict}`,
			parameters
		)
	).pipe(Effect.as(rows.length));
};

/** The writable columns of a local table, or an empty set when the replica has no such table. */
export const writableColumns = (
	database: PGliteLike
): Effect.Effect<(collection: string) => Effect.Effect<ReadonlySet<string>, unknown>> =>
	Cache.make({
		capacity: 1_000,
		timeToLive: 'Infinity',
		lookup: (collection: string) => columnsOf(database, collection)
	}).pipe(Effect.map((cache) => (collection: string) => Cache.get(cache, collection)));

/**
 * Binds a PGlite instance as the replica's local SQL.
 *
 * The column cache is per-instance and never invalidated, because the schema of a replica cannot
 * change while it exists: a workspace whose lineage moved on produces a new provisioning fingerprint,
 * and the caller rebuilds rather than migrating a cache in place.
 */
export const createPGliteSql = (
	database: PGliteLike,
	fieldsByCollection: Readonly<Record<string, Readonly<Record<string, FieldDefinition>>>>
): Effect.Effect<LocalSql> =>
	Effect.gen(function* () {
		const columnsFor = yield* writableColumns(database);
		return {
			query: (sql, parameters) =>
				executeReplicaStatement<Schema.Json>(database, replicaStatement(sql, parameters)).pipe(
					Effect.map((result) => result.rows)
				),
			applyChange: (change) =>
				Effect.gen(function* () {
					// `change` is already the typed sync change, so nothing here re-derives its shape.
					if (change.operation === 'reset') return;
					const columns = yield* columnsFor(change.collection);
					// A collection the replica has no table for is skipped rather than failing the batch. That is
					// what a policy granted after provisioning looks like from here, and the rebuild that follows
					// a changed fingerprint is what makes it visible.
					if (columns.size === 0) return;
					if (change.operation === 'delete') {
						yield* executeReplicaStatement(
							database,
							replicaStatement(`delete from ${quoteIdentifier(change.collection)} where id = $1`, [
								change.recordId
							])
						);
						return;
					}
					const decoded = Schema.decodeUnknownResult(JsonObject)(change.record);
					if (Result.isFailure(decoded)) return;
					const fields = fieldsByCollection[change.collection];
					if (fields === undefined)
						return yield* Effect.fail(
							new Error(
								`Sync change named collection ${change.collection} without provisioning metadata`
							)
						);
					yield* upsert(
						database,
						columns,
						change.collection,
						change.recordId,
						decoded.success,
						fields
					);
				}),
			reset: () =>
				Effect.gen(function* () {
					// Truncating every collection table rather than dropping the database: the schema came from
					// the server's own provisioning and is still correct, and rebuilding it would cost a second
					// round trip for DDL that has not changed.
					const tables = yield* executeReplicaStatement<{ table_name: string }>(
						database,
						replicaStatement(
							"select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE' and table_name not like 'bolt_%' and table_name not like '\\_\\_%'"
						)
					);
					if (tables.rows.length === 0) return;
					yield* executeReplicaStatement(
						database,
						replicaStatement(
							`truncate ${tables.rows.map((row) => quoteIdentifier(row.table_name)).join(', ')} cascade`
						)
					);
				})
		};
	});
