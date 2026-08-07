import { getTableColumns, sql, type Column, type SQL } from 'drizzle-orm';
import {
	collectionSearchTrigramIndexName,
	type CollectionDefinition,
	type CollectionField
} from '@norbital-ai/platform-utils/collection';
import {
	SYSTEM_COLUMN_SPEC_BY_NAME,
	isSystemColumnName
} from '@norbital-ai/platform-utils/system/column_names';
import {
	attachColumnCustom,
	columnCustomIsKind,
	readColumnCustom,
	readBuilderCustom,
	type ColumnCustomMeta,
	type ColumnMetadataHost
} from './columns.js';
import {
	customType as pgCustomType,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	type AnyPgColumn,
	type AnyPgColumnBuilder,
	type ExtraConfigColumn,
	type PgTable,
	type PgTableExtraConfigValue
} from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { dateRangeZodSchema } from '../builtin/custom_types.js';
import type { CustomTypeSchema } from '../custom-type.js';

const _systemColumnDefs = {
	norbital_id: uuid().primaryKey().defaultRandom(),
	norbital_created_at: timestamp({ withTimezone: true }).defaultNow(),
	norbital_updated_at: timestamp({ withTimezone: true }).defaultNow(),
	norbital_sys_period: pgCustomType<{ data: string; driverData: string }>({
		dataType: () => 'tstzrange'
	})()
		.notNull()
		.default(sql`tstzrange(CURRENT_TIMESTAMP, NULL, '[)')`),
	norbital_row_version: integer().default(1),
	norbital_approval_id: uuid()
};

export type TableMeta = {
	readonly description?: string;
	readonly record_label?: string | null;
	readonly icon?: string | null;
	readonly semanticSearch?: boolean;
	readonly system?: boolean;
	/**
	 * Whether this collection keeps a typed `<table>_history` temporal relation. Defaults to true.
	 *
	 * The single source both the migration generator and the runtime post-DDL read, so neither can
	 * decide a collection is temporal while the other decides it is not.
	 */
	readonly history?: boolean;
	readonly indexes?: readonly TableIndex[];
	/**
	 * Postgres EXCLUDE constraints. Drizzle has no entity for them, so these are pure
	 * metadata: they never reach `pgTable` (drizzle-kit must not see them) and are
	 * emitted out-of-band into `schema-post-ddl.sql` by `workspaceExclusionsDdl`.
	 */
	readonly exclusions?: readonly TableExclusion[];
};

/** Index method supported by the authoring layer. */
export type TableIndexMethod =
	| 'btree'
	| 'hash'
	| 'gist'
	| 'gin'
	| 'brin'
	| 'spgist'
	/** pgvector approximate nearest neighbor (requires the `vector` extension). */
	| 'hnsw'
	| 'ivfflat';

export type TableIndex = {
	/** REQUIRED when any member is an expression — drizzle-kit cannot derive a name from SQL. */
	readonly name?: string;
	readonly columns: readonly (string | { readonly expr: string })[];
	readonly unique?: boolean;
	/** Raw SQL predicate for a partial index. */
	readonly where?: string;
	readonly method?: TableIndexMethod;
	/** Column name -> operator class (e.g. `{ title: 'gin_trgm_ops' }`). */
	readonly opclass?: Readonly<Record<string, string>>;
};

/** One `<expr> WITH <operator>` element of an EXCLUDE constraint. */
export type TableExclusionElement = {
	readonly expr: string;
	readonly with: string;
};

export type TableExclusion = {
	/** Stable; becomes the Postgres constraint name. */
	readonly name: string;
	readonly using?: 'gist' | 'btree';
	readonly elements: readonly TableExclusionElement[];
	/** Raw SQL predicate for a partial exclusion constraint. */
	readonly where?: string;
};

const _metaStore = new WeakMap<object, TableMeta>();

export function getTableMeta(table: object): TableMeta | undefined {
	return _metaStore.get(table);
}

/** User columns on a built Norbital table (excludes system columns). */
export function getTableColumnDefs(table: PgTable): Readonly<Record<string, AnyPgColumn>> {
	return Object.fromEntries(
		Object.entries(getTableColumns(table)).filter(([name]) => !isSystemColumnName(name))
	);
}

