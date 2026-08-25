// repository-health:allow SEM_PARALLEL -- model-introspection imports the model declarations it
// describes (./models-schema.js), so the pair is linked, not parallel.
import { SQL, getColumns, is, sql } from 'drizzle-orm';
import {
	PgDialect,
	pgTable,
	uuid,
	type AnyPgColumn,
	type AnyPgColumnBuilder,
	type PgBuildColumns,
	type PgBuildExtraConfigColumns,
	type PgTableExtraConfigValue,
	type PgTableWithColumns
} from 'drizzle-orm/pg-core';
import { Effect, Record as EffectRecord, Schema } from 'effect';
import type { CollectionDefinition, FieldDefinition, ScalarType } from './workspace-schema.js';
import {
	isReferenceBuilder,
	referenceStorageColumn,
	type AnyModelFieldBuilder,
	type ModelDeclaration,
	type ModelIndex,
	type ReferenceBuilder
} from './models-schema.js';
import { defineSystemRowModel, type SystemRowColumns } from './system-row-model.js';

/**
 * Reads what a `defineModel` declaration actually says.
 *
 * The compiler used to recover columns by matching regular expressions against `+model.ts` source,
 * which could see a builder's name and nothing else. A `generatedAlwaysAs` column therefore reached
 * the schema plan as an ordinary column that nothing ever writes, so every derived value —
 * `leave_requests.kind`, `from_date`, `days`, `summary` — was NULL on every row. The declarations
 * are ordinary Drizzle builders, so the truth is available by reading them.
 */

/** Drizzle's `columnType` for each builder the authoring surface exposes. */
const SCALAR_BY_COLUMN_TYPE: Readonly<Record<string, ScalarType>> = {
	PgText: 'string',
	PgVarchar: 'string',
	PgChar: 'string',
	PgUUID: 'uuid',
	PgDateString: 'string',
	PgDate: 'instant',
	PgTimestamp: 'instant',
	PgTimestampString: 'instant',
	PgNumeric: 'number',
	PgNumericNumber: 'number',
	PgInteger: 'number',
	PgBigInt53: 'number',
	PgDoublePrecision: 'number',
	PgReal: 'number',
	PgBoolean: 'boolean',
	PgJsonb: 'json',
	PgJson: 'json',
	PgVector: 'json'
};

type ColumnConfig = Readonly<{
	readonly notNull?: boolean;
	readonly primaryKey?: boolean;
	readonly isUnique?: boolean;
	readonly columnType?: string;
	readonly dataType?: string;
	readonly enumValues?: ReadonlyArray<string>;
	readonly generated?: { readonly as?: unknown };
	/** Set by `.array()`, which mutates the builder in place rather than wrapping it. */
	readonly dimensions?: number;
	/** Written by `custom()` so the declared type name survives into the field description. */
	readonly boltCustomType?: string;
	/** The same second argument authored on `custom(name, options)`. */
	readonly boltCustomTypeOptions?: Readonly<Record<string, Schema.Json>>;
	readonly boltInstantPrecision?: 'day' | 'minute';
	readonly boltRangePrecision?: 'day' | 'minute';
	/** Written by the column builders so `text({ search: true })` survives into the description. */
	readonly boltSearch?: boolean;
	/** Written by `file()` so the declared accept list survives into the description. */
	readonly boltMimeTypes?: ReadonlyArray<string>;
	/**
	 * Whether this `jsonb` column is a `file()`, and whether it holds a list of them.
	 *
	 * `file()` emits `jsonb` now, so the builder's own name no longer says what it is — every
	 * `file()` column would otherwise describe itself as ordinary JSON, and the renderer would draw a
	 * code block where an upload belongs. The flag is what keeps the catalog's `kind` honest.
	 */
	readonly boltFile?: boolean;
	readonly boltFileMultiple?: boolean;
}>;

const dialect = new PgDialect();

