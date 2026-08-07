import { z } from 'zod';
import { isUtcIsoInstant } from '@norbital-ai/std/date';

/** System record column names — every `c_*` tenant collection table uses this set. */
export const SYSTEM_COLUMN_NAMES = {
	PKEY: 'norbital_id',
	CREATED_AT: 'norbital_created_at',
	UPDATED_AT: 'norbital_updated_at',
	SYS_PERIOD: 'norbital_sys_period',
	ROW_VERSION: 'norbital_row_version',
	APPROVAL_ID: 'norbital_approval_id'
} as const;

export type SystemColumnKey = keyof typeof SYSTEM_COLUMN_NAMES;
export type SystemColumnName = (typeof SYSTEM_COLUMN_NAMES)[SystemColumnKey];

export type SystemColumnSpec = {
	readonly key: SystemColumnKey;
	readonly name: SystemColumnName;
	readonly kindName: string;
	readonly pg: string;
	/** SQL type/constraint fragment after the column identifier in CREATE TABLE. */
	readonly ddlTypeSql: string;
	readonly nullable: boolean;
	readonly unique: boolean;
	readonly index: boolean;
	/** Postgres defaults/triggers own the value — omit from mutation upserts. */
	readonly dbManaged: boolean;
	/** Added after CREATE TABLE (search indexes), not in the initial table body. */
	readonly deferredDdl: boolean;
	/** Implicit on reads/queries (not listed in collection.schema). */
	readonly implicitQuery: boolean;
};

/**
 * System columns injected into every tenant collection table.
 *
 * Future: a per-record omni embedding (`vector(n)` via Gemini multimodal) may land here as
 * another system column — same `vector()` + HNSW + `findNearest` path used by PDQ photo
 * embeddings today (`metric: 'cosine'` for omni, `'l2'` for binary PDQ). One path only.
 */
const SYSTEM_COLUMN_SPECS: readonly SystemColumnSpec[] = [
	{
		key: 'PKEY',
		name: SYSTEM_COLUMN_NAMES.PKEY,
		kindName: 'uuid',
		pg: 'UUID',
		ddlTypeSql: 'uuid PRIMARY KEY DEFAULT uuidv7()',
		nullable: false,
		unique: true,
		index: true,
		dbManaged: false,
		deferredDdl: false,
		implicitQuery: true
	},
	{
		key: 'CREATED_AT',
		name: SYSTEM_COLUMN_NAMES.CREATED_AT,
		kindName: 'timestamptz',
		pg: 'TIMESTAMPTZ',
		ddlTypeSql: 'timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP',
		nullable: false,
		unique: false,
		index: false,
		dbManaged: false,
		deferredDdl: false,
		implicitQuery: true
	},
	{
		key: 'UPDATED_AT',
		name: SYSTEM_COLUMN_NAMES.UPDATED_AT,
		kindName: 'timestamptz',
		pg: 'TIMESTAMPTZ',
		ddlTypeSql: 'timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP',
		nullable: false,
		unique: false,
		index: false,
		dbManaged: false,
		deferredDdl: false,
		implicitQuery: true
	},
	{
		key: 'SYS_PERIOD',
		name: SYSTEM_COLUMN_NAMES.SYS_PERIOD,
		kindName: 'tstzrange',
		pg: 'TSTZRANGE',
		ddlTypeSql: "tstzrange NOT NULL DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)')",
		nullable: false,
		unique: false,
		index: false,
		dbManaged: true,
		deferredDdl: false,
		implicitQuery: true
	},
	{
		key: 'ROW_VERSION',
		name: SYSTEM_COLUMN_NAMES.ROW_VERSION,
		kindName: 'numeric',
		pg: 'INTEGER',
		ddlTypeSql: 'integer NOT NULL DEFAULT 1',
		nullable: false,
		unique: false,
		index: false,
		dbManaged: true,
		deferredDdl: false,
		implicitQuery: true
	},
	{
		key: 'APPROVAL_ID',
		name: SYSTEM_COLUMN_NAMES.APPROVAL_ID,
		kindName: 'uuid',
		pg: 'UUID',
		ddlTypeSql: 'uuid NULL',
		nullable: true,
		unique: false,
		index: false,
		dbManaged: true,
		deferredDdl: false,
		implicitQuery: true
	}
] as const;