function portableColumnKind(column: AnyPgColumn): string {
	const custom = readColumnCustom(column);
	if (custom) return custom.kind;
	if (column.enumValues?.length) return 'enum';

	switch (column.columnType) {
		case 'PgBoolean':
			return 'boolean';
		case 'PgUUID':
			return 'uuid';
		case 'PgTimestamp':
		case 'PgTimestampString':
			return column.getSQLType().includes('with time zone') ? 'timestamptz' : 'timestamp';
		case 'PgDate':
		case 'PgDateString':
			return 'date';
		case 'PgInteger':
		case 'PgSmallInt':
		case 'PgSerial':
		case 'PgSmallSerial':
		case 'PgBigInt53':
		case 'PgBigInt64':
		case 'PgBigSerial53':
		case 'PgBigSerial64':
			return 'integer';
		case 'PgNumeric':
		case 'PgNumericNumber':
		case 'PgNumericBigInt':
			return 'numeric';
		case 'PgReal':
		case 'PgDoublePrecision':
			return 'number';
		case 'PgJson':
		case 'PgJsonb':
			return 'json';
		case 'PgText':
		case 'PgVarchar':
		case 'PgChar':
			return 'text';
		case 'PgVector':
			return 'vector';
		default:
			return column.getSQLType().toLowerCase();
	}
}

export function portableCollectionField(name: string, column: AnyPgColumn): CollectionField {
	const systemSpec = isSystemColumnName(name) ? SYSTEM_COLUMN_SPEC_BY_NAME.get(name) : undefined;
	const custom = readColumnCustom(column);
	const enumCustom = columnCustomIsKind(custom, 'enum') ? custom : undefined;
	const readOnly =
		systemSpec != null || column.generated != null || column.generatedIdentity != null;
	const values = enumCustom?.values ?? (column.enumValues?.length ? column.enumValues : undefined);
	const options = custom && 'definitionBacked' in custom ? custom.options : undefined;

	const embeddingDimensions = columnCustomIsKind(custom, 'vector')
		? custom.dimensions
		: column.columnType === 'PgVector'
			? column.length
			: undefined;

	return {
		name,
		kind: systemSpec?.kindName ?? portableColumnKind(column),
		nullable: systemSpec?.nullable ?? !column.notNull,
		...(column.dimensions > 0 ? { array: true } : {}),
		...(readOnly ? { readOnly: true } : {}),
		...(values ? { values } : {}),
		...(options ? { options } : {}),
		...(embeddingDimensions != null
			? { options: { ...(options ?? {}), dimensions: embeddingDimensions } }
			: {}),
		...(columnCustomIsKind(custom, 'money') && custom.currencies
			? { currencies: custom.currencies }
			: {}),
		...(columnCustomIsKind(custom, 'file') && custom.mimeTypes
			? { mimeTypes: custom.mimeTypes }
			: {}),
		...(columnCustomIsKind(custom, 'numeric') ? { variant: custom.variant } : {})
	};
}

/** Portable collection metadata for runtime clients; no Drizzle values escape this projection. */
export function buildCollectionDefinitions(
	tables: Readonly<Record<string, PgTable>>
): Readonly<Record<string, CollectionDefinition>> {
	return Object.fromEntries(
		Object.entries(tables).map(([name, table]) => [
			name,
			{
				name,
				fields: Object.entries(getTableColumns(table)).map(([fieldName, column]) =>
					portableCollectionField(fieldName, column)
				)
			} satisfies CollectionDefinition
		])
	);
}

function readBuiltColumn(table: PgTable, name: string): AnyPgColumn | undefined {
	// Safe: Drizzle pgTable instances index built columns by declaration name at runtime.
	return (table as unknown as Record<string, AnyPgColumn>)[name]; // stupidity: boundary-cast — Drizzle exposes declared columns as dynamic properties.
}

function copyColumnCustomFromBuilders(
	table: PgTable,
	columns: Record<string, AnyPgColumnBuilder>
): void {
	for (const [name, builder] of Object.entries(columns)) {
		const built = readBuiltColumn(table, name);
		if (!built) continue;
		const meta = readBuilderCustom(builder);
		if (meta) attachColumnCustom(built, meta);
	}
}

/** JSONB column with Zod validation and attached custom kind metadata. */
export function jsonbColumn<T>(schema: z.ZodType<T>, custom: ColumnCustomMeta) {
	const column = pgCustomType<{ data: T | null; driverData: string | null }>({
		dataType() {
			return 'jsonb';
		},
		toDriver(value: T | null): string | null {
			if (value == null) return null;
			return JSON.stringify(schema.parse(value));
		},
		fromDriver(value: string | null): T | null {
			if (value == null) return null;
			// jsonb drivers may hand back an already-parsed object instead of a string.
			// stupidity:allow R6b -- schema.parse validates the driver JSON on the next line.
			const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
			return schema.parse(parsed);
		}
	})();
	attachColumnCustom(column, custom);
	return column;
}