/** Reads a builder's configuration without depending on Drizzle's private field names at the call site. */
const configOf = (builder: unknown): ColumnConfig | undefined => {
	if (builder === null || typeof builder !== 'object') return undefined;
	const config = Reflect.get(builder, 'config');
	return config === null || typeof config !== 'object' ? undefined : (config as ColumnConfig);
};

/**
 * Renders a generated column's expression as inline SQL. A generated expression cannot carry bind
 * parameters, so a declaration that produced any is rejected rather than silently truncated.
 */
const generatedExpression = (config: ColumnConfig): string | undefined => {
	const as = config.generated?.as;
	if (as === undefined) return undefined;
	if (typeof as === 'string') return as;
	if (typeof as === 'function')
		return generatedExpression({ generated: { as: (as as () => unknown)() } });
	const query = dialect.sqlToQuery(as as Parameters<PgDialect['sqlToQuery']>[0]);
	if (query.params.length > 0) {
		throw new Error(`A generated column expression cannot bind parameters: ${query.sql}`);
	}
	return query.sql;
};

/** The scalar kind a column presents to queries, access masking, and the client catalog. */
const scalarOf = (config: ColumnConfig): ScalarType => {
	// `.array()` mutates the builder and records only `dimensions`, so `uuid().array()` still reports
	// `columnType: 'PgUUID'`. An array is not the scalar it holds — planning
	// `statutory_contributions.relief_for` as `uuid` would refuse the JSON list the runtime writes
	// there — so a dimensioned column keeps the `string` answer every array has always had here.
	if (typeof config.dimensions === 'number') return 'string';
	const byColumnType =
		config.columnType === undefined ? undefined : SCALAR_BY_COLUMN_TYPE[config.columnType];
	if (byColumnType !== undefined) return byColumnType;
	const dataType = config.dataType ?? '';
	if (dataType.startsWith('number')) return 'number';
	if (dataType.startsWith('boolean')) return 'boolean';
	if (dataType.startsWith('json') || dataType.startsWith('object')) return 'json';
	if (dataType.includes('date') || dataType.includes('timestamp')) return 'instant';
	return 'string';
};

/**
 * A column's DEFAULT as the SQL literal the DDL carries, or `undefined` when it declares none.
 *
 * Rendered through Drizzle rather than by a `switch` on the value's type, for the reason
 * `declaredColumnSql` explains: a second renderer of the same declaration is how the plan and the
 * lineage came to create the same column two different ways. `sql.param` applies the column's own
 * encoder and `inlineParams()` makes the dialect emit the value as a literal with its own quoting,
 * so `'MANUAL'`, `0` and `true` come out exactly as drizzle-kit writes them into `migration.sql`.
 *
 * A `sql` default — `defaultNow()`, `defaultRandom()`, an authored expression — is already SQL and is
 * rendered straight. A `$defaultFn` leaves `default` undefined and correctly produces nothing: it is
 * a value the runtime supplies per row, not a database default.
 */
const declaredDefault = (column: AnyPgColumn): string | undefined => {
	const value: unknown = column.default;
	if (value === undefined) return undefined;
	if (is(value, SQL)) return dialect.sqlToQuery(value).sql;
	// Drizzle's inline renderer stringifies an object it cannot recognise with `toString()`, which is
	// right for a plain object (it falls through to `JSON.stringify`) and silently wrong for a `Date`
	// or an array — `new Date()` would reach the DDL as `'Mon Aug 17 2026 …'`. Refusing here names the
	// column and the fix; letting it through would plant the next plan-versus-lineage divergence.
	if (typeof value === 'object' && value !== null && String(value) !== '[object Object]') {
		throw new TypeError(
			`Column default ${String(value)} cannot be rendered as SQL. Declare it as a sql\`…\` expression instead.`
		);
	}
	return dialect.sqlToQuery(sql`${sql.param(value, column)}`.inlineParams()).sql;
};

