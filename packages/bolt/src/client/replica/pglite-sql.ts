import { Cache, Effect, Schema } from 'effect';
import {
	and,
	asc,
	desc,
	eq,
	getColumns,
	inArray,
	sql,
	type SQL,
	type SQLChunk
} from 'drizzle-orm';
import { customType, pgTable, type AnyPgColumn, type AnyPgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pg-proxy';
import type { FieldDefinition } from '#lib/authoring/workspace-schema.js';
import { SYSTEM_COLUMN_NAMES } from '#lib/authoring/system-row-model.js';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import { encodeReferenceValues } from '#lib/runtime/collections/references.js';
import { compareSyncCursors } from '#lib/runtime/sync/sync.js';

type ReplicaFilter = Readonly<{
	readonly sql: string;
	readonly parameters: ReadonlyArray<Schema.Json>;
}>;

const combineReplicaFilters = (
	left: ReplicaFilter,
	right: ReplicaFilter | undefined
): ReplicaFilter => {
	if (right === undefined || right.sql === 'true') return left;
	if (left.sql === 'true') return right;
	const offset = left.parameters.length;
	return {
		sql: `(${left.sql}) and (${right.sql.replaceAll(
			/\$(\d+)/g,
			(_token, index: string) => `$${Number(index) + offset}`
		)})`,
		parameters: [...left.parameters, ...right.parameters]
	};
};

type ReplicaOrderTerm = Readonly<{
	readonly column: string;
	readonly direction: 'asc' | 'desc';
	/** The shared query compiler pins authored text order to PostgreSQL's built-in C collation. */
	readonly collation?: 'C';
}>;

export type ReplicaRead = Readonly<{
	readonly collection: string;
	readonly filter: ReplicaFilter;
	/** Shared authoritative/PGlite free-text predicate, kept distinct until this adapter binds it. */
	readonly search?: ReplicaFilter;
	readonly orderBy: ReadonlyArray<ReplicaOrderTerm>;
	readonly limit?: number;
	/** Restricts a read to one window's authoritative membership. */
	readonly recordIds?: ReadonlyArray<string>;
	/** Small read-only substitution for rows named by active O4 operations. */
	readonly overlay?: ReplicaOverlayView;
}>;

export type ReplicaOverlayView = Readonly<{
	/** Every affected id, including rows hidden by a pending delete. */
	readonly affectedRecordIds: ReadonlyArray<string>;
	/** Projected replacements and creates; deleted ids are deliberately absent. */
	readonly rows: ReadonlyArray<Readonly<Record<string, Schema.Json>>>;
}>;

export type AuthoritativeReplicaRow = Readonly<{
	readonly collection: string;
	readonly recordId: string;
	readonly rowVersion: number;
	/** Causal position of this authoritative fact. Hydrations use their read cursor. */
	readonly cursor?: ReplicaRowCursor;
	/** The complete field set permitted in this partition, never a projection. */
	readonly row: Readonly<Record<string, unknown>>;
}>;

export type AuthoritativeReplicaRemoval = Readonly<{
	readonly collection: string;
	readonly recordId: string;
	readonly rowVersion: number;
	/** Causal position of this authoritative fact. */
	readonly cursor?: ReplicaRowCursor;
}>;

export type ReplicaRowCursor = Readonly<{ readonly xid: number; readonly sequence: number }>;

export type ReplicaRowApplyOutcome = Readonly<{
	readonly applied: boolean;
	readonly present: boolean;
	readonly previousVersion?: number;
}>;

export type ReplicaBaseViewRow = Readonly<{
	readonly recordId: string;
	readonly rowVersion: number;
	readonly row: Readonly<Record<string, Schema.Json>>;
}>;

export type LocalReplicaStore = Readonly<{
	/** Executes the collection compiler's structured local read against authoritative base rows. */
	readonly findMany: (input: ReplicaRead) => Effect.Effect<ReadonlyArray<Schema.Json>, unknown>;
	/** Snapshot of authoritative O3 rows used as the immutable input to O4 derivation. */
	readonly baseRows: (
		collection: string,
		recordIds?: ReadonlyArray<string>
	) => Effect.Effect<ReadonlyArray<ReplicaBaseViewRow>, unknown>;
	/** Whole-row, authoritative, version-gated base-store upsert. */
	readonly applyAuthoritativeRow: (
		row: AuthoritativeReplicaRow
	) => Effect.Effect<ReplicaRowApplyOutcome, unknown>;
	/** Version-gated authoritative removal. A tombstone prevents delayed resurrection. */
	readonly removeAuthoritativeRow: (
		row: AuthoritativeReplicaRemoval
	) => Effect.Effect<ReplicaRowApplyOutcome, unknown>;
	/** Evicts unreachable payload while retaining its causal version fence. */
	readonly deleteRecords: (
		collection: string,
		recordIds: ReadonlyArray<string>
	) => Effect.Effect<number, unknown>;
	readonly recordIds: (collection: string) => Effect.Effect<ReadonlyArray<string>, unknown>;
	readonly hasRecord: (collection: string, recordId: string) => Effect.Effect<boolean, unknown>;
	/** Clears rows, proofs and O6 together; the caller supplies the surrounding transaction. */
	readonly clearNamespace: () => Effect.Effect<void, unknown>;
}>;

/**
 * The browser replica's actual PostgreSQL.
 *
 * PGlite is the storage engine chosen by the sync engine. Application and template code never sees
 * this port: reads reach the structured replica store, while hydration and stream writes reach the
 * whole-row version-gated methods. Query windows contain row identities only, never row payloads.
 * Raw statement execution is reserved for the ordered DDL provisioning boundary below.
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
export const databaseView = (database: PGliteLike) =>
	drizzle((statement, parameters, method) =>
		Effect.runPromise(
			database.query<Record<string, unknown>>(statement, parameters).pipe(
				Effect.map((result) => ({
					rows: method === 'all' ? result.rows.map((row) => Object.values(row)) : [...result.rows]
				}))
			)
		)
	);

export const executeBuilt = <Value>(build: () => Promise<Value>): Effect.Effect<Value, unknown> =>
	Effect.tryPromise(build);

/**
 * The replica's own bookkeeping, created beside the tenant's tables.
 *
 * The server's provisioning plan describes the workspace; these tables describe what the browser has
 * *proven* about its copy of it, so they are authored here rather than shipped. They are dropped and
 * rebuilt with the schema like everything else in the replica — a cache that loses its proofs simply
 * proves nothing and reads over the wire until it does.
 *
 * A window is one growing canonical query. It contains ordered record identities and proof facts;
 * the complete permitted row lives once in the generated collection table. `bolt_replica_base_row`
 * carries the whole-row version/tombstone needed for idempotent, out-of-order delta application.
 * `bolt_replica_position` is the only durable partition cursor/generation position and is advanced
 * in the same transaction as every base/window change it covers.
 */
// repository-health:allow SQL1 -- DDL bootstrap for the disposable local replica's own ledger.
const REPLICA_LEDGER_STEPS: ReadonlyArray<ProvisioningStep> = [
	{
		id: 'replica:base-row',
			sql: `create table if not exists bolt_replica_base_row (
			collection text not null,
			record_id uuid not null,
			row_version bigint not null check (row_version >= 1),
			cursor_xid bigint not null default 0,
			cursor_sequence bigint not null default 0,
			present boolean not null,
			evicted boolean not null default false,
			tombstone_until timestamptz,
			primary key (collection, record_id)
		)`
	},
	{
		id: 'replica:window',
		sql: `create table if not exists bolt_replica_window (
			query_key text primary key,
			collection text not null,
			canonical_query jsonb not null,
			dependencies jsonb not null,
			proof_owner text not null check (proof_owner in ('local', 'server')),
			locally_reproducible boolean not null,
			proof_confirmed boolean not null default false,
			valid boolean not null default false,
			dirty boolean not null default false,
			read_xid bigint not null default 0,
			read_sequence bigint not null default 0,
			dependency_generations jsonb not null default '{}'::jsonb,
			server_result jsonb,
			next_cursor text,
			row_count bigint not null default 0,
			lookahead_count bigint not null default 0,
			lease_count integer not null default 0 check (lease_count >= 0),
			expires_at timestamptz,
			bytes bigint not null default 0,
			last_access timestamptz not null default current_timestamp
		)`
	},
	{
		id: 'replica:window-lease',
		sql: `create table if not exists bolt_replica_window_lease (
			query_key text not null references bolt_replica_window (query_key) on delete cascade,
			owner_id text not null,
			primary key (query_key, owner_id)
		)`
	},
	{
		id: 'replica:window-row',
		sql: `create table if not exists bolt_replica_window_row (
			query_key text not null references bolt_replica_window (query_key) on delete cascade,
			ordinal integer not null check (ordinal >= 0),
			collection text not null,
			record_id uuid not null,
			primary key (query_key, ordinal),
			unique (query_key, collection, record_id)
		)`
	},
	{
		id: 'replica:window-row-record-index',
		sql: `create index if not exists bolt_replica_window_row_record
			on bolt_replica_window_row (collection, record_id)`
	},
	{
		id: 'replica:window-relationship',
		sql: `create table if not exists bolt_replica_window_relationship (
			query_key text not null references bolt_replica_window (query_key) on delete cascade,
			source_collection text not null,
			source_record_id uuid not null,
			relation text not null,
			target_collection text not null,
			target_record_id uuid not null,
			primary key (
				query_key, source_collection, source_record_id, relation,
				target_collection, target_record_id
			)
		)`
	},
	{
		id: 'replica:window-relationship-source-index',
		sql: `create index if not exists bolt_replica_window_relationship_source
			on bolt_replica_window_relationship (source_collection, source_record_id)`
	},
	{
		id: 'replica:window-relationship-target-index',
		sql: `create index if not exists bolt_replica_window_relationship_target
			on bolt_replica_window_relationship (target_collection, target_record_id)`
	},
	{
		id: 'replica:position',
		sql: `create table if not exists bolt_replica_position (
			singleton boolean primary key default true check (singleton),
			cursor_xid bigint not null default 0,
			cursor_sequence bigint not null default 0,
			generations jsonb not null default '{}'::jsonb
		)`
	},
	{
		id: 'replica:position-seed',
		sql: `insert into bolt_replica_position (singleton)
			values (true) on conflict (singleton) do nothing`
	},
	{
		id: 'replica:metadata',
		sql: `create table if not exists bolt_replica_metadata (
			singleton boolean primary key default true check (singleton),
			authority_generation bigint not null default 0,
			schema_fingerprint text not null default '',
			protocol_version integer not null default 1
		)`
	}
];

/** Creates the single base/window/position ledger for a fresh replica namespace. */
export const ensureReplicaLedger = (database: PGliteLike): Effect.Effect<void, unknown> =>
	Effect.forEach(REPLICA_LEDGER_STEPS, (step) => database.exec(step.sql), { discard: true });

export type DurableReplicaSchemaMetadata = Readonly<{
	readonly authorityGeneration: number;
	readonly fingerprint: string;
	readonly protocolVersion: number;
}>;

export const readDurableReplicaSchema = (
	database: PGliteLike
): Effect.Effect<DurableReplicaSchemaMetadata | undefined, never> =>
	database
		.query<{
			readonly authority_generation: number | string;
			readonly schema_fingerprint: string;
			readonly protocol_version: number | string;
		}>(
			`select authority_generation, schema_fingerprint, protocol_version
			 from bolt_replica_metadata where singleton = true limit 1`
		)
		.pipe(
			Effect.map(({ rows }) => {
				const row = rows[0];
				return row === undefined
					? undefined
					: {
							authorityGeneration: Number(row.authority_generation),
							fingerprint: row.schema_fingerprint,
							protocolVersion: Number(row.protocol_version)
						};
			}),
			Effect.catch(() => Effect.succeed(undefined))
		);

/** Called inside the caller's migration transaction after verified DDL has completed. */
export const writeDurableReplicaSchema = (
	database: PGliteLike,
	state: DurableReplicaSchemaMetadata
): Effect.Effect<void, unknown> =>
	database
		.query(
			`insert into bolt_replica_metadata
			 (singleton, authority_generation, schema_fingerprint, protocol_version)
			 values (true, $1, $2, $3)
			 on conflict (singleton) do update set
			 authority_generation = excluded.authority_generation,
			 schema_fingerprint = excluded.schema_fingerprint,
			 protocol_version = excluded.protocol_version`,
			[state.authorityGeneration, state.fingerprint, state.protocolVersion]
		)
		.pipe(Effect.asVoid);

/**
 * One PGlite transaction around an apply.
 *
 * Rows, coverage and the durable cursor are three statements describing one fact — "the replica is
 * now at this position" — and a crash between them leaves a replica whose cursor claims rows it does
 * not hold, or windows that prove a state it never applied. `REPEATABLE READ` also protects a
 * follower tab's proof-plus-read from a leader commit between its two statements: the in-process
 * permit serializes this tab, and the database snapshot serializes what it observes across tabs.
 */
export const withTransaction = <Value, Error>(
	database: PGliteLike,
	body: Effect.Effect<Value, Error>
): Effect.Effect<Value, Error | unknown> =>
	// repository-health:allow SQL1 -- transaction control for the replica's single-writer apply.
	database.exec('begin isolation level repeatable read').pipe(
		Effect.flatMap(() =>
			body.pipe(
				Effect.tap(() => database.exec('commit')),
				Effect.onError(() => database.exec('rollback').pipe(Effect.catch(() => Effect.void)))
			)
		)
	);

const schemaState = SYSTEM_MODEL_TABLES.bolt_schema_state;
type ReplicaState = Readonly<{
	readonly fingerprint: string;
	readonly cursor: { readonly xid: number; readonly sequence: number };
}>;

export type ReplicaPosition = Readonly<{
	readonly cursor: { readonly xid: number; readonly sequence: number };
	readonly generations: Readonly<Record<string, number>>;
}>;

const validGenerations = (value: unknown): Readonly<Record<string, number>> => {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
	const raw = Object.entries(value);
	const entries = raw.filter(
		(entry): entry is [string, number] =>
			entry[0].length > 0 &&
			typeof entry[1] === 'number' &&
			Number.isSafeInteger(entry[1]) &&
			entry[1] >= 0
	);
	return entries.length === raw.length ? Object.fromEntries(entries) : {};
};

/** O6: the single durable cursor and collection-generation position for this namespace. */
export const readReplicaPosition = (
	database: PGliteLike
): Effect.Effect<ReplicaPosition, unknown> =>
	database
		.query<{
			readonly cursor_xid: number | string;
			readonly cursor_sequence: number | string;
			readonly generations: unknown;
		}>(
			`select cursor_xid, cursor_sequence, generations
			 from bolt_replica_position where singleton = true limit 1`
		)
		.pipe(
			Effect.map(({ rows }) => {
				const row = rows[0];
				return row === undefined
					? { cursor: { xid: 0, sequence: 0 }, generations: {} }
					: {
							cursor: {
								xid: Number(row.cursor_xid),
								sequence: Number(row.cursor_sequence)
							},
							generations: validGenerations(row.generations)
						};
			})
		);

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
			readReplicaPosition(database).pipe(Effect.map(({ cursor }) => [cursor]))
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

/** Must commit in the same transaction as the base/window changes this position covers. */
export const writeReplicaPosition = (
	database: PGliteLike,
	position: ReplicaPosition
): Effect.Effect<void, unknown> =>
	database
		.query(
			`insert into bolt_replica_position
			 (singleton, cursor_xid, cursor_sequence, generations)
			 values (true, $1, $2, $3::jsonb)
			 on conflict (singleton) do update set
			 cursor_xid = excluded.cursor_xid,
			 cursor_sequence = excluded.cursor_sequence,
			 generations = excluded.generations`,
			[position.cursor.xid, position.cursor.sequence, JSON.stringify(position.generations)]
		)
		.pipe(Effect.asVoid);

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
	if (fingerprint !== undefined && state?.fingerprint === fingerprint) {
		return false;
	}
	if (fingerprint !== undefined && state !== undefined) {
		return yield* Effect.fail(
			new ReplicaNamespaceMismatch(state.fingerprint, fingerprint)
		);
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
	yield* ensureReplicaLedger(database);
	return true;
});