/** Definition-backed JSONB column. The filesystem registry binds its schema before use. */
export function namedJsonbColumn<T>(kind: string, options?: Readonly<Record<string, unknown>>) {
	const metadata: {
		readonly kind: string;
		readonly definitionBacked: true;
		readonly options?: Readonly<Record<string, unknown>>;
		zodSchema?: CustomTypeSchema<T>;
	} = { kind, definitionBacked: true, options };
	const parse = (value: unknown): T => {
		if (!metadata.zodSchema) {
			throw new Error(`Custom type "${kind}" has no bound definition schema.`);
		}
		return metadata.zodSchema.parse(value);
	};
	const column = pgCustomType<{ data: T | null; driverData: string | null }>({
		dataType() {
			return 'jsonb';
		},
		toDriver(value: T | null): string | null {
			if (value == null) return null;
			return JSON.stringify(parse(value));
		},
		fromDriver(value: string | null): T | null {
			if (value == null) return null;
			// jsonb drivers may hand back an already-parsed object instead of a string.
			// stupidity:allow R6b -- parse() validates the decoded JSON against the bound definition.
			const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
			return parse(parsed);
		}
	})();
	attachColumnCustom(column, metadata);
	return column;
}

/** Date-range JSONB containing canonical UTC ISO bounds. */
export function dateRangeJsonbColumn(custom: ColumnCustomMeta) {
	return jsonbColumn(dateRangeZodSchema, custom);
}

/** Text column with Zod enum validation and attached custom kind metadata. */
export function textEnumColumn(schema: z.ZodType<string>, custom: ColumnCustomMeta) {
	const column = pgCustomType<{
		data: string | null;
		driverData: string | null;
	}>({
		dataType() {
			return 'text';
		},
		toDriver(value: string | null): string | null {
			if (value == null) return null;
			return schema.parse(value);
		},
		fromDriver(value: string | null): string | null {
			if (value == null) return null;
			return schema.parse(value);
		}
	})();
	attachColumnCustom(column, custom);
	return column;
}

type SystemColumnDefs = typeof _systemColumnDefs;
type NorbitalColumnDefs<TColumns extends NorbitalColumns> = SystemColumnDefs & TColumns;

type InferSelect<TColumns extends NorbitalColumns> = NorbitalTableInternal<
	string,
	TColumns
>['$inferSelect'];

/** Column map accepted by `defineCollection` (drizzle stays internal to pod). */
export type NorbitalColumns = Record<string, AnyPgColumnBuilder>;

/** Row shape inferred from user-authored column builders (includes system columns). */
export type InferTableSelect<TColumns extends NorbitalColumns> = InferSelect<
	NorbitalColumnDefs<TColumns>
>;

/**
 * Opaque table type for template workspace consumers.
 *
 * Composes the Drizzle `PgTable` with the inferred select type so that
 * `$inferSelect` is preserved for type inference in workspace handlers.
 * Parameterized on both `TName` and `TInferSelect` — the latter carries
 * the concrete row shape without leaking Drizzle column builder types.
 */
type OpaqueNorbitalColumns<TName extends string, TInferSelect> = {
	[K in keyof TInferSelect & string]: AnyPgColumn<{
		name: K;
		tableName: TName;
		data: TInferSelect[K];
	}>;
};

export type NorbitalTable<TName extends string, TInferSelect = Record<never, never>> = PgTable<{
	name: TName;
	schema: undefined;
	columns: OpaqueNorbitalColumns<TName, TInferSelect>;
	dialect: 'pg';
}> &
	OpaqueNorbitalColumns<TName, TInferSelect> & {
		readonly $inferSelect: TInferSelect;
	};

/** Full Drizzle return type — internal use only (system tables within the framework). */
type NorbitalTableInternal<
	TName extends string,
	TColumns extends Record<string, AnyPgColumnBuilder>
> = ReturnType<typeof pgTable<TName, NorbitalColumnDefs<TColumns>>>;

function finalizeNorbitalTableInternal<
	TName extends string,
	TColumns extends Record<string, AnyPgColumnBuilder>
>(table: ReturnType<typeof pgTable>): NorbitalTableInternal<TName, TColumns> {
	// Safe: pgTable return carries the declared name/column builder map at runtime.
	return table as unknown as NorbitalTableInternal<TName, TColumns>; // stupidity: boundary-cast — pgTable's declared generic metadata is runtime-erased.
}

function finalizeOpaqueNorbitalTable<
	TName extends string,
	TInferSelect extends Record<string, unknown>