export const SYSTEM_COLUMN_SPEC_BY_KEY: Readonly<Record<SystemColumnKey, SystemColumnSpec>> =
	Object.fromEntries(SYSTEM_COLUMN_SPECS.map((spec) => [spec.key, spec])) as Readonly<
		Record<SystemColumnKey, SystemColumnSpec>
	>;

export const SYSTEM_COLUMN_SPEC_BY_NAME: ReadonlyMap<SystemColumnName, SystemColumnSpec> = new Map(
	SYSTEM_COLUMN_SPECS.map((spec) => [spec.name, spec])
);

/** Full persisted row fields shared by system-module and tenant-authored collections. */
const StoredTimestampSchema = z
	.union([z.string(), z.date()])
	.transform((value) => (value instanceof Date ? value.toISOString() : value))
	.refine(isUtcIsoInstant, { message: 'Expected a UTC ISO instant ending in Z' });

export const SystemRecordFieldsSchema = z.object({
	[SYSTEM_COLUMN_NAMES.PKEY]: z.string(),
	[SYSTEM_COLUMN_NAMES.CREATED_AT]: StoredTimestampSchema,
	[SYSTEM_COLUMN_NAMES.UPDATED_AT]: StoredTimestampSchema,
	[SYSTEM_COLUMN_NAMES.SYS_PERIOD]: z.string(),
	[SYSTEM_COLUMN_NAMES.ROW_VERSION]: z.coerce.number(),
	[SYSTEM_COLUMN_NAMES.APPROVAL_ID]: z.string().nullable()
});

export type SystemRecordFields = z.infer<typeof SystemRecordFieldsSchema>;

export function allSystemColumnNames(): readonly SystemColumnName[] {
	return SYSTEM_COLUMN_SPECS.map((spec) => spec.name);
}

/** Columns emitted in CREATE TABLE. */
export function createTableSystemColumnSpecs(): readonly SystemColumnSpec[] {
	return SYSTEM_COLUMN_SPECS.filter((spec) => !spec.deferredDdl);
}

export function createTableSystemColumnNames(): readonly SystemColumnName[] {
	return createTableSystemColumnSpecs().map((spec) => spec.name);
}

/** Implicit system fields merged into query/mutation path resolution. */
export function implicitQuerySystemColumnSpecs(): readonly SystemColumnSpec[] {
	return SYSTEM_COLUMN_SPECS.filter((spec) => spec.implicitQuery);
}

export function implicitQuerySystemColumnNames(): readonly SystemColumnName[] {
	return implicitQuerySystemColumnSpecs().map((spec) => spec.name);
}

// stupidity:allow R5b -- canonical guard for the exported system-column literal union
export function isSystemColumnName(name: string): name is SystemColumnName {
	return SYSTEM_COLUMN_SPEC_BY_NAME.has(name as SystemColumnName);
}

/** Postgres defaults/triggers own these — mutation upserts must not rewrite them from JSON payloads. */
export const MUTATION_EXCLUDED_SYSTEM_COLUMNS: ReadonlySet<string> = new Set(
	SYSTEM_COLUMN_SPECS.filter((spec) => spec.dbManaged).map((spec) => spec.name)
);

/** Defaults for empty/stub requestor objects in tests and client shells. */
export function defaultSystemRecordFields(
	overrides: Partial<SystemRecordFields> = {}
): SystemRecordFields {
	return {
		[SYSTEM_COLUMN_NAMES.PKEY]: '',
		[SYSTEM_COLUMN_NAMES.CREATED_AT]: '',
		[SYSTEM_COLUMN_NAMES.UPDATED_AT]: '',
		[SYSTEM_COLUMN_NAMES.SYS_PERIOD]: '',
		[SYSTEM_COLUMN_NAMES.ROW_VERSION]: 1,
		[SYSTEM_COLUMN_NAMES.APPROVAL_ID]: null,
		...overrides
	};
}

export function seedInsertSystemColumnNames(): readonly SystemColumnName[] {
	return SYSTEM_COLUMN_SPECS.filter((spec) => !spec.deferredDdl && !spec.dbManaged).map(
		(spec) => spec.name
	);
}
