import { Cache, Effect, Result, Schema } from 'effect';
import { asc, count, desc, eq, getColumns, sql, type SQL, type SQLChunk } from 'drizzle-orm';
import { customType, pgTable, type AnyPgColumn, type AnyPgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pg-proxy';
import type { SyncChange } from '#lib/runtime/sync/sync.js';
import type { FieldDefinition } from '#lib/authoring/workspace-schema.js';
import { SYSTEM_COLUMN_NAMES } from '#lib/authoring/system-row-model.js';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import { encodeReferenceValues } from '#lib/runtime/collections/references.js';

type ReplicaFilter = Readonly<{
	readonly sql: string;
	readonly parameters: ReadonlyArray<Schema.Json>;
}>;

type ReplicaOrderTerm = Readonly<{
	readonly column: string;
	readonly direction: 'asc' | 'desc';
}>;

type ReplicaRead = Readonly<{
	readonly collection: string;
	readonly filter: ReplicaFilter;
	readonly orderBy: ReadonlyArray<ReplicaOrderTerm>;
	readonly limit?: number;
}>;

export type LocalReplicaStore = Readonly<{
	/** Executes the collection compiler's structured local read against the replica. */
	readonly findMany: (input: ReplicaRead) => Effect.Effect<ReadonlyArray<Schema.Json>, unknown>;
	readonly count: (collection: string, filter: ReplicaFilter) => Effect.Effect<number, unknown>;
	/** Installs one server snapshot page. This is intentionally not a general mutation API. */
	readonly applySnapshot: (
		collection: string,
		rows: ReadonlyArray<Readonly<Record<string, unknown>>>
	) => Effect.Effect<number, unknown>;
	readonly applyChange: (change: SyncChange) => Effect.Effect<void, unknown>;
	readonly reset: () => Effect.Effect<void, unknown>;
}>;

/**
 * The browser replica's actual PostgreSQL.
 *
 * PGlite is the storage engine chosen by the sync engine. Application and template code never sees
 * this port: collection reads reach the structured replica store, while snapshot and stream
 * writes reach `applySnapshot`/`applyChange`. Raw statement execution is reserved for the ordered DDL
 * provisioning boundary below.
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
	readonly isLeader: boolean;
	listen(
		channel: string,
		callback: (payload: string) => void
	): Effect.Effect<() => Effect.Effect<void, unknown>, unknown>;
	onLeaderChange(callback: () => void): () => void;
}

export const ProvisioningStep = Schema.Struct({ id: Schema.String, sql: Schema.String });
export interface ProvisioningStep extends Schema.Schema.Type<typeof ProvisioningStep> {}

/** Drizzle's generated statements cross the Effect-native PGlite adapter at this one boundary. */
const databaseView = (database: PGliteLike) =>
	drizzle((statement, parameters, method) =>
		Effect.runPromise(
			database.query<Record<string, unknown>>(statement, parameters).pipe(
				Effect.map((result) => ({
					rows: method === 'all' ? result.rows.map((row) => Object.values(row)) : [...result.rows]
				}))
			)
		)
	);

const executeBuilt = <Value>(build: () => Promise<Value>): Effect.Effect<Value, unknown> =>
	Effect.tryPromise(build);

const schemaState = SYSTEM_MODEL_TABLES.bolt_schema_state;
const syncHorizon = SYSTEM_MODEL_TABLES.bolt_sync_horizon;

type ReplicaState = Readonly<{
	readonly fingerprint: string;
	readonly cursor: { readonly xid: number; readonly sequence: number };
}>;

/**
 * Reads the two bootstrap ledgers through their canonical Drizzle models.
 *
 * Missing tables are the expected first-open state, so a failed read means "not provisioned" and
 * causes the reconstructible replica to be bootstrapped rather than trusted.
 */
export const readReplicaState = Effect.fn('ReplicaSql.readState')(function* (
	database: PGliteLike
): Effect.fn.Return<ReplicaState | undefined, unknown> {
	const view = databaseView(database);
	const read = Effect.all(
		[
			executeBuilt(() =>
				view
					.select({ fingerprint: schemaState.fingerprint })
					.from(schemaState)
					.orderBy(desc(schemaState.applied_at))
					.limit(1)
			),
			executeBuilt(() =>
				view
					.select({ xid: syncHorizon.xid, sequence: syncHorizon.sequence })
					.from(syncHorizon)
					.where(eq(syncHorizon.singleton, true))
					.limit(1)
			)
		],
		{ concurrency: 'unbounded' }
	).pipe(
		Effect.map(([states, horizons]) => {
			const state = states[0];
			const horizon = horizons[0];
			return state === undefined || horizon === undefined
				? undefined
				: {
						fingerprint: state.fingerprint,
						cursor: { xid: Number(horizon.xid), sequence: Number(horizon.sequence) }
					};
		})
	);
	return yield* read.pipe(Effect.catch(() => Effect.succeed(undefined)));
});

/** Records how far the replica has streamed, so the next session resumes instead of re-snapshotting. */
export const writeReplicaCursor = (
	database: PGliteLike,
	cursor: { readonly xid: number; readonly sequence: number }
): Effect.Effect<void, unknown> => {
	const view = databaseView(database);
	return executeBuilt(() =>
		view
			.update(syncHorizon)
			.set({ xid: cursor.xid, sequence: cursor.sequence })
			.where(eq(syncHorizon.singleton, true))
	).pipe(Effect.asVoid);
};

/**
 * Applies server-authored provisioning DDL, stopping at the first failed dependency-ordered step.
 *
 * This is the sole raw execution boundary in the replica. Every statement is compiler-generated DDL
 * from the tenant's exact schema plan or migration lineage; data reads and writes use Drizzle below.
 */
export const provision = Effect.fn('ReplicaSql.provision')(function* (
	database: PGliteLike,
	steps: ReadonlyArray<ProvisioningStep>,
	fingerprint?: string
): Effect.fn.Return<boolean, unknown> {
	const state = fingerprint === undefined ? undefined : yield* readReplicaState(database);
	if (fingerprint !== undefined && state?.fingerprint === fingerprint) return false;
	if (fingerprint !== undefined) {
		// The replica is a reconstructible cache. A mismatched or incomplete schema is replaced at the
		// DDL bootstrap boundary instead of being treated as a live database that can be patched safely.
		// repository-health:allow SQL1 -- DDL bootstrap for a disposable local replica schema.
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

/** Marks a replica usable only after both its DDL and authoritative snapshot have landed. */
export const markProvisioned = Effect.fn('ReplicaSql.markProvisioned')(function* (
	database: PGliteLike,
	fingerprint: string,
	cursor: { readonly xid: number; readonly sequence: number }
): Effect.fn.Return<void, unknown> {
	const view = databaseView(database);
	yield* executeBuilt(() => view.delete(schemaState));
	yield* executeBuilt(() => view.insert(schemaState).values({ fingerprint }));
	yield* executeBuilt(() =>
		view
			.insert(syncHorizon)
			.values({ singleton: true, xid: cursor.xid, sequence: cursor.sequence })
			.onConflictDoUpdate({
				target: syncHorizon.singleton,
				set: { xid: cursor.xid, sequence: cursor.sequence }
			})
	);
});

const replicaColumn = (name: string, dataType: string) =>
	customType<{ data: unknown; driverData: unknown }>({ dataType: () => dataType })(name);

const SYSTEM_TYPES: Readonly<Record<string, string>> = {
	id: 'uuid',
	created_at: 'timestamptz',
	updated_at: 'timestamptz',
	sys_period: 'tstzrange',
	row_version: 'integer',
	approval_id: 'uuid'
};

const scalarType = (field: FieldDefinition): string => {
	if (field.sqlType !== undefined) return field.sqlType;
	switch (field.type) {
		case 'uuid':
			return 'uuid';
		case 'number':
			return 'double precision';
		case 'boolean':
			return 'boolean';
		case 'instant':
			return 'timestamptz';
		case 'json':
			return 'jsonb';
		default:
			return 'text';
	}
};

type ReplicaCollection = Readonly<{
	readonly table: AnyPgTable;
	readonly columns: Readonly<Record<string, AnyPgColumn>>;
	readonly writable: ReadonlySet<string>;
	readonly fields: Readonly<Record<string, FieldDefinition>>;
}>;

/** Builds query metadata only; schema creation stays owned by the provisioning DDL above. */
const replicaCollection = (
	name: string,
	fields: Readonly<Record<string, FieldDefinition>>
): ReplicaCollection => {
	const types = new Map<string, string>(
		SYSTEM_COLUMN_NAMES.map((column) => [column, SYSTEM_TYPES[column] ?? 'text'])
	);
	const writable = new Set(SYSTEM_COLUMN_NAMES);
	for (const [fieldName, field] of Object.entries(fields)) {
		if (field.reference !== undefined) {
			for (const target of field.reference.targets) {
				types.set(target.storageColumn, 'uuid');
				writable.add(target.storageColumn);
			}
			continue;
		}
		types.set(fieldName, scalarType(field));
		if (field.generated === undefined) writable.add(fieldName);
	}
	// repository-health:allow DDL1 -- this declares Drizzle query metadata only; provisioning owns DDL.
	const table = pgTable(
		name,
		Object.fromEntries([...types].map(([column, type]) => [column, replicaColumn(column, type)]))
	);
	return { table, columns: getColumns(table), writable, fields };
};

const JsonObject = Schema.Record(Schema.String, Schema.Json);

/** Normalizes driver-native dates and numeric widths to the same JSON-safe values the wire carries. */
const replicaJson = (value: unknown): Schema.Json => {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value === 'bigint') {
		const number = Number(value);
		return Number.isSafeInteger(number) ? number : value.toString();
	}
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.map(replicaJson);
	if (typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, member]) => [key, replicaJson(member)])
		);
	}
	return null;
};