/**
 * The DDL half of each column — its PostgreSQL type and its DEFAULT — read off the built columns.
 *
 * Built rather than mapped from `columnType`, because a second table of "which SQL type is this
 * builder" is exactly how the schema plan and the migration lineage came to create the same column
 * as `double precision` and `numeric`. `getSQLType()` is the function drizzle-kit renders the
 * lineage's DDL through, so reading it here makes the two sides one answer rather than two that
 * agree until someone edits one of them. It also picks up what a map keyed on the builder name
 * cannot: `numeric({ precision, scale })` and an instant builder's time-zone mode are
 * configuration, not distinct builders.
 *
 * The DEFAULT rides along here rather than in its own pass because it is the same question about the
 * same built column, and it was missing for the same reason the type was wrong: the plan re-derived
 * what it could see and had no place for what it could not. `roster_entries.origin` reached the
 * database as `not null` with no default, so every insert that let the default supply the value
 * failed.
 *
 * A dimensioned column is deliberately omitted from both. `.array()` records only `dimensions`, and
 * the array columns are the JSON lists the runtime writes — the same reason `scalarOf` answers
 * `string` for them below. Reporting `uuid` here would plan `statutory_contributions.relief_for` as
 * a scalar uuid and refuse every value written to it.
 */
const declaredColumnSql = (
	columns: Readonly<Record<string, AnyPgColumnBuilder>>
): ReadonlyMap<string, Pick<FieldDefinition, 'sqlType' | 'sqlDefault'>> => {
	const declared = new Map<string, Pick<FieldDefinition, 'sqlType' | 'sqlDefault'>>();
	// Only the binding is guarded. A builder that cannot be bound to a table is not a reason to lose
	// every other column's type — the scalar mapping in `buildSchemaPlan` still answers, exactly as it
	// did before this existed — but a default this cannot render is a divergence, and swallowing that
	// here would trade a named error for the silent mismatch this function exists to prevent.
	// The module is deliberately synchronous API (its callers read it in plain passes), so the Effect
	// pipeline is adapted once at this edge.
	const built = Effect.runSync(
		// repository-health:allow DDL1 -- this module IS the model compiler; `pgTable` is what a
		// `defineModel` declaration compiles into, so "prefer defineModel" is circular here.
		Effect.try(() => getColumns(pgTable('bolt_column_types', columns))).pipe(
			Effect.catch(() => Effect.succeed<Readonly<Record<string, AnyPgColumn>>>({}))
		)
	) as Readonly<Record<string, AnyPgColumn>>;
	for (const [name, column] of Object.entries(built)) {
		if (typeof configOf(columns[name])?.dimensions === 'number') continue;
		const sqlDefault = declaredDefault(column);
		declared.set(name, {
			sqlType: column.getSQLType(),
			...(sqlDefault === undefined ? {} : { sqlDefault })
		});
	}
	return declared;
};