>(
	table: NorbitalTableInternal<TName, Record<string, AnyPgColumnBuilder>>
): NorbitalTable<TName, TInferSelect> {
	// Safe: opaque export preserves runtime table while hiding Drizzle builder types.
	return table as unknown as NorbitalTable<TName, TInferSelect>; // stupidity: boundary-cast — preserves the opaque Drizzle table while hiding builder internals.
}

function isSearchableTextBuilder(builder: AnyPgColumnBuilder): boolean {
	const config = Reflect.get(builder, 'config');
	if (!config || typeof config !== 'object') return false;
	if (Number(Reflect.get(config, 'dimensions') ?? 0) > 0) return false;
	const columnType = Reflect.get(config, 'columnType');
	if (columnType === 'PgVector') return false;
	const customKind = readBuilderCustom(builder)?.kind;
	if (customKind === 'vector') return false;
	return columnType === 'PgText' || customKind === 'enum';
}

function assertTimezoneAwareTimestamps(
	tableName: string,
	columns: Readonly<Record<string, AnyPgColumnBuilder>>
): void {
	for (const [columnName, builder] of Object.entries(columns)) {
		const config = Reflect.get(builder, 'config');
		if (!config || typeof config !== 'object') continue;
		if (
			Reflect.get(config, 'columnType') === 'PgTimestamp' &&
			Reflect.get(config, 'withTimezone') !== true
		) {
			throw new Error(
				`Timestamp column "${tableName}.${columnName}" must use PostgreSQL timestamptz. Import timestamp() from @norbital-ai/pod/authoring.`
			);
		}
	}
}

/** Members accepted by drizzle's `IndexBuilderOn.on/using` — a column (optionally opclass-tagged) or raw SQL. */
type IndexMember = Partial<ExtraConfigColumn> | SQL;

/**
 * Translate an authored `TableIndex` into a drizzle index builder.
 *
 * Expression members go through `sql.raw`, which drizzle-kit's serializer records as
 * `{ isExpression: true }` and renders verbatim. Drizzle derives an index name from its
 * *column* members, so an index that has no column member to name itself after would be
 * emitted with a garbage name — hence the explicit-name requirement below.
 */
function assertTableIndexes(
	tableName: string,
	columnNames: readonly string[],
	indexes: readonly TableIndex[]
): void {
	// Eager, because drizzle evaluates a table's extra-config callback lazily — a mistake left
	// to that callback would only surface during migration generation, far from its source.
	for (const idx of indexes) {
		if (idx.columns.length === 0) {
			throw new Error(`Index on "${tableName}" must declare at least one column`);
		}
		if (idx.columns.some((member) => typeof member !== 'string') && !idx.name) {
			throw new Error(
				`Index on "${tableName}" uses an expression member and must declare an explicit \`name\`.`
			);
		}
		for (const member of idx.columns) {
			if (typeof member === 'string' && !columnNames.includes(member)) {
				throw new Error(`Unknown index column "${tableName}.${member}"`);
			}
		}
	}
}

function buildTableIndex(
	tableName: string,
	self: Record<string, ExtraConfigColumn>,
	idx: TableIndex
): PgTableExtraConfigValue {
	const members: IndexMember[] = idx.columns.map((member) => {
		if (typeof member !== 'string') return sql.raw(member.expr);
		const column = self[member];
		if (!column) throw new Error(`Unknown index column "${tableName}.${member}"`);
		const opclass = idx.opclass?.[member];
		return opclass ? column.op(opclass) : column;
	});
	if (members.length === 0) {
		throw new Error(`Index on "${tableName}" must declare at least one column`);
	}
	// Safe: emptiness is checked directly above; drizzle only wants a non-empty tuple.
	const spread = members as [IndexMember, ...IndexMember[]]; // stupidity: boundary-cast — drizzle types the member list as a non-empty tuple.

	const builderOn = idx.unique ? uniqueIndex(idx.name) : index(idx.name);
	const builder = idx.method ? builderOn.using(idx.method, ...spread) : builderOn.on(...spread);
	return idx.where ? builder.where(sql.raw(idx.where)) : builder;
}