/** Rehydrates a compiler fragment as a Drizzle fragment while keeping every value parameterized. */
const compiledFragment = (filter: ReplicaFilter): SQL => {
	const chunks: Array<SQLChunk> = [];
	let start = 0;
	for (const match of filter.sql.matchAll(/\$(\d+)/g)) {
		const index = match.index;
		if (index > start) chunks.push(sql.raw(filter.sql.slice(start, index)));
		const value = filter.parameters[Number(match[1]) - 1];
		chunks.push(sql.param(value));
		start = index + match[0].length;
	}
	if (start < filter.sql.length) chunks.push(sql.raw(filter.sql.slice(start)));
	return chunks.length === 0 ? sql.raw('true') : sql.join(chunks, sql.raw(''));
};

const collectionOrFail = (
	collections: ReadonlyMap<string, ReplicaCollection>,
	name: string
): Effect.Effect<ReplicaCollection, Error> => {
	const collection = collections.get(name);
	return collection === undefined
		? Effect.fail(new Error(`Replica has no provisioned collection ${name}`))
		: Effect.succeed(collection);
};

const excluded = (column: string): SQL =>
	sql.join([sql.raw('excluded.'), sql.identifier(column)], sql.raw(''));

const upsertRows = (
	view: ReturnType<typeof databaseView>,
	collection: ReplicaCollection,
	rows: ReadonlyArray<Readonly<Record<string, unknown>>>
): Effect.Effect<number, unknown> => {
	if (rows.length === 0) return Effect.succeed(0);
	const physicalRows = rows.map((row) => encodeReferenceValues(row, collection.fields));
	const present = new Set<string>();
	for (const row of physicalRows)
		for (const name of Object.keys(row)) if (collection.writable.has(name)) present.add(name);
	if (!present.has('id')) return Effect.succeed(0);
	const names = [...present];
	const values = physicalRows.map((row) =>
		Object.fromEntries(names.map((name) => [name, row[name] ?? null]))
	);
	const id = collection.columns['id'];
	if (id === undefined) return Effect.fail(new Error('Replica collection has no id column'));
	const assignments = Object.fromEntries(
		names.filter((name) => name !== 'id').map((name) => [name, excluded(name)])
	);
	const insert = view.insert(collection.table).values(values as never);
	const query =
		Object.keys(assignments).length === 0
			? insert.onConflictDoNothing({ target: id })
			: insert.onConflictDoUpdate({ target: id, set: assignments });
	return executeBuilt(() => query).pipe(Effect.as(rows.length));
};