/** Describes one authored model's columns as the field definitions the runtime and schema plan consume. */
export const describeModelColumns = (
	columns: Readonly<Record<string, AnyModelFieldBuilder>> | undefined
): Readonly<Record<string, FieldDefinition>> => {
	if (columns === undefined) return {};
	const physicalColumns = Object.fromEntries(
		Object.entries(columns).filter(
			(entry): entry is [string, AnyPgColumnBuilder] => !isReferenceBuilder(entry[1])
		)
	);
	const columnSql = declaredColumnSql(physicalColumns);
	const fields: Record<string, FieldDefinition> = {};
	for (const [name, builder] of Object.entries(columns)) {
		if (isReferenceBuilder(builder)) {
			fields[name] = {
				type: 'reference',
				required: builder.config.notNull,
				indexed: true,
				...(builder.config.isUnique ? { unique: true } : {}),
				reference: {
					targets: Object.entries(builder.targets).map(([tag, collection]) => ({
						tag,
						collection,
						storageColumn: referenceStorageColumn(name, tag)
					})),
					onDelete: builder.config.onDelete
				}
			};
			continue;
		}
		const config = configOf(builder);
		if (config === undefined) continue;
		const { sqlType, sqlDefault } = columnSql.get(name) ?? {};
		const generated = generatedExpression(config);
		const precision = config.boltInstantPrecision ?? config.boltRangePrecision;
		fields[name] = {
			type: scalarOf(config),
			// A generated column is never written, so `not null` on it is a constraint the runtime
			// cannot satisfy and the database computes anyway.
			required: generated === undefined && config.notNull === true,
			indexed: config.primaryKey === true || config.isUnique === true,
			...(config.primaryKey === true ? { primaryKey: true } : {}),
			...(config.isUnique === true ? { unique: true } : {}),
			...(sqlType === undefined ? {} : { sqlType }),
			// Skipped on a generated column for the same reason `required` is: Postgres refuses a column
			// that is both computed and defaulted, and Drizzle cannot express one either.
			...(generated !== undefined || sqlDefault === undefined ? {} : { sqlDefault }),
			...(generated === undefined ? {} : { generated }),
			...(config.enumValues === undefined || config.enumValues.length === 0
				? {}
				: { values: [...config.enumValues] }),
			...(typeof config.boltCustomType === 'string' ? { customType: config.boltCustomType } : {}),
			...(config.boltCustomTypeOptions === undefined
				? {}
				: { customTypeOptions: config.boltCustomTypeOptions }),
			...(precision === undefined ? {} : { precision }),
			...(config.boltSearch === true ? { search: true } : {}),
			...(config.boltMimeTypes === undefined || config.boltMimeTypes.length === 0
				? {}
				: { mimeTypes: [...config.boltMimeTypes] }),
			...(config.boltFile === true ? { file: true } : {}),
			...(config.boltFileMultiple === true ? { fileMultiple: true } : {})
		};
	}
	return fields;
};

/**
 * The columns a collection opted into free-text search, sorted.
 *
 * One reader, because the trigram index and the `ilike` search have to cover exactly the same
 * columns: an index over a column search never reads is dead weight, and a column search reads
 * without one is the sequential scan #44 is about. The opt-in itself is decided once — `boltSearch`
 * is written only by `text()`, `phone()` and `enums()`, and `describeModelColumns` above is the only
 * thing that reads it — so every consumer here is agreeing with that decision rather than restating
 * it. `isSearchableCollectionField` in `@norbital-ai/std/collection` is the same rule stated over the
 * *client catalog* field, where a `kind` exists to weigh; `tests/authoring/searchable-fields.test.ts`
 * pins the two to the same answer so the DDL and the search UI cannot drift apart.
 */
export const searchableColumns = (
	fields: Readonly<Record<string, FieldDefinition>>
): ReadonlyArray<string> =>
	Object.entries(fields)
		.filter(([, field]) => field.search === true)
		.map(([name]) => name)
		.toSorted();

/** Describes a whole `defineModel` declaration, tolerating a module that failed to export one. */
export const describeModel = (
	declaration: ModelDeclaration | undefined
): Readonly<Record<string, FieldDefinition>> => describeModelColumns(declaration?.columns);

type ModelCollectionOptions = Readonly<{
	readonly hooks?: ReadonlyArray<string>;
	readonly sourcePath?: string;
}>;

const assertNoSystemColumnOverrides = (declaration: ModelDeclaration | undefined): void => {
	if (declaration === undefined) return;
	const system = defineSystemRowModel().columns;
	const collisions = Object.keys(declaration.columns)
		.filter((name) => name in system)
		.toSorted();
	if (collisions.length > 0)
		throw new TypeError(`A model cannot redeclare platform columns: ${collisions.join(', ')}`);
};

