// repository-health:allow SEM_PARALLEL -- model-introspection imports the model declarations it
// describes (./models-schema.js), so the pair is linked, not parallel.
import { SQL, getColumns, is, sql } from 'drizzle-orm';
import {
	PgDialect,
	customType,
	pgTable,
	text,
	timestamp,
	uuid,
	type AnyPgColumn,
	type AnyPgColumnBuilder,
	type PgBuildColumns,
	type PgBuildExtraConfigColumns,
	type PgTableExtraConfigValue,
	type PgTableWithColumns
} from 'drizzle-orm/pg-core';
import { Predicate, Record as EffectRecord, Schema } from 'effect';
import { isNumber, isObjectLike, isRecord, isString, isStringArray } from '../schema-decode.js';
import { collection } from './workspace-schema.js';
import type { CollectionInputSelection } from './collection-schema.js';
import type {
	CollectionCatalogEntry,
	CollectionDefinition,
	CompiledAuthoring,
	CompiledCollection,
	CompiledCollectionWrite,
	CompiledFieldDefinition,
	CompiledTenantCapabilities,
	FieldDefinition,
	FieldPresentationKind,
	RelationDefinition,
	ScalarType
} from './workspace-schema.js';
import {
	isReferenceBuilder,
	platformCustomTypes,
	relationshipCascades,
	relationshipSetsNull,
	relationshipDeferrables,
	referenceStorageColumn,
	vector,
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
	readonly boltPresentationKind?: string;
}>;

const dialect = new PgDialect();

/** Reads a builder's configuration without depending on Drizzle's private field names at the call site. */
const configOf = (builder: unknown): ColumnConfig | undefined => {
	if (!isRecord(builder)) return undefined;
	const config = Reflect.get(builder, 'config');
	return isRecord(config) ? (config as ColumnConfig) : undefined;
};

/**
 * Renders a generated column's expression as inline SQL. A generated expression cannot carry bind
 * parameters, so a declaration that produced any is rejected rather than silently truncated.
 */