/**
 * Binds PGlite as a structured sync-engine store.
 *
 * There is deliberately no `query(sql, parameters)` member. Removing that capability means callers
 * cannot bypass collection query compilation or introduce handwritten replica CRUD later.
 */
export const createPGliteStore = (
	database: PGliteLike,
	fieldsByCollection: Readonly<Record<string, Readonly<Record<string, FieldDefinition>>>>
): Effect.Effect<LocalReplicaStore> =>
	Effect.gen(function* () {
		const view = databaseView(database);
		const collections = new Map(
			Object.entries(fieldsByCollection).map(([name, fields]) => [
				name,
				replicaCollection(name, fields)
			])
		);
		const cached = yield* Cache.make({
			capacity: 1_000,
			timeToLive: 'Infinity',
			lookup: (name: string) => collectionOrFail(collections, name)
		});
		const collectionFor = (name: string) => Cache.get(cached, name);

		return {
			findMany: (input) =>
				Effect.gen(function* () {
					const collection = yield* collectionFor(input.collection);
					let query = view
						.select()
						.from(collection.table)
						.where(compiledFragment(input.filter))
						.$dynamic();
					const ordering = input.orderBy.flatMap((term) => {
						const column = collection.columns[term.column];
						return column === undefined
							? []
							: [term.direction === 'asc' ? asc(column) : desc(column)];
					});
					if (ordering.length > 0) query = query.orderBy(...ordering);
					if (input.limit !== undefined) query = query.limit(input.limit);
					const rows = yield* executeBuilt(() => query);
					return rows.map(replicaJson);
				}),
			count: (name, filter) =>
				Effect.gen(function* () {
					const collection = yield* collectionFor(name);
					const rows = yield* executeBuilt(() =>
						view.select({ value: count() }).from(collection.table).where(compiledFragment(filter))
					);
					return Number(rows[0]?.value ?? 0);
				}),
			applySnapshot: (name, rows) =>
				Effect.gen(function* () {
					const collection = yield* collectionFor(name);
					return yield* upsertRows(view, collection, rows);
				}),
			applyChange: (change) =>
				Effect.gen(function* () {
					if (change.operation === 'reset') return;
					const collection = yield* collectionFor(change.collection);
					const id = collection.columns['id'];
					if (id === undefined) return;
					if (change.operation === 'delete') {
						yield* executeBuilt(() => view.delete(collection.table).where(eq(id, change.recordId)));
						return;
					}
					const decoded = Schema.decodeUnknownResult(JsonObject)(change.record);
					if (Result.isFailure(decoded)) return;
					yield* upsertRows(view, collection, [{ ...decoded.success, id: change.recordId }]);
				}),
			reset: () =>
				Effect.forEach(
					collections.values(),
					(collection) => executeBuilt(() => view.delete(collection.table)),
					{ discard: true }
				)
		};
	});