/**
 * The single column of a plain index — one string column and nothing declared.
 *
 * A model may declare an index with `unique`, `where`, `method`, `opclass` or expression members;
 * only the bare form can be folded into the column's own `indexed` flag, which is what this
 * separates from indexes that have to keep travelling as their own entity.
 */
const simpleIndexColumn = (index: ModelIndex): string | undefined => {
	if (index.columns.length !== 1) return undefined;
	const [column] = index.columns;
	return typeof column === 'string' &&
		index.name === undefined &&
		index.unique === undefined &&
		index.where === undefined &&
		index.method === undefined &&
		index.opclass === undefined
		? column
		: undefined;
};

/**
 * Compiles one `defineModel` through the collection path shared by tenant and platform models.
 *
 * The serialized workspace entry contributes only facts that come from its owning file name or
 * compiler discovery. Fields and model metadata always come from the declaration itself, so a
 * runtime-owned model cannot grow a parallel description of the same table.
 */
export const compileModel = (
	base: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
	declaration: ModelDeclaration | undefined,
	options: ModelCollectionOptions = {}
): CollectionDefinition<Readonly<Record<string, FieldDefinition>>> => {
	assertNoSystemColumnOverrides(declaration);
	const metadata = declaration?.metadata;
	const indexes = metadata?.indexes ?? [];
	const simpleIndexes = new Set(
		indexes.flatMap((index) => {
			const column = simpleIndexColumn(index);
			return column === undefined ? [] : [column];
		})
	);
	const described = Object.fromEntries(
		Object.entries(describeModel(declaration)).map(([name, field]) => [
			name,
			simpleIndexes.has(name) ? { ...field, indexed: true } : field
		])
	);
	const structuredIndexes = indexes.filter((index) => simpleIndexColumn(index) === undefined);
	const hooks = options.hooks ?? [];
	const exclusions = metadata?.exclusions ?? [];
	return {
		...base,
		...(Object.keys(described).length === 0 ? {} : { fields: described }),
		...(hooks.length === 0 ? {} : { hooks }),
		...(exclusions.length === 0 ? {} : { exclusions }),
		...(structuredIndexes.length === 0 ? {} : { indexes: structuredIndexes }),
		...(metadata?.sync === undefined ? {} : { sync: metadata.sync }),
		...(metadata?.history === undefined ? {} : { history: metadata.history }),
		...(metadata?.description === undefined ? {} : { description: metadata.description }),
		...(metadata?.icon === undefined ? {} : { icon: metadata.icon }),
		...(options.sourcePath === undefined ? {} : { sourcePath: options.sourcePath })
	};
};

/** Extra constraints the workspace compiler adds after the model has supplied its own columns. */
type UnionToIntersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (
	value: infer Intersection
) => void
	? Intersection
	: never;
type AuthoredPhysicalColumns<TColumns extends Readonly<Record<string, AnyModelFieldBuilder>>> = {
	readonly [K in keyof TColumns as TColumns[K] extends AnyPgColumnBuilder ? K : never]: Extract<
		TColumns[K],
		AnyPgColumnBuilder
	>;
} & UnionToIntersection<
	{
		[K in keyof TColumns]: TColumns[K] extends ReferenceBuilder<infer Targets>
			? {
					readonly [
						Tag in keyof Targets & string as `${K & string}__${Lowercase<Tag>}_id`
					]: ReturnType<typeof uuid>;
				}
			: Record<never, never>;
	}[keyof TColumns]
>;

type ModelTableConfiguration<TColumns extends Readonly<Record<string, AnyModelFieldBuilder>>> = (
	columns: PgBuildExtraConfigColumns<SystemRowColumns & AuthoredPhysicalColumns<TColumns>>
) => Array<PgTableExtraConfigValue>;

type CompiledModelTable<
	TName extends string,
	TColumns extends Readonly<Record<string, AnyModelFieldBuilder>>