function _buildTable<TName extends string, TColumns extends Record<string, AnyPgColumnBuilder>>(
	name: TName,
	columns: TColumns,
	extraConfig?: (self: Record<string, ExtraConfigColumn>) => PgTableExtraConfigValue[],
	meta?: TableMeta
): NorbitalTableInternal<TName, TColumns> {
	const columnDefs = {
		..._systemColumnDefs,
		...columns
	} satisfies NorbitalColumnDefs<TColumns>;

	assertTimezoneAwareTimestamps(name, columns);
	if (meta?.indexes?.length) assertTableIndexes(name, Object.keys(columnDefs), meta.indexes);

	const indexConfigFn = meta?.indexes?.length
		? (self: Record<string, ExtraConfigColumn>) =>
				meta.indexes!.map((idx) => buildTableIndex(name, self, idx))
		: undefined;

	const userExtraConfigFn = extraConfig
		? (self: Record<string, ExtraConfigColumn>) => extraConfig(self)
		: undefined;
	const searchIndexConfigFn = (self: Record<string, ExtraConfigColumn>) =>
		Object.entries(columns)
			.filter(([, builder]) => isSearchableTextBuilder(builder))
			.map(([columnName]) => {
				const column = self[columnName];
				if (!column) throw new Error(`Missing searchable column ${name}.${columnName}`);
				return index(collectionSearchTrigramIndexName(name, columnName)).using(
					'gin',
					column.op('gin_trgm_ops')
				);
			});

	const combinedFn = (self: Record<string, ExtraConfigColumn>) => [
		...(indexConfigFn?.(self) ?? []),
		...(userExtraConfigFn?.(self) ?? []),
		...searchIndexConfigFn(self)
	];

	const table = pgTable(name, columnDefs, combinedFn);
	copyColumnCustomFromBuilders(table, columns);

	if (meta) {
		_metaStore.set(table, meta);
	}

	return finalizeNorbitalTableInternal<TName, TColumns>(table);
}

/**
 * Create a Norbital table with system columns auto-injected.
 * Returns an opaque `NorbitalTable<TName>` — no Drizzle internals leak into
 * downstream declaration files.
 */
export function norbitalTable<TName extends string, TColumns extends NorbitalColumns>(
	name: TName,
	columns: TColumns,
	meta: TableMeta
): NorbitalTable<TName, InferSelect<NorbitalColumnDefs<TColumns>>>;
export function norbitalTable<TName extends string, TColumns extends NorbitalColumns>(
	name: TName,
	columns: TColumns,
	extraConfig: (self: Record<string, ExtraConfigColumn>) => PgTableExtraConfigValue[],
	meta?: TableMeta
): NorbitalTable<TName, InferSelect<NorbitalColumnDefs<TColumns>>>;
export function norbitalTable<TName extends string, TColumns extends NorbitalColumns>(
	name: TName,
	columns: TColumns,
	extraConfigOrMeta?:
		((self: Record<string, ExtraConfigColumn>) => PgTableExtraConfigValue[]) | TableMeta,
	metaOrNothing?: TableMeta
): NorbitalTable<TName, InferSelect<NorbitalColumnDefs<TColumns>>> {
	const extraConfig = typeof extraConfigOrMeta === 'function' ? extraConfigOrMeta : undefined;
	const meta = typeof extraConfigOrMeta === 'function' ? metaOrNothing : extraConfigOrMeta;

	const table = _buildTable(name, columns, extraConfig, meta);
	return finalizeOpaqueNorbitalTable<TName, InferSelect<NorbitalColumnDefs<TColumns>>>(
		table as NorbitalTableInternal<TName, Record<string, AnyPgColumnBuilder>>
	);
}

/**
 * Internal table creator for framework system tables.
 * Returns the full Drizzle type with column-level access (for `.references()`).
 * Only usable within `@norbital-ai/pod` where `drizzle-orm` is a direct dependency.
 */
export function norbitalTableInternal<
	TName extends string,
	TColumns extends Record<string, AnyPgColumnBuilder>
>(name: TName, columns: TColumns, meta: TableMeta): NorbitalTableInternal<TName, TColumns>;
export function norbitalTableInternal<
	TName extends string,
	TColumns extends Record<string, AnyPgColumnBuilder>
>(
	name: TName,
	columns: TColumns,
	extraConfig: (self: Record<string, ExtraConfigColumn>) => PgTableExtraConfigValue[],
	meta?: TableMeta
): NorbitalTableInternal<TName, TColumns>;
export function norbitalTableInternal<
	TName extends string,
	TColumns extends Record<string, AnyPgColumnBuilder>
>(
	name: TName,
	columns: TColumns,
	extraConfigOrMeta?:
		((self: Record<string, ExtraConfigColumn>) => PgTableExtraConfigValue[]) | TableMeta,
	metaOrNothing?: TableMeta
): NorbitalTableInternal<TName, TColumns> {
	const extraConfig = typeof extraConfigOrMeta === 'function' ? extraConfigOrMeta : undefined;
	const meta = typeof extraConfigOrMeta === 'function' ? metaOrNothing : extraConfigOrMeta;
	return _buildTable(name, columns, extraConfig, meta);
}

export type { ColumnMetadataHost };