const generatedExpression = (config: ColumnConfig): string | undefined => {
	const as = config.generated?.as;
	if (as === undefined) return undefined;
	if (isString(as)) return as;
	if (Predicate.isFunction(as))
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
	if (isNumber(config.dimensions) && config.dimensions > 0) return 'string';
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

const PRESENTATION_BY_COLUMN_TYPE: Readonly<Record<string, FieldPresentationKind>> = {
	PgText: 'text',
	PgVarchar: 'text',
	PgChar: 'text',
	PgUUID: 'uuid',
	PgDateString: 'text',
	PgDate: 'instant',
	PgTimestamp: 'instant',
	PgTimestampString: 'instant',
	PgNumeric: 'numeric',
	PgNumericNumber: 'numeric',
	PgInteger: 'integer',
	PgBigInt53: 'integer',
	PgDoublePrecision: 'numeric',
	PgReal: 'numeric',
	PgBoolean: 'boolean',
	PgJsonb: 'json',
	PgJson: 'json',
	PgVector: 'json'
};

const presentationOf = (config: ColumnConfig): FieldPresentationKind =>
	config.boltPresentationKind ??
	(config.columnType === undefined ? undefined : PRESENTATION_BY_COLUMN_TYPE[config.columnType]) ??
	'text';

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
	if (isObjectLike(value) && String(value) !== '[object Object]') {
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
 * scalar DDL through, while the built column's numeric `dimensions` is the executed declaration of
 * its array suffix. Reading both here makes the two sides one answer rather than two that agree
 * until someone edits one of them. It also picks up what a map keyed on the builder name cannot:
 * `numeric({ precision, scale })` and an instant builder's time-zone mode are configuration, not
 * distinct builders.
 *
 * The DEFAULT rides along here rather than in its own pass because it is the same question about the
 * same built column, and it was missing for the same reason the type was wrong: the plan re-derived
 * what it could see and had no place for what it could not. `roster_entries.origin` reached the
 * database as `not null` with no default, so every insert that let the default supply the value
 * failed.
 *
 * Arrays retain their exact PostgreSQL type here; their runtime scalar classification remains the
 * write-contract concern handled by `scalarOf`.
 */
const declaredColumnSql = (
	columns: Readonly<Record<string, AnyPgColumnBuilder>>
): ReadonlyMap<string, Pick<FieldDefinition, 'sqlType' | 'sqlDefault'>> => {
	const declared = new Map<string, Pick<FieldDefinition, 'sqlType' | 'sqlDefault'>>();
	// A builder that cannot be bound to a table is a divergence, and swallowing it here would trade
	// a named error for the silent mismatch this function exists to prevent: an empty map erases
	// every column's SQL type, and the schema plan and migration lineage would then read a schema
	// the author did not write.
	// repository-health:allow DDL1 -- this module IS the model compiler; `pgTable` is what a
	// `defineModel` declaration compiles into, so "prefer defineModel" is circular here.
	const built = getColumns(pgTable('bolt_column_types', columns)) as Readonly<
		Record<string, AnyPgColumn>
	>;
	for (const [name, column] of Object.entries(built)) {
		const sqlDefault = declaredDefault(column);
		const declaredType = column.getSQLType();
		const dimensions = Math.max(
			isNumber(column.dimensions) ? column.dimensions : 0,
			configOf(columns[name])?.dimensions ?? 0
		);
		const sqlType = declaredType.endsWith('[]')
			? declaredType
			: `${declaredType}${'[]'.repeat(Math.max(0, dimensions))}`;
		declared.set(name, {
			sqlType,
			...(sqlDefault === undefined ? {} : { sqlDefault })
		});
	}
	return declared;
};

/** Describes one authored model's columns as the field definitions the runtime and schema plan consume. */
export const describeModelColumns = (
	columns: Readonly<Record<string, AnyModelFieldBuilder>> | undefined
): Readonly<Record<string, CompiledFieldDefinition>> => {
	if (columns === undefined) return {};
	const physicalColumns = Object.fromEntries(
		Object.entries(columns).filter(
			(entry): entry is [string, AnyPgColumnBuilder] => !isReferenceBuilder(entry[1])
		)
	);
	const columnSql = declaredColumnSql(physicalColumns);
	const fields: Record<string, CompiledFieldDefinition> = {};
	for (const [name, builder] of Object.entries(columns)) {
		if (isReferenceBuilder(builder)) {
			fields[name] = {
				type: 'reference',
				presentationKind: 'reference',
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
			presentationKind: presentationOf(config),
			...((isNumber(config.dimensions) && config.dimensions > 0) || sqlType?.includes('[]') === true
				? { array: true }
				: {}),
			...(config.notNull === true ? { databaseNotNull: true } : {}),
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
			...(isString(config.boltCustomType) ? { customType: config.boltCustomType } : {}),
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
 * One reader, because the generated tsvector, trigram expression, and ranking have to cover exactly
 * the same columns: an index over a field search never reads is dead weight, and a searched field
 * absent from the document is a sequential scan or a false negative. The opt-in is decided once —
 * `boltSearch` is written only by `text()`, `phone()` and `enums()`, and `describeModelColumns` is the only
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

/** Platform column containing the immutable, generated lexical document. */
export const SEARCH_DOCUMENT_COLUMN = 'search_document';

/** The PostgreSQL text expression shared by generated DDL, trigram matching, and ranking. */
export const searchTextExpression = (columns: ReadonlyArray<string>): string =>
	columns.map((column) => `coalesce("${column.replaceAll('"', '""')}", '')`).join(" || ' ' || ");

/**
 * The stored document expression. The explicit regconfig selects PostgreSQL's immutable overload.
 *
 * PostgreSQL does not allow one generated column to reference another. A searchable authored field
 * may itself be generated, so the document has to inline that field's owning expression rather than
 * name the generated column. Ordinary fields keep the exact expression used by runtime ranking and
 * the trigram index.
 */
export const searchDocumentExpression = (
	columns: ReadonlyArray<string>,
	fields: Readonly<Record<string, FieldDefinition>>
): string => {
	const text = columns
		.map((column) => {
			const generated = fields[column]?.generated;
			return generated === undefined
				? `coalesce("${column.replaceAll('"', '""')}", '')`
				: `coalesce((${generated}), '')`;
		})
		.join(" || ' ' || ");
	return `to_tsvector('simple'::regconfig, ${text})`;
};

/** Describes a whole `defineModel` declaration, tolerating a module that failed to export one. */
export const describeModel = (
	declaration: ModelDeclaration | undefined
): Readonly<Record<string, CompiledFieldDefinition>> => describeModelColumns(declaration?.columns);

type ModelCollectionOptions = Readonly<{
	readonly sourcePath?: string;
}>;

const assertNoSystemColumnOverrides = (declaration: ModelDeclaration | undefined): void => {
	if (declaration === undefined) return;
	const reserved = new Set([
		...Object.keys(defineSystemRowModel().columns),
		SEARCH_DOCUMENT_COLUMN,
		RECORD_EMBEDDING_COLUMN,
		EMBEDDED_AT_COLUMN,
		RECORD_EMBEDDING_FINGERPRINT_COLUMN
	]);
	const collisions = Object.keys(declaration.columns)
		.filter((name) => reserved.has(name))
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
	return isString(column) &&
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
	base: CollectionDefinition<Readonly<Record<string, CompiledFieldDefinition>>>,
	declaration: ModelDeclaration | undefined,
	options: ModelCollectionOptions = {}
): CollectionDefinition<Readonly<Record<string, CompiledFieldDefinition>>> => {
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
	const exclusions = metadata?.exclusions ?? [];
	const lexicalFields = searchableColumns(described);
	const authoredLabel = metadata?.recordLabel;
	const recordLabel = isString(authoredLabel) ? authoredLabel : authoredLabel?.join(" + ' · ' + ");
	return {
		...base,
		...(Object.keys(described).length === 0 ? {} : { fields: described }),
		...(exclusions.length === 0 ? {} : { exclusions }),
		...(structuredIndexes.length === 0 ? {} : { indexes: structuredIndexes }),
		...(metadata?.history === undefined ? {} : { history: metadata.history }),
		...(recordLabel === undefined ? {} : { recordLabel }),
		...(metadata?.description === undefined ? {} : { description: metadata.description }),
		...(metadata?.icon === undefined ? {} : { icon: metadata.icon }),
		...(lexicalFields.length === 0
			? {}
			: {
					search: {
						fields: lexicalFields,
						documentColumn: SEARCH_DOCUMENT_COLUMN,
						configuration: 'simple',
						ranking: { lexical: 'ts_rank_cd', fuzzy: 'similarity' }
					}
				}),
		...(metadata?.embedding === undefined
			? {}
			: {
					embedding: {
						...metadata.embedding,
						vectorColumn: RECORD_EMBEDDING_COLUMN,
						embeddedAtColumn: EMBEDDED_AT_COLUMN,
						sourceFingerprintColumn: RECORD_EMBEDDING_FINGERPRINT_COLUMN
					}
				}),
		...(options.sourcePath === undefined ? {} : { sourcePath: options.sourcePath })
	};
};

const relationshipValue = Symbol('@norbital-ai/bolt/compiled-relationship');
const relationshipEndpoint = Symbol('@norbital-ai/bolt/relationship-endpoint');

const immutable = <T>(value: T): T => {
	if (isObjectLike(value) && !Object.isFrozen(value)) {
		for (const child of Object.values(value as Record<string, unknown>)) immutable(child);
		Object.freeze(value);
	}
	return value;
};

type EndpointValue = Readonly<{ readonly collection: string; readonly column: string }>;
type RelationshipValue = Pick<RelationDefinition, 'target' | 'cardinality' | 'from' | 'to'>;

const reflectedValue = <Value>(value: unknown, key: symbol): Value | undefined =>
	isRecord(value) ? (Reflect.get(value, key) as Value | undefined) : undefined;
const endpointOf = (value: unknown) => reflectedValue<EndpointValue>(value, relationshipEndpoint);
const relationshipOf = (value: unknown) =>
	reflectedValue<RelationshipValue>(value, relationshipValue);

const endpointCollection = (collection: string): object =>
	new Proxy(
		{},
		{
			get: (_target, column) =>
				isString(column)
					? Object.freeze({ [relationshipEndpoint]: { collection, column } })
					: undefined
		}
	);

const relationFactories = (cardinality: 'one' | 'many'): object =>
	new Proxy(
		{},
		{
			get: (_target, target) => {
				if (!isString(target)) return undefined;
				return (input?: Readonly<Record<string, unknown>>) => {
					const hasEndpoints =
						input !== undefined && (Object.hasOwn(input, 'from') || Object.hasOwn(input, 'to'));
					const from = endpointOf(input?.['from']);
					const to = endpointOf(input?.['to']);
					if (hasEndpoints && (from === undefined || to === undefined))
						throw new TypeError(
							`Relationship to ${target} must declare both from and to endpoints.`
						);
					const endpoints = from === undefined || to === undefined ? {} : { from, to };
					const value = {};
					Reflect.defineProperty(value, relationshipValue, {
						value: { target, cardinality, ...endpoints }
					});
					return value;
				};
			}
		}
	);

const relationshipHelpers = new Proxy(
	{},
	{
		get: (_target, property) => {
			if (property === 'one' || property === 'many') return relationFactories(property);
			return isString(property) ? endpointCollection(property) : undefined;
		}
	}
);

const orderedRelationshipEndpoints = (
	relation: Pick<RelationDefinition, 'name' | 'source' | 'target'>,
	from: EndpointValue,
	to: EndpointValue
): Readonly<{ readonly from: EndpointValue; readonly to: EndpointValue }> => {
	if (from.collection === relation.source && to.collection === relation.target) return { from, to };
	if (to.collection === relation.source && from.collection === relation.target)
		return { from: to, to: from };
	throw new TypeError(
		`Relationship ${relation.source}.${relation.name} endpoints must connect source ${relation.source} to target ${relation.target}.`
	);
};

/** Executes one authored relationship declaration and resolves inverse ownership exactly once. */
const compileRelationships = (declaration: unknown): ReadonlyArray<RelationDefinition> => {
	if (declaration === undefined) return Object.freeze([]);
	if (!Predicate.isFunction(declaration))
		throw new TypeError('The relationship module must default-export a relationship function.');
	const output = declaration(relationshipHelpers) as unknown;
	if (!isRecord(output))
		throw new TypeError('The relationship declaration must return an object keyed by collection.');
	const relations: Array<RelationDefinition> = [];
	for (const [source, values] of Object.entries(output)) {
		if (!isRecord(values)) throw new TypeError(`Relationships for ${source} must be an object.`);
		for (const [name, value] of Object.entries(values)) {
			const described = relationshipOf(value);
			if (described === undefined)
				throw new TypeError(
					`Relationship ${source}.${name} was not created through r.one or r.many.`
				);
			relations.push({
				name,
				source,
				...described,
				...(relationshipCascades(value) ? { cascade: true } : {}),
				...(relationshipSetsNull(value) ? { setNull: true } : {}),
				...(relationshipDeferrables(value) ? { deferrable: true } : {})
			});
		}
	}
	return immutable(
		relations.map((relation) => {
			let { from, to } = relation;
			let cascade = relation.cascade === true;
			let setNull = relation.setNull === true;
			let deferred = relation.deferrable === true;
			if (from === undefined || to === undefined) {
				if (relation.cardinality === 'one')
					throw new TypeError(`Relationship ${relation.source}.${relation.name} has no endpoints.`);
				const inverse = relations.filter(
					(candidate) =>
						candidate.cardinality === 'one' &&
						candidate.source === relation.target &&
						candidate.target === relation.source &&
						candidate.from !== undefined &&
						candidate.to !== undefined
				);
				const [resolved] = inverse;
				if (resolved?.from === undefined || resolved.to === undefined || inverse.length !== 1)
					throw new TypeError(
						`Relationship ${relation.source}.${relation.name} has ${inverse.length === 0 ? 'no resolvable inverse' : 'ambiguous inverse endpoints'}.`
					);
				from = resolved.from;
				to = resolved.to;
				cascade ||= resolved.cascade === true;
				setNull ||= resolved.setNull === true;
				deferred ||= resolved.deferrable === true;
			}
			return {
				...relation,
				...(cascade ? { cascade: true } : {}),
				...(setNull ? { setNull: true } : {}),
				...(deferred ? { deferrable: true } : {}),
				...orderedRelationshipEndpoints(relation, from, to)
			};
		})
	);
};

type CompileWorkspaceAuthoringInput = Readonly<{
	readonly models: Readonly<Record<string, ModelDeclaration>>;
	readonly sourcePaths: Readonly<Record<string, string>>;
	readonly relationships?: unknown;
	readonly writes?: Readonly<Record<string, CompiledCollectionWrite | undefined>>;
	readonly capabilities?: CompiledTenantCapabilities;
	readonly customTypeNames?: ReadonlyArray<string>;
}>;

/**
 * The columns a `defineModel` physically declares: its builders' names, plus the nullable UUID
 * column each reference field generates per arm.
 *
 * A `+collection.ts` names the model it writes, so a declaration left behind by a model edit is a
 * write contract against columns that no longer exist. Comparing the two key sets here is what
 * refuses it at sync, naming both lists, instead of admitting a selection nothing can decode.
 */
const physicalModelColumns = (declaration: ModelDeclaration): ReadonlyArray<string> => {
	const columns = Object.entries(declaration.columns);
	const referenceColumns = columns.flatMap(([name, builder]) =>
		isReferenceBuilder(builder)
			? Object.keys(builder.targets).map((tag) => referenceStorageColumn(name, tag))
			: []
	);
	return [...columns.map(([name]) => name), ...referenceColumns].toSorted();
};

const columnKeys = (selection: unknown): ReadonlyArray<string> =>
	isRecord(selection) && isRecord(Reflect.get(selection, 'columns'))
		? Object.keys(Reflect.get(selection, 'columns') as Record<string, unknown>).toSorted()
		: [];

/** Refuses a declared write whose model is missing or whose selection names a column it lacks. */
const assertWritesMatchModels = (input: CompileWorkspaceAuthoringInput): void => {
	for (const [name, write] of Object.entries(input.writes ?? {})) {
		if (write === undefined) continue;
		const declaration = input.models[name];
		if (declaration === undefined)
			throw new TypeError(
				`Collection ${name} declares src/collections/${name}/+collection.ts but no src/collections/${name}/+model.ts.`
			);
		const modelColumns = physicalModelColumns(declaration);
		for (const operation of ['create', 'update'] as const) {
			const missing = columnKeys(write[operation]).filter(
				(column) => !modelColumns.includes(column)
			);
			if (missing.length > 0)
				throw new TypeError(
					`Collection ${name}.${operation}.input.columns names ${missing.join(', ')}, which +model.ts does not declare (its columns are ${modelColumns.join(', ') || '(none)'}).`
				);
		}
	}
};

/** Produces the sole canonicalizable semantic value used by compiler consumers. */
export const compileWorkspaceAuthoring = (
	input: CompileWorkspaceAuthoringInput
): CompiledAuthoring => {
	assertWritesMatchModels(input);
	const collections = Object.keys(input.models)
		.toSorted()
		.map((name): CompiledCollection => {
			const declaration = input.models[name];
			const sourcePath = input.sourcePaths[name];
			if (declaration === undefined || sourcePath === undefined)
				throw new TypeError(`Collection ${name} is missing its declaration or source path.`);
			const write = input.writes?.[name];
			const compiled = compileModel(collection({ name, fields: {} }), declaration, {
				sourcePath
			});
			return {
				...compiled,
				sourcePath,
				fields: { ...compiled.fields },
				...(write === undefined ? {} : { write })
			};
		});
	const relationships = compileRelationships(input.relationships);
	const known = new Map(
		collections.map((entry) => [entry.name, new Set(Object.keys(entry.fields))])
	);
	for (const collection of collections) {
		const physical = new Set(
			Object.entries(collection.fields).flatMap(([name, field]) =>
				field.reference === undefined ? [name] : []
			)
		);
		for (const [name, field] of Object.entries(collection.fields)) {
			for (const target of field.reference?.targets ?? []) {
				if (physical.has(target.storageColumn))
					throw new TypeError(
						`Reference field ${collection.name}.${name} generates duplicate physical column ${target.storageColumn}.`
					);
				physical.add(target.storageColumn);
			}
		}
	}
	for (const relation of relationships) {
		if (!known.has(relation.source))
			throw new TypeError(`Relationship ${relation.name} has unknown source ${relation.source}.`);
		if (!known.has(relation.target) && relation.target !== 'user')
			throw new TypeError(`Relationship ${relation.name} has unknown target ${relation.target}.`);
		for (const endpoint of [relation.from, relation.to]) {
			if (endpoint === undefined) continue;
			if (endpoint.collection !== relation.source && endpoint.collection !== relation.target)
				throw new TypeError(
					`Relationship ${relation.name} has endpoint outside ${relation.source} and ${relation.target}.`
				);
			const fields = known.get(endpoint.collection);
			if (fields === undefined && endpoint.collection !== 'user')
				throw new TypeError(
					`Relationship ${relation.name} names unknown collection ${endpoint.collection}.`
				);
			if (endpoint.column !== 'id' && fields?.has(endpoint.column) !== true)
				throw new TypeError(
					`Relationship ${relation.name} names unknown column ${endpoint.collection}.${endpoint.column}.`
				);
		}
	}
	const customTypeReferences = collections.flatMap((entry) =>
		Object.entries(entry.fields).flatMap(([field, definition]) =>
			definition.customType === undefined
				? []
				: [{ collection: entry.name, field, name: definition.customType }]
		)
	);
	const customTypeNames = new Set(Object.keys(platformCustomTypes));
	for (const name of input.customTypeNames ?? []) customTypeNames.add(name);
	const customTypeProblems = customTypeReferences.filter(
		(reference) => !customTypeNames.has(reference.name)
	);
	if (customTypeProblems.length > 0)
		throw new TypeError(
			`Workspace models reference undeclared custom types:\n  - ${customTypeProblems
				.map(
					(reference) =>
						`${collections.find(({ name }) => name === reference.collection)?.sourcePath ?? reference.collection}:${reference.field} references undeclared datatype ${JSON.stringify(reference.name)}`
				)
				.join('\n  - ')}`
		);
	const capabilities = input.capabilities ?? { skills: [], mcp: [] };
	return immutable({
		collections,
		relationships,
		customTypeReferences,
		capabilities: { skills: [...capabilities.skills], mcp: [...capabilities.mcp] }
	});
};

const stringOption = (
	options: Readonly<Record<string, Schema.Json>> | undefined,
	name: string
): ReadonlyArray<string> | undefined => {
	const value = options?.[name];
	return isStringArray(value) ? value : undefined;
};

/** Projects a compiled collection into the existing client catalog contract. */
export const collectionCatalogEntry = (
	collection: CollectionDefinition<Readonly<Record<string, CompiledFieldDefinition>>>,
	relationships: ReadonlyArray<RelationDefinition>
): CollectionCatalogEntry => ({
	name: collection.name,
	...(collection.recordLabel === undefined ? {} : { recordLabel: collection.recordLabel }),
	...(collection.write === undefined ? {} : { write: catalogWriteContract(collection.write) }),
	...(collection.embedding === undefined ? {} : { semantic: true }),
	...(collection.write?.similarity === undefined
		? {}
		: { similarity: collection.write.similarity }),
	fields: Object.entries(collection.fields).map(([name, field]) => {
		const relation = relationships.find(
			(candidate) =>
				candidate.source === collection.name &&
				candidate.from?.collection === collection.name &&
				candidate.from.column === name
		);
		const currencies =
			field.customType === 'money'
				? stringOption(field.customTypeOptions, 'allowedCurrencies')
				: undefined;
		return {
			name,
			kind: field.presentationKind,
			nullable: !field.required,
			...(field.generated === undefined ? {} : { readOnly: true }),
			...(field.search === true ? { search: true } : {}),
			...(field.array === true ||
			field.fileMultiple === true ||
			field.customTypeOptions?.['multiple'] === true
				? { array: true }
				: {}),
			...(field.values === undefined ? {} : { values: field.values }),
			...(currencies === undefined ? {} : { currencies }),
			...(field.precision === undefined ? {} : { precision: field.precision }),
			...(field.mimeTypes === undefined ? {} : { mimeTypes: field.mimeTypes }),
			...(relation === undefined
				? {}
				: {
						relation: {
							name: relation.name,
							target: relation.target,
							cardinality: relation.cardinality
						}
					})
		};
	}),
	relationships: relationships
		.filter((relation) => relation.source === collection.name)
		.map((relation) => ({
			name: relation.name,
			target: relation.target,
			cardinality: relation.cardinality,
			...(relation.cascade === true ? { cascade: true as const } : {}),
			...(relation.setNull === true ? { setNull: true as const } : {}),
			...(relation.deferrable === true ? { deferrable: true as const } : {})
		}))
});

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
/**
 * The column name a declared record embedding is maintained under.
 *
 * One name for every collection, like `id` or `created_at`, because it is a platform column rather
 * than an authored one: a reader asking "is this record semantically searchable" must not have to
 * know what the author called it.
 */
export const RECORD_EMBEDDING_COLUMN = 'record_embedding';
/** Settle timestamp for observable embedding staleness (`embedded_at < updated_at`). */
export const EMBEDDED_AT_COLUMN = 'embedded_at';
/** Idempotency key for one embedding source payload. */
export const RECORD_EMBEDDING_FINGERPRINT_COLUMN = 'record_embedding_fingerprint';

/**
 * The width used when a model declares an embedding without asking for one.
 *
 * A Postgres `vector` column is typed by its dimensionality, so unlike `dimensions` on the wire this
 * cannot be left to the provider — the table has to be created with a number. 256 is the Matryoshka
 * truncation the field-operations corpus is calibrated against and small enough that an HNSW index
 * over a large collection stays cheap.
 */
export const DEFAULT_RECORD_EMBEDDING_DIMENSIONS = 256;

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/** The physical generated lexical document, or nothing when no field opts into search. */
const searchDocumentColumn = (
	declaration: ModelDeclaration | undefined
): Readonly<Record<string, AnyPgColumnBuilder>> => {
	const fields = describeModel(declaration);
	const columns = searchableColumns(fields);
	if (columns.length === 0) return {};
	return {
		[SEARCH_DOCUMENT_COLUMN]: tsvector().generatedAlwaysAs(
			sql.raw(searchDocumentExpression(columns, fields))
		)
	};
};

/** The physical fields maintained by embedding settle, or nothing when none is declared. */
const recordEmbeddingColumns = (
	declaration: ModelDeclaration | undefined
): Readonly<Record<string, AnyPgColumnBuilder>> => {
	const embedding = declaration?.metadata?.embedding;
	if (embedding === undefined) return {};
	return {
		[RECORD_EMBEDDING_COLUMN]: vector({
			dimensions: embedding.dimensions ?? DEFAULT_RECORD_EMBEDDING_DIMENSIONS
		}),
		[EMBEDDED_AT_COLUMN]: timestamp({ withTimezone: true, mode: 'string' }),
		[RECORD_EMBEDDING_FINGERPRINT_COLUMN]: text()
	};
};

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
			if (
				Object.hasOwn(declaration.columns, storageColumn) ||
				Object.hasOwn(authoredColumns, storageColumn)
			)
				throw new TypeError(
					`Reference field ${fieldName} generates column ${storageColumn}, but that column is already declared.`
				);
			authoredColumns[storageColumn] = uuid();
		}
	}
	const columns = {
		...defineSystemRowModel().columns,
		...searchDocumentColumn(declaration),
		...recordEmbeddingColumns(declaration),
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
 * Projects one `+collection.ts` declaration into the serializable write contract.
 *
 * Selections are already plain JSON data. The two things that cannot cross into the workspace
 * definition are dropped here: the live module's transform becomes the `hasTransform` flag, and
 * each notification rule's `recipients`/`message` builders become the channel name the rule
 * declares. The artifact carries the live module separately, in `authoredRuntime.collections`.
 */
export const compileCollectionWrite = (declaration: unknown): CompiledCollectionWrite => {
	if (!isRecord(declaration))
		throw new TypeError('A +collection.ts must default-export a defineCollection() declaration.');
	if (!isRecord(declaration.model) || declaration.model.__kind !== 'model')
		throw new TypeError('A collection declaration must name the model it writes.');
	const notifications: Record<string, ReadonlyArray<string>> = {};
	if (declaration.notifications !== undefined) {
		if (!isRecord(declaration.notifications))
			throw new TypeError('A collection declaration notifications must be an object.');
		for (const [event, rules] of Object.entries(declaration.notifications)) {
			if (!Array.isArray(rules))
				throw new TypeError(`notifications.${event} must be an array of rules.`);
			notifications[event] = rules.flatMap((rule) =>
				isRecord(rule) && isString(rule.channel) ? [rule.channel] : []
			);
		}
	}
	const create = declaration.create;
	const update = declaration.update;
	const createInput: CompiledCollectionWrite['create'] | undefined = isRecord(create)
		? (create.input as CompiledCollectionWrite['create'])
		: undefined;
	const updateInput: CompiledCollectionWrite['update'] | undefined = isRecord(update)
		? (update.input as CompiledCollectionWrite['update'])
		: undefined;
	const similarity = isRecord(declaration.similarity)
		? Object.entries(declaration.similarity).flatMap(([name, index]) =>
				isRecord(index) && isString(index.column) && isRecord(index.input)
					? [
							{
								name,
								...(isString(index.label) ? { label: index.label } : {}),
								column: index.column,
								metric: (isString(index.metric) ? index.metric : 'l2') as 'l2' | 'cosine' | 'ip',
								input: Object.entries(index.input).flatMap(([field, control]) =>
									isRecord(control)
										? [
												{
													name: field,
													...(isString(control.label) ? { label: control.label } : {}),
													kind: String(control.kind) as 'number' | 'text' | 'enum',
													...(Array.isArray(control.values)
														? { values: control.values.map(String) }
														: {}),
													...(typeof control.min === 'number' ? { min: control.min } : {}),
													...(typeof control.max === 'number' ? { max: control.max } : {}),
													...(typeof control.step === 'number' ? { step: control.step } : {}),
													...(control.optional === true ? { optional: true } : {})
												}
											]
										: []
								)
							}
						]
					: []
			)
		: [];
	return {
		...(createInput === undefined ? {} : { create: createInput }),
		...(updateInput === undefined ? {} : { update: updateInput }),
		...(isRecord(declaration.delete) ? { delete: true as const } : {}),
		...(Object.keys(notifications).length === 0 ? {} : { notifications }),
		hasTransform: Predicate.isFunction(declaration.transform),
		...(similarity.length === 0 ? {} : { similarity })
	};
};

/** The browser's copy of a write contract: the selections and which operations exist. */
const catalogWriteContract = (
	write: CompiledCollectionWrite
): NonNullable<CollectionCatalogEntry['write']> => ({
	...(write.create === undefined ? {} : { create: catalogSelection(write.create) }),
	...(write.update === undefined ? {} : { update: catalogSelection(write.update) }),
	...(write.delete === true ? { delete: true as const } : {})
});

const catalogSelection = (
	selection: CollectionInputSelection
): NonNullable<NonNullable<CollectionCatalogEntry['write']>['create']> => ({
	...(selection.columns === undefined ? {} : { columns: selection.columns }),
	...(selection.with === undefined
		? {}
		: {
				with: Object.fromEntries(
					Object.entries(selection.with).map(([relation, actions]) => [
						relation,
						{
							...(actions.create === undefined ? {} : { create: catalogSelection(actions.create) }),
							...(actions.update === undefined ? {} : { update: catalogSelection(actions.update) }),
							...(actions.upsert === undefined ? {} : { upsert: catalogSelection(actions.upsert) }),
							...(actions.link === undefined ? {} : { link: catalogSelection(actions.link) }),
							...(actions.unlink === undefined ? {} : { unlink: catalogSelection(actions.unlink) }),
							...(actions.delete === undefined ? {} : { delete: true as const })
						}
					])
				)
			})
});