> = PgTableWithColumns<{
	name: TName;
	schema: undefined;
	columns: PgBuildColumns<TName, SystemRowColumns & AuthoredPhysicalColumns<TColumns>>;
	dialect: 'pg';
}>;

/**
 * Compiles one `defineModel` into the Drizzle table used by migrations and database integrations.
 *
 * The model remains the source of truth. The table name comes from discovery, platform columns
 * come from the collection runtime, and callers may add relationship constraints without
 * redeclaring either. Better Auth and tenant migrations both consume this exact operation.
 */
export const compileModelTable = <
	const TName extends string,
	const TColumns extends Readonly<Record<string, AnyModelFieldBuilder>>
>(
	name: TName,
	declaration: ModelDeclaration<TColumns>,
	configure?: ModelTableConfiguration<TColumns>
) => {
	assertNoSystemColumnOverrides(declaration);
	const authoredColumns: Record<string, AnyPgColumnBuilder> = {};
	for (const [fieldName, builder] of Object.entries(declaration.columns)) {
		if (!isReferenceBuilder(builder)) {
			authoredColumns[fieldName] = builder;
			continue;
		}
		for (const tag of Object.keys(builder.targets)) {
			const storageColumn = referenceStorageColumn(fieldName, tag);
			if (Object.hasOwn(declaration.columns, storageColumn) ||
				Object.hasOwn(authoredColumns, storageColumn))
				throw new TypeError(
					`Reference field ${fieldName} generates column ${storageColumn}, but that column is already declared.`
				);
			authoredColumns[storageColumn] = uuid();
		}
	}
	const columns = {
		...defineSystemRowModel().columns,
		...authoredColumns
	} as SystemRowColumns &
		AuthoredPhysicalColumns<TColumns> &
		Readonly<Record<string, AnyPgColumnBuilder>>;
	// The runtime loop above performs the type-level `AuthoredPhysicalColumns` transform. Drizzle's
	// overloaded factory cannot infer a key-remapped generic intersection from that loop, so the cast
	// is kept at this one compiler boundary and callers still receive the exact physical table.
	// repository-health:allow DDL1 -- this is `compileModelTable` itself emitting its output
	// primitive; the rule describes callers of the compiler, not the compiler.
	return pgTable(
		name,
		columns as Readonly<Record<string, AnyPgColumnBuilder>>,
		configure as never
	) as CompiledModelTable<TName, TColumns>;
};

type CompiledModelTables<TModels extends Readonly<Record<string, ModelDeclaration>>> = {
	readonly [TName in keyof TModels]: TModels[TName] extends ModelDeclaration<infer TColumns>
		? CompiledModelTable<TName & string, TColumns>
		: never;
};

/** Compiles a heterogeneous model registry without widening every table to the registry's union. */
export const compileModelTables = <
	const TModels extends Readonly<Record<string, ModelDeclaration>>
>(
	models: TModels
): CompiledModelTables<TModels> =>
	EffectRecord.map(models, (declaration, name) =>
		compileModelTable(name, declaration)
	) as CompiledModelTables<TModels>;

/**
 * The operation/phase pairs an authored `+hooks.ts` actually declares.
 *
 * The Studio reports a hook count per collection, and counting files would say "1" for a module
 * declaring five handlers. The declaration is an ordinary object — `{ create: { before: { handler } } }`
 * — so the leaves are countable directly.
 */
export const describeHooks = (declaration: unknown): ReadonlyArray<string> => {
	if (declaration === null || typeof declaration !== 'object') return [];
	const named: Array<string> = [];
	for (const [operation, phases] of Object.entries(declaration)) {
		if (phases === null || typeof phases !== 'object') continue;
		for (const [phase, hook] of Object.entries(phases)) {
			if (hook === null || typeof hook !== 'object') continue;
			if (typeof Reflect.get(hook, 'handler') === 'function') named.push(`${operation}.${phase}`);
		}
	}
	return named.toSorted();
};