/** M3 requires a new physical namespace; provisioning never mutates an old schema in place. */
export class ReplicaNamespaceMismatch extends Error {
	readonly existingFingerprint: string;
	readonly requestedFingerprint: string;

	constructor(existingFingerprint: string, requestedFingerprint: string) {
		super('Replica schema changed; a new partition namespace is required');
		this.name = 'ReplicaNamespaceMismatch';
		this.existingFingerprint = existingFingerprint;
		this.requestedFingerprint = requestedFingerprint;
	}
}

/** Marks a namespace usable after its DDL and empty O6 position have landed. */
export const markProvisioned = Effect.fn('ReplicaSql.markProvisioned')(function* (
	database: PGliteLike,
	fingerprint: string,
	cursor: { readonly xid: number; readonly sequence: number }
): Effect.fn.Return<void, unknown> {
	const view = databaseView(database);
	yield* executeBuilt(() => view.delete(schemaState));
	yield* executeBuilt(() => view.insert(schemaState).values({ fingerprint }));
	yield* writeReplicaPosition(database, { cursor, generations: {} });
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
	readonly completeFields: ReadonlySet<string>;
}>;

/** Builds query metadata only; schema creation stays owned by the provisioning DDL above. */
const replicaCollection = (
	name: string,
	fields: Readonly<Record<string, FieldDefinition>>,
	readableFields: ReadonlyArray<string> | null | undefined
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
	const completeFields = new Set(
		readableFields === null
			? [
					...SYSTEM_COLUMN_NAMES,
					...Object.entries(fields).flatMap(([field, definition]) =>
						definition.generated === undefined ? [field] : []
					)
				]
			: readableFields ?? []
	);
	// Identity and whole-row version are structural replica facts, not optional UI projection.
	completeFields.add('id');
	completeFields.add('row_version');
	return { table, columns: getColumns(table), writable, fields, completeFields };
};

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

const upsertWholeRow = (
	view: ReturnType<typeof databaseView>,
	collection: ReplicaCollection,
	row: Readonly<Record<string, unknown>>
): Effect.Effect<void, unknown> => {
	const missing = [...collection.completeFields].filter((name) => !Object.hasOwn(row, name));
	if (missing.length > 0) {
		return Effect.fail(
			new Error(`Authoritative replica row is partial; missing permitted fields: ${missing.join(', ')}`)
		);
	}
	const physical = encodeReferenceValues(row, collection.fields);
	const names = [...collection.writable].filter((name) => Object.hasOwn(physical, name));
	if (!names.includes('id')) return Effect.fail(new Error('Authoritative replica row has no id'));
	const values = Object.fromEntries(names.map((name) => [name, physical[name] ?? null]));
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
	return executeBuilt(() => query).pipe(Effect.asVoid);
};

/**
 * Binds PGlite as a structured sync-engine store.
 *
 * There is deliberately no `query(sql, parameters)` member. Removing that capability means callers
 * cannot bypass collection query compilation or introduce handwritten replica CRUD later.
 */
export const createPGliteStore = (
	database: PGliteLike,
	fieldsByCollection: Readonly<Record<string, Readonly<Record<string, FieldDefinition>>>>,
	readableFieldsByCollection: Readonly<
		Record<string, ReadonlyArray<string> | null | undefined>
	> = {}
): Effect.Effect<LocalReplicaStore> =>
	Effect.gen(function* () {
		const view = databaseView(database);
		const collections = new Map(
			Object.entries(fieldsByCollection).map(([name, fields]) => [
				name,
				replicaCollection(name, fields, readableFieldsByCollection[name])
			])
		);
		const cached = yield* Cache.make({
			capacity: 1_000,
			timeToLive: 'Infinity',
			lookup: (name: string) => collectionOrFail(collections, name)
		});
		const collectionFor = (name: string) => Cache.get(cached, name);
		type StoredBaseVersion = Readonly<{
			readonly rowVersion: number;
			readonly cursor: ReplicaRowCursor;
			readonly present: boolean;
			readonly evicted: boolean;
		}>;
		const versionFor = (
			collection: string,
			recordId: string
		): Effect.Effect<StoredBaseVersion | undefined, unknown> =>
			database
				.query<{
					readonly row_version: number | string;
					readonly cursor_xid: number | string;
					readonly cursor_sequence: number | string;
					readonly present: boolean;
					readonly evicted: boolean;
				}>(
					`select row_version, cursor_xid, cursor_sequence, present, evicted
					 from bolt_replica_base_row
					 where collection = $1 and record_id = $2::uuid limit 1`,
					[collection, recordId]
				)
				.pipe(
					Effect.map(({ rows }) => {
						const row = rows[0];
						return row === undefined
							? undefined
							: {
									rowVersion: Number(row.row_version),
									cursor: {
										xid: Number(row.cursor_xid),
										sequence: Number(row.cursor_sequence)
									},
									present: row.present,
									evicted: row.evicted
								};
					})
				);
		const validRowCursor = (cursor: ReplicaRowCursor | undefined): boolean =>
			cursor === undefined || (
				Number.isSafeInteger(cursor.xid) && cursor.xid >= 0 &&
				Number.isSafeInteger(cursor.sequence) && cursor.sequence >= 0
			);
		const compareAuthoritativeFact = (
			row: AuthoritativeReplicaRemoval,
			previous: StoredBaseVersion
		): number => {
			if (row.cursor !== undefined) {
				const byCursor = compareSyncCursors(row.cursor, previous.cursor);
				if (byCursor !== 0) return byCursor;
			}
			return row.rowVersion - previous.rowVersion;
		};
			const writeBaseVersion = (
				row: AuthoritativeReplicaRemoval,
				previous: StoredBaseVersion | undefined,
				present: boolean
			): Effect.Effect<void, unknown> => {
				const cursor = row.cursor ?? previous?.cursor ?? { xid: 0, sequence: 0 };
				return database
					.query(
						`insert into bolt_replica_base_row
						 (collection, record_id, row_version, cursor_xid, cursor_sequence,
						  present, evicted, tombstone_until)
						 values ($1, $2::uuid, $3, $4, $5, $6, false,
						  case when $6 then null else current_timestamp + interval '24 hours' end)
						 on conflict (collection, record_id) do update set
						 row_version = excluded.row_version,
						 cursor_xid = excluded.cursor_xid,
						 cursor_sequence = excluded.cursor_sequence,
						 present = excluded.present,
						 evicted = false,
						 tombstone_until = excluded.tombstone_until`,
						[row.collection, row.recordId, row.rowVersion, cursor.xid, cursor.sequence, present]
					)
					.pipe(Effect.asVoid);
			};
			const queryRows = (
				collection: ReplicaCollection,
				input: ReplicaRead
			): Effect.Effect<ReadonlyArray<Schema.Json>, unknown> =>
				Effect.gen(function* () {
					const filter = combineReplicaFilters(input.filter, input.search);
					let query = view
						.select()
						.from(collection.table)
						.where(
							input.recordIds === undefined
								? compiledFragment(filter)
								: input.recordIds.length === 0
									? sql`false`
									: and(
											compiledFragment(filter),
											inArray(collection.columns['id']!, [...input.recordIds])
										)
						)
						.$dynamic();
					const ordering = input.orderBy.flatMap((term) => {
						const column = collection.columns[term.column];
						if (column === undefined) return [];
						const expression = term.collation === 'C'
							? sql`${column} collate "C"`
							: column;
						return [term.direction === 'asc' ? asc(expression) : desc(expression)];
					});
					if (ordering.length > 0) query = query.orderBy(...ordering);
					if (input.limit !== undefined) query = query.limit(input.limit);
					const rows = yield* executeBuilt(() => query);
					return rows.map(replicaJson);
				});
			const queryOverlayRows = (
				collection: ReplicaCollection,
				input: ReplicaRead,
				overlay: ReplicaOverlayView
			): Effect.Effect<ReadonlyArray<Schema.Json>, unknown> => {
				const filter = combineReplicaFilters(input.filter, input.search);
				const affectedRecordIds = [...new Set(overlay.affectedRecordIds)];
				if (
					affectedRecordIds.length === 0 ||
					affectedRecordIds.length !== overlay.affectedRecordIds.length
				) {
					return Effect.fail(new Error('Mutation overlay view has invalid or repeated affected ids'));
				}
				const projectedIds = overlay.rows.flatMap((row) =>
					typeof row['id'] === 'string' ? [row['id']] : []
				);
				if (
					projectedIds.length !== overlay.rows.length ||
					new Set(projectedIds).size !== projectedIds.length ||
					projectedIds.some((id) => !affectedRecordIds.includes(id))
				) {
					return Effect.fail(new Error('Mutation overlay view contains invalid or repeated row ids'));
				}
				const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
				const table = quote(input.collection);
				const filterParameters = [...filter.parameters];
				let parameter = filterParameters.length;
				const affectedParameter = ++parameter;
				const overlayParameter = ++parameter;
				const parameters: Array<unknown> = [
					...filterParameters,
					affectedRecordIds,
					JSON.stringify(
						overlay.rows.map((row) => encodeReferenceValues(row, collection.fields))
					)
				];
				const membership = input.recordIds === undefined
					? 'true'
					: input.recordIds.length === 0
						? 'false'
						: `${table}."id" = any($${++parameter}::uuid[])`;
				if (input.recordIds !== undefined && input.recordIds.length > 0)
					parameters.push([...input.recordIds]);
				const order = input.orderBy.flatMap((term) =>
					collection.columns[term.column] === undefined
						? []
						: [`"__bolt_effective".${quote(term.column)}${term.collation === 'C' ? ' collate "C"' : ''} ${term.direction}`]
				);
				const limit = input.limit === undefined ? '' : ` limit $${++parameter}`;
				if (input.limit !== undefined) parameters.push(input.limit);
				const statement = `with "__bolt_overlay_rows" as (
					select * from jsonb_populate_recordset(null::public.${table}, $${overlayParameter}::jsonb)
				)
				select * from (
					select ${table}.* from public.${table} as ${table}
					where not (${table}."id" = any($${affectedParameter}::uuid[]))
						and (${filter.sql}) and (${membership})
					union all
					select ${table}.* from "__bolt_overlay_rows" as ${table}
					where (${filter.sql}) and (${membership})
				) as "__bolt_effective"
				${order.length === 0 ? '' : `order by ${order.join(', ')}`}${limit}`;
				return database.query<Record<string, unknown>>(statement, parameters).pipe(
					Effect.map(({ rows }) => rows.map(replicaJson))
				);
			};

			return {
				findMany: (input) =>
					Effect.gen(function* () {
						const collection = yield* collectionFor(input.collection);
						return yield* (input.overlay === undefined
							? queryRows(collection, input)
							: queryOverlayRows(collection, input, input.overlay));
					}),
				baseRows: (name, recordIds) =>
					Effect.gen(function* () {
						const collection = yield* collectionFor(name);
						if (recordIds?.length === 0) return [];
						const id = collection.columns['id'];
						if (id === undefined)
							return yield* Effect.fail(new Error('Replica collection has no id column'));
						const rows = yield* executeBuilt(() =>
							recordIds === undefined
								? view.select().from(collection.table)
								: view.select().from(collection.table).where(inArray(id, [...recordIds]))
						);
						const versions = yield* database.query<{
							readonly record_id: string;
							readonly row_version: number | string;
						}>(
							`select record_id, row_version from bolt_replica_base_row
							 where collection = $1 and present = true
							 ${recordIds === undefined ? '' : 'and record_id = any($2::uuid[])'}`,
							recordIds === undefined ? [name] : [name, [...recordIds]]
						);
						const byId = new Map(
							versions.rows.map((row) => [row.record_id, Number(row.row_version)] as const)
						);
						return rows.flatMap((row) => {
							const json = replicaJson(row);
							if (json === null || typeof json !== 'object' || Array.isArray(json)) return [];
							const object = json as Readonly<Record<string, Schema.Json>>;
							const recordId = object['id'];
							const rowVersion = typeof recordId === 'string' ? byId.get(recordId) : undefined;
							return typeof recordId === 'string' && rowVersion !== undefined
								? [{ recordId, rowVersion, row: object }]
								: [];
						});
					}),
			applyAuthoritativeRow: (input) =>
				Effect.gen(function* () {
					if (
						!Number.isSafeInteger(input.rowVersion) || input.rowVersion < 1 ||
						!validRowCursor(input.cursor)
					) {
						return yield* Effect.fail(new Error('Authoritative replica row version is invalid'));
					}
					const previous = yield* versionFor(input.collection, input.recordId);
					const order = previous === undefined ? 1 : compareAuthoritativeFact(input, previous);
					const restoresEvictedPayload =
						previous?.evicted === true && order === 0 && previous.rowVersion === input.rowVersion;
					if (previous !== undefined && (order < 0 || (order === 0 && !restoresEvictedPayload))) {
						return {
							applied: false,
							present: previous.present,
							previousVersion: previous.rowVersion
						};
					}
					const collection = yield* collectionFor(input.collection);
					const row = { ...input.row, id: input.recordId, row_version: input.rowVersion };
					yield* upsertWholeRow(view, collection, row);
					yield* writeBaseVersion(input, previous, true);
					return {
						applied: true,
						present: true,
						...(previous === undefined ? {} : { previousVersion: previous.rowVersion })
					};
				}),
			removeAuthoritativeRow: (input) =>
				Effect.gen(function* () {
					if (
						!Number.isSafeInteger(input.rowVersion) || input.rowVersion < 1 ||
						!validRowCursor(input.cursor)
					) {
						return yield* Effect.fail(new Error('Authoritative replica row version is invalid'));
					}
					const previous = yield* versionFor(input.collection, input.recordId);
					if (previous !== undefined && compareAuthoritativeFact(input, previous) <= 0) {
						return {
							applied: false,
							present: previous.present,
							previousVersion: previous.rowVersion
						};
					}
					const collection = yield* collectionFor(input.collection);
					const id = collection.columns['id'];
					if (id !== undefined) {
						yield* executeBuilt(() => view.delete(collection.table).where(eq(id, input.recordId)));
					}
					yield* writeBaseVersion(input, previous, false);
					return {
						applied: true,
						present: false,
						...(previous === undefined ? {} : { previousVersion: previous.rowVersion })
					};
				}),
			deleteRecords: (name, recordIds) =>
				Effect.gen(function* () {
					if (recordIds.length === 0) return 0;
					const collection = yield* collectionFor(name);
					const id = collection.columns['id'];
					if (id === undefined) return 0;
					const removed = yield* executeBuilt(() =>
						view
							.delete(collection.table)
							.where(inArray(id, [...recordIds]))
							.returning({ id })
					);
					const metadata = yield* database.query<{ readonly record_id: string }>(
						`update bolt_replica_base_row set
						 present = false, evicted = true,
						 tombstone_until = current_timestamp + interval '24 hours'
					 where collection = $1 and record_id = any($2::uuid[]) and present = true
					 returning record_id`,
						[name, [...recordIds]]
					);
					return Math.max(removed.length, metadata.rows.length);
				}),
			recordIds: (name) =>
				Effect.gen(function* () {
					const collection = yield* collectionFor(name);
					const id = collection.columns['id'];
					if (id === undefined) return [];
					const rows = yield* executeBuilt(() => view.select({ id }).from(collection.table));
					return rows.flatMap((row) => (typeof row.id === 'string' ? [row.id] : []));
				}),
			hasRecord: (name, recordId) =>
				versionFor(name, recordId).pipe(
					Effect.map((version) => version?.present === true)
				),
			clearNamespace: () =>
				Effect.gen(function* () {
					yield* database.query('delete from bolt_replica_window');
					yield* Effect.forEach(
						collections.values(),
						(collection) => executeBuilt(() => view.delete(collection.table)),
						{ discard: true }
					);
					yield* database.query('delete from bolt_replica_base_row');
					yield* writeReplicaPosition(database, {
						cursor: { xid: 0, sequence: 0 },
						generations: {}
					});
				})
		};
	});
