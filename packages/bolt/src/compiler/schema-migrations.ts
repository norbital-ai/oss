// repository-health:allow SEM_PARALLEL -- schema-migrations imports collectionIndexName from
// ../runtime/schema/schema-plan.js, so the pair is linked, not parallel.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getErrorMessage, toError } from '@norbital-ai/std';
import { Effect, Result, Schema } from 'effect';
import { getColumns, sql } from 'drizzle-orm';
import { AUTH_MODELS, SYSTEM_MODEL_TABLES } from '../authoring/system-models.js';
import {
	check,
	customType,
	foreignKey,
	index,
	pgTable,
	uniqueIndex,
	uuid,
	type AnyPgColumnBuilder,
	type ExtraConfigColumn,
	type PgTable,
	type PgTableExtraConfigValue
} from 'drizzle-orm/pg-core';
import type * as DrizzleKitPostgres from 'drizzle-kit/api-postgres';
import {
	RECORD_EMBEDDING_COLUMN,
	SEARCH_DOCUMENT_COLUMN,
	compileWorkspaceAuthoring,
	DEFAULT_RECORD_EMBEDDING_DIMENSIONS,
	searchDocumentExpression,
	searchTextExpression
} from '../authoring/model-introspection.js';
import {
	referenceDatabaseIdentifier,
	type ModelDeclaration,
	type ModelIndex
} from '../authoring/models-schema.js';
import { defineSystemRowModel } from '../authoring/system-row-model.js';
import type {
	CompiledAuthoring,
	CompiledCollection,
	CompiledFieldDefinition,
	FieldDefinition,
	RelationDefinition,
	WorkspaceMigrationEntry
} from '../authoring/workspace-schema.js';
import {
	collectionIndexName,
	collectionSearchDocumentIndexName,
	collectionSearchTextTrigramIndexName
} from '../runtime/schema/schema-plan.js';
import { STATEMENT_BREAKPOINT, discoverAuthoredSource } from './workspace-build.js';
import { workspaceSchemaFingerprint } from './schema-fingerprint.js';
import { isString } from '../schema-decode.js';

/** Deterministic in-process Drizzle snapshot diffing; this boundary emits DDL but never executes it. */

/** drizzle-kit's own snapshot shape, taken from the function that produces it rather than restated. */
export type WorkspaceSnapshot = Awaited<ReturnType<typeof DrizzleKitPostgres.generateDrizzleJson>>;

const DRIZZLE_KIT_POSTGRES = 'drizzle-kit/api-postgres';
const loadDrizzleKitPostgres: Effect.Effect<typeof DrizzleKitPostgres, Error> = Effect.tryPromise({
	try: () => import(/* @vite-ignore */ DRIZZLE_KIT_POSTGRES),
	catch: toError
});

/**
 * The stable envelope of a drizzle-kit PostgreSQL snapshot.
 *
 * Checked on read so a document that is not the `ddl` representation `generateMigration` consumes
 * is a named failure of this read rather than a value the differ trusts.
 */
const CurrentWorkspaceSnapshot = Schema.Struct({
	dialect: Schema.Literal('postgres'),
	id: Schema.String,
	prevIds: Schema.Array(Schema.String),
	version: Schema.String,
	ddl: Schema.Array(Schema.Record(Schema.String, Schema.Json))
});

const GeneratedNotNullColumn = Schema.Struct({
	entityType: Schema.Literal('columns'),
	table: Schema.String,
	name: Schema.String,
	notNull: Schema.Literal(true),
	generated: Schema.Struct({ as: Schema.String, type: Schema.String })
});
const isGeneratedNotNullColumn = Schema.is(GeneratedNotNullColumn);
const isMissingFile = Schema.is(Schema.Struct({ code: Schema.Literal('ENOENT') }));

/**
 * A generated lineage entry: what the artifact carries, plus the snapshot only the generator uses.
 *
 * Built on `WorkspaceMigrationEntry` rather than restating `tag` and `statements`, so the shape the
 * host applies and the shape this writes to disk cannot drift apart.
 */
type WorkspaceMigration = WorkspaceMigrationEntry &
	Readonly<{ readonly snapshot: WorkspaceSnapshot }>;

/** Renders one authored index declaration as the Drizzle index the snapshot compares against. */
const authoredIndex = (
	collectionName: string,
	self: Readonly<Record<string, ExtraConfigColumn>>,
	declaration: ModelIndex,
	fields: Readonly<Record<string, FieldDefinition>>
): Array<PgTableExtraConfigValue> => {
	type Variant = Readonly<{
		readonly members: ReadonlyArray<
			ExtraConfigColumn | ReturnType<ExtraConfigColumn['op']> | ReturnType<typeof sql.raw>
		>;
		readonly predicates: ReadonlyArray<ReturnType<typeof sql>>;
		readonly tags: ReadonlyArray<string>;
	}>;
	let variants: ReadonlyArray<Variant> = [{ members: [], predicates: [], tags: [] }];
	for (const member of declaration.columns) {
		if (!isString(member)) {
			variants = variants.map((variant) => ({
				...variant,
				members: [...variant.members, sql.raw(member.expr)]
			}));
			continue;
		}
		const reference = fields[member]?.reference;
		if (reference !== undefined) {
			if (declaration.opclass?.[member] !== undefined)
				throw new Error(
					`Index on "${collectionName}.${member}" cannot apply one operator class to every reference arm.`
				);
			variants = variants.flatMap((variant) =>
				reference.targets.map((target) => {
					const column = self[target.storageColumn];
					if (column === undefined)
						throw new Error(
							`Unknown reference index column "${collectionName}.${target.storageColumn}"`
						);
					return {
						members: [...variant.members, column],
						predicates: [...variant.predicates, sql`${column} is not null`],
						tags: [...variant.tags, target.tag.toLowerCase()]
					};
				})
			);
			continue;
		}
		const column = self[member];
		if (column === undefined) throw new Error(`Unknown index column "${collectionName}.${member}"`);
		const opclass = declaration.opclass?.[member];
		variants = variants.map((variant) => ({
			...variant,
			members: [...variant.members, opclass === undefined ? column : column.op(opclass)]
		}));
	}
	return variants.map((variant) => {
		const [first, ...rest] = variant.members;
		if (first === undefined)
			throw new Error(`Index on "${collectionName}" must declare at least one column`);
		const name =
			variant.tags.length === 0
				? declaration.name
				: referenceDatabaseIdentifier(
						declaration.name ??
							`${collectionName}_${declaration.columns
								.map((column) => (isString(column) ? column : 'expression'))
								.join('_')}_${declaration.unique === true ? 'uidx' : 'idx'}`,
						...variant.tags
					);
		const builder = declaration.unique === true ? uniqueIndex(name) : index(name);
		const built =
			declaration.method === undefined
				? builder.on(first, ...rest)
				: builder.using(declaration.method, first, ...rest);
		const predicates = [
			...(declaration.where === undefined ? [] : [sql.raw(declaration.where)]),
			...variant.predicates
		];
		return predicates.length === 0 ? built : built.where(sql.join(predicates, sql` and `));
	});
};

/** Declared indexes rendered from the same `CompiledAuthoring` consumed by runtime schema. */
const declaredIndexes = (
	collection: CompiledCollection,
	self: Readonly<Record<string, ExtraConfigColumn>>
) =>
	Object.entries(collection.fields)
		.filter(
			([, field]) =>
				field.indexed &&
				field.primaryKey !== true &&
				field.unique !== true &&
				field.reference === undefined
		)
		.map(([columnName]) => columnName)
		.toSorted()
		.map((columnName) => {
			const column = self[columnName];
			if (column === undefined)
				throw new Error(`Unknown indexed column "${collection.name}.${columnName}"`);
			return index(collectionIndexName(collection.name, columnName)).on(column);
		});

/** GIN indexes over the compiled lexical document and its exact fuzzy-search text. */
const searchIndexes = (
	collection: CompiledCollection,
	self: Readonly<Record<string, ExtraConfigColumn>>
): Array<PgTableExtraConfigValue> => {
	const searchable = collection.search?.fields ?? [];
	if (searchable.length === 0) return [];
	const document = self[SEARCH_DOCUMENT_COLUMN];
	if (document === undefined)
		throw new Error(`Missing generated search document for "${collection.name}"`);
	return [
		index(collectionSearchDocumentIndexName(collection.name)).using('gin', document),
		index(collectionSearchTextTrigramIndexName(collection.name)).using(
			'gin',
			sql.raw(`(${searchTextExpression(searchable)}) gin_trgm_ops`)
		)
	];
};

/** Exclusive-arc constraints and per-arm indexes for every logical polymorphic reference. */
const referenceEntities = (
	collection: CompiledCollection,
	self: Readonly<Record<string, ExtraConfigColumn>>,
	tables: Readonly<Record<string, PgTable>>
): Array<PgTableExtraConfigValue> => {
	const entities: Array<PgTableExtraConfigValue> = [];
	for (const [fieldName, field] of Object.entries(collection.fields)) {
		const reference = field.reference;
		if (reference === undefined) continue;
		if (field.required && reference.onDelete === 'set null')
			throw new TypeError(
				`Required reference "${collection.name}.${fieldName}" cannot use ON DELETE SET NULL.`
			);
		const arms = reference.targets.map((target) => {
			const column = self[target.storageColumn];
			if (column === undefined)
				throw new Error(
					`Reference "${collection.name}.${fieldName}" is missing generated column "${target.storageColumn}".`
				);
			return { ...target, column };
		});
		const count = sql`num_nonnulls(${sql.join(
			arms.map((arm) => arm.column),
			sql`, `
		)})`;
		entities.push(
			check(
				referenceDatabaseIdentifier(collection.name, fieldName, 'reference', 'check'),
				field.required ? sql`${count} = 1` : sql`${count} <= 1`
			)
		);
		for (const arm of arms) {
			const targetTable = tables[arm.collection];
			const targetId = targetTable === undefined ? undefined : getColumns(targetTable).id;
			if (targetId === undefined)
				throw new Error(
					`Reference "${collection.name}.${fieldName}" targets undeclared collection "${arm.collection}".`
				);
			const constraint = foreignKey({
				columns: [arm.column],
				foreignColumns: [targetId],
				name: referenceDatabaseIdentifier(collection.name, fieldName, arm.tag.toLowerCase(), 'fk')
			});
			entities.push(constraint.onDelete(reference.onDelete));
			const indexName = referenceDatabaseIdentifier(
				collection.name,
				fieldName,
				arm.tag.toLowerCase(),
				'ref',
				'idx'
			);
			entities.push(
				(field.unique === true ? uniqueIndex(indexName) : index(indexName))
					.on(arm.column)
					.where(sql`${arm.column} is not null`)
			);
		}
	}
	return entities;
};

/**
 * The `one` relation endpoints that become foreign keys, keyed by the collection that holds the key.
 *
 * A `many` side is the same edge read backwards and would emit the constraint twice, and an endpoint
 * pair is what names the columns — a relation declared without one carries no key to constrain.
 */
const foreignKeyRelations = (
	relations: ReadonlyArray<RelationDefinition>
): ReadonlyMap<string, ReadonlyArray<RelationDefinition>> => {
	const byCollection = new Map<string, Array<RelationDefinition>>();
	const seen = new Set<string>();
	for (const relation of relations) {
		const { from, to } = relation;
		if (relation.cardinality !== 'one' || from === undefined || to === undefined) continue;
		const key = `${from.collection}.${from.column}->${to.collection}.${to.column}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const held = byCollection.get(from.collection) ?? [];
		held.push(relation);
		byCollection.set(from.collection, held);
	}
	return byCollection;
};

/** Renders one `one` relation as the foreign key constraint the lineage named it by. */
const authoredForeignKey = (
	relation: RelationDefinition,
	self: Readonly<Record<string, ExtraConfigColumn>>,
	tables: Readonly<Record<string, PgTable>>
) => {
	const { from, to } = relation;
	const target = to === undefined ? undefined : tables[to.collection];
	if (from === undefined || to === undefined || target === undefined) {
		throw new Error(
			`Relation "${relation.name}" targets a collection this workspace does not declare`
		);
	}
	const column = self[from.column];
	/** Relations name the same application property and database column on every compiled model. */
	const targetColumns = getColumns(target);
	const foreignColumn = targetColumns[to.column];
	if (column === undefined || foreignColumn === undefined) {
		throw new Error(`Relation "${relation.name}" names a column no collection declares`);
	}
	const constraint = foreignKey({
		columns: [column],
		foreignColumns: [foreignColumn],
		name: `${from.collection}_${from.column}_${to.collection}_fk`
	});
	// `ON DELETE CASCADE` only where the workspace asked for it with `cascade(...)`. Without this the
	// wrapper was decorative and every key was `NO ACTION`, so deleting a parent that owned children
	// was refused by the database — a payroll run could not be deleted once it had written a payslip.
	return relation.cascade === true ? constraint.onDelete('cascade') : constraint;
};

/**
 * Tables a relation may point at without the workspace declaring them.
 *
 * `user` is the identity provider's own table, and it is the only description of a person Bolt has —
 * so "who owns this record" is a foreign key into it, not into a collection each workspace would
 * otherwise have to invent and keep in step with who can actually sign in. There is deliberately no
 * `user` collection wrapping it: the auth provider *is* the user, and a second table claiming to
 * describe the same people is the arrangement identity was moved into bolt to remove.
 */
const REFERENCE_ONLY_TABLES: Readonly<Record<string, PgTable>> = {
	user: SYSTEM_MODEL_TABLES[AUTH_MODELS.user]
};

const arrayDimensionsOf = (sqlType: string): number => sqlType.match(/\[\]/g)?.length ?? 0;

const pgArrayDimension = (
	dimensions: number
): '[]' | '[][]' | '[][][]' | '[][][][]' | '[][][][][]' => {
	switch (dimensions) {
		case 1:
			return '[]';
		case 2:
			return '[][]';
		case 3:
			return '[][][]';
		case 4:
			return '[][][][]';
		case 5:
			return '[][][][][]';
		default:
			throw new TypeError(`Unsupported PostgreSQL array dimension count: ${dimensions}`);
	}
};

const compiledColumn = (
	collection: string,
	name: string,
	field: CompiledFieldDefinition
): AnyPgColumnBuilder => {
	if (field.sqlType === undefined)
		throw new TypeError(`Compiled field ${collection}.${name} has no physical SQL type.`);
	const arrayDimensions = field.array === true ? Math.max(1, arrayDimensionsOf(field.sqlType)) : 0;
	const baseSqlType = arrayDimensions > 0 ? field.sqlType.replace(/\[\]+$/g, '') : field.sqlType;
	const builder = customType<{ data: unknown; driverData: unknown }>({
		dataType: () => baseSqlType
	})();
	if (arrayDimensions > 0) builder.array(pgArrayDimension(arrayDimensions));
	if (field.generated !== undefined) builder.generatedAlwaysAs(sql.raw(field.generated));
	else if (field.sqlDefault !== undefined) builder.default(sql.raw(field.sqlDefault));
	if (field.primaryKey === true) builder.primaryKey();
	else if (field.databaseNotNull === true) builder.notNull();
	if (field.unique === true) builder.unique();
	return builder;
};

const generatedColumn = (sqlType: string, expression: string): AnyPgColumnBuilder => {
	const builder = customType<{ data: unknown; driverData: unknown }>({
		dataType: () => sqlType
	})();
	builder.generatedAlwaysAs(sql.raw(expression));
	return builder;
};

/** Reconstructs migration DDL solely from the canonical compiled collection description. */
const compiledPhysicalColumns = (
	collection: CompiledCollection
): Readonly<Record<string, AnyPgColumnBuilder>> => {
	const columns: Record<string, AnyPgColumnBuilder> = { ...defineSystemRowModel().columns };
	const searchable = collection.search?.fields ?? [];
	if (searchable.length > 0)
		columns[SEARCH_DOCUMENT_COLUMN] = generatedColumn(
			'tsvector',
			searchDocumentExpression(searchable, collection.fields)
		);
	if (collection.embedding !== undefined) {
		const dimensions = collection.embedding.dimensions ?? DEFAULT_RECORD_EMBEDDING_DIMENSIONS;
		columns[RECORD_EMBEDDING_COLUMN] = customType<{ data: unknown; driverData: unknown }>({
			dataType: () => `vector(${dimensions})`
		})();
		columns[collection.embedding.embeddedAtColumn] = customType<{
			data: unknown;
			driverData: unknown;
		}>({ dataType: () => 'timestamp with time zone' })();
		columns[collection.embedding.sourceFingerprintColumn] = customType<{
			data: unknown;
			driverData: unknown;
		}>({ dataType: () => 'text' })();
	}
	for (const [name, field] of Object.entries(collection.fields)) {
		if (field.reference === undefined) {
			columns[name] = compiledColumn(collection.name, name, field);
			continue;
		}
		for (const target of field.reference.targets) columns[target.storageColumn] = uuid();
	}
	return columns;
};

/** HNSW cosine index over the platform-maintained record embedding. */
const recordEmbeddingIndexes = (
	collection: CompiledCollection,
	self: Readonly<Record<string, ExtraConfigColumn>>
): Array<PgTableExtraConfigValue> => {
	if (collection.embedding === undefined) return [];
	const column = self[RECORD_EMBEDDING_COLUMN];
	if (column === undefined) return [];
	return [
		index(collectionIndexName(collection.name, `${RECORD_EMBEDDING_COLUMN}_hnsw`)).using(
			'hnsw',
			column.op('vector_cosine_ops')
		)
	];
};

/** Drizzle migration tables; reference-only host tables are targets but never diff inputs. */
const workspaceMigrationTables = (
	authoring: CompiledAuthoring
): Readonly<Record<string, PgTable>> => {
	const byCollection = foreignKeyRelations(authoring.relationships);
	const tables: Record<string, PgTable> = {};
	const targets: Record<string, PgTable> = { ...REFERENCE_ONLY_TABLES };
	for (const collection of authoring.collections) {
		const table = pgTable(collection.name, compiledPhysicalColumns(collection), (self) => [
			...(collection.indexes ?? []).flatMap((declaration) =>
				authoredIndex(collection.name, self, declaration, collection.fields)
			),
			...declaredIndexes(collection, self),
			...searchIndexes(collection, self),
			...recordEmbeddingIndexes(collection, self),
			...referenceEntities(collection, self, targets),
			// Read when Drizzle asks for the table config rather than now, so a relation may point at a
			// collection declared later in the same pass.
			...(byCollection.get(collection.name) ?? []).map((relation) =>
				authoredForeignKey(relation, self, targets)
			)
		]);
		tables[collection.name] = table;
		targets[collection.name] = table;
	}
	return tables;
};

/** drizzle-kit v1 names a lineage entry `<UTC timestamp>_<name>`; a synthesized one has to match. */
const migrationTag = (name: string, at = new Date()): string =>
	`${at.toISOString().replace(/[-:T]/g, '').slice(0, 14)}_${name}`;

/** The plan input: what the workspace authored, the lineage's previous snapshot, and what to name it. */
type WorkspaceMigrationPlanInput = Readonly<{
	readonly authoring: CompiledAuthoring;
	readonly previous: WorkspaceSnapshot | undefined;
	readonly name?: string;
	readonly at?: Date;
}>;

/**
 * Drizzle preserves declaration order when it emits `ALTER TABLE ... ADD COLUMN` statements. That
 * order is not dependency-aware: a generated column declared before a new ordinary column it reads
 * is emitted first, and PostgreSQL refuses the migration because the referenced column does not
 * exist yet.
 *
 * PostgreSQL does not permit a generated column to depend on another generated column, so the
 * complete dependency rule for additions to one existing table is ordinary columns first,
 * generated columns second. Replace only that table's add-column slots; every other statement keeps
 * its original position relative to table creation, drops, indexes, and constraints.
 */
export const orderGeneratedColumnDependencies = (
	statements: ReadonlyArray<string>
): ReadonlyArray<string> => {
	const ordered = [...statements];
	const additionsByTable = new Map<
		string,
		Array<{ readonly index: number; readonly sql: string }>
	>();
	for (const [index, statement] of statements.entries()) {
		const matched = /^ALTER TABLE "([^"]+)" ADD COLUMN /.exec(statement);
		if (matched?.[1] === undefined) continue;
		const additions = additionsByTable.get(matched[1]) ?? [];
		additions.push({ index, sql: statement });
		additionsByTable.set(matched[1], additions);
	}
	for (const additions of additionsByTable.values()) {
		const dependencyOrder = additions.toSorted(
			(left, right) =>
				Number(left.sql.includes(' GENERATED ALWAYS AS ')) -
				Number(right.sql.includes(' GENERATED ALWAYS AS '))
		);
		additions.forEach(({ index }, position) => {
			const replacement = dependencyOrder[position];
			if (replacement !== undefined) ordered[index] = replacement.sql;
		});
	}
	return ordered;
};

/**
 * drizzle-kit records `notNull: true` for a generated column in the target snapshot but omits that
 * constraint when the column is added to an existing table. A subsequent diff then reports the
 * schema as converged even though the database accepts NULL, because it trusts the snapshot it
 * wrote rather than the DDL it emitted. Add the missing constraint explicitly at the same boundary
 * where the raw statements are reconciled with the target snapshot.
 */
const restoreGeneratedColumnNotNull = (
	statements: ReadonlyArray<string>,
	snapshot: WorkspaceSnapshot
): ReadonlyArray<string> => {
	const required = new Set(
		snapshot.ddl.flatMap((entity) =>
			isGeneratedNotNullColumn(entity) ? [`${entity.table}\u0000${entity.name}`] : []
		)
	);
	return statements.flatMap((statement) => {
		const matched = /^ALTER TABLE "([^"]+)" ADD COLUMN "([^"]+)" .* GENERATED ALWAYS AS /.exec(
			statement
		);
		if (matched?.[1] === undefined || matched[2] === undefined) return [statement];
		if (!required.has(`${matched[1]}\u0000${matched[2]}`)) return [statement];
		// repository-health:allow SQL1 -- repairs a statement drizzle-kit already emitted, rather
		// than authoring one: drizzle drops NOT NULL from a generated column, and only the raw
		// statement list exists at this point in the pipeline.
		return [statement, `ALTER TABLE "${matched[1]}" ALTER COLUMN "${matched[2]}" SET NOT NULL;`];
	});
};

/**
 * The identity drizzle-kit's differ itself uses to pair one DDL entity across two snapshots.
 *
 * Reproduced from its `getCompositeKey` — `schema`, `table`, `name`, `entityType` — because the
 * two-pass split below is sound only if this module partitions entities at least as finely as the
 * differ does. Drizzle joins those four with `:`, which collides for an identifier containing one;
 * NUL cannot appear in a PostgreSQL identifier, so this key is strictly finer, and finer is the safe
 * direction: it can only split a pair the differ would have matched into a drop and an add, never
 * merge two the differ keeps apart.
 *
 * `schema` and `table` do not exist on the kinds that have neither — `schemas` and `roles` — and are
 * null at runtime for them, so both are normalised away.
 */
const ddlEntityKey = (entity: WorkspaceSnapshot['ddl'][number]): string => {
	const schema = 'schema' in entity ? (entity.schema ?? '') : '';
	const table = 'table' in entity ? (entity.table ?? '') : '';
	return `${schema}\u0000${table}\u0000${entity.name}\u0000${entity.entityType}`;
};

/**
 * Diffs `CompiledAuthoring` against the previous snapshot. The intermediate subset makes the first
 * pass drop-only and the second create/alter-only, avoiding drizzle-kit's ambiguous rename resolver
 * while preserving Bolt's explicit drop-and-add rename contract.
 */
export const planWorkspaceMigration = (
	input: WorkspaceMigrationPlanInput
): Effect.Effect<WorkspaceMigration | undefined, Error> =>
	Effect.gen(function* () {
		const { generateDrizzleJson, generateMigration } = yield* loadDrizzleKitPostgres;
		const tables = workspaceMigrationTables(input.authoring);
		// The previous snapshot is used whole. It used to be filtered to the tables the current models
		// declare, so that a lineage written by Bolt — whose snapshot also carried its platform identity
		// tables — did not diff into a `DROP TABLE` for each. Every lineage is Bolt's own now, and against
		// one the filter had exactly one remaining effect: a collection deleted from the workspace is not
		// in the current models either, so it was stripped from both sides of the diff and no `DROP TABLE`
		// was ever generated for it. The table stayed in the database forever, which is the bug the
		// differ exists to fix.
		const previous =
			input.previous ??
			(yield* Effect.tryPromise({
				try: () => generateDrizzleJson({}),
				catch: toError
			}));
		const snapshot = yield* Effect.tryPromise({
			try: () => generateDrizzleJson(tables, previous.id),
			catch: toError
		});
		const surviving = new Set(snapshot.ddl.map(ddlEntityKey));
		const intermediate: WorkspaceSnapshot = {
			...previous,
			ddl: previous.ddl.filter((entity) => surviving.has(ddlEntityKey(entity)))
		};
		// Drops before creates. drizzle-kit orders the statements within each pass, and each pass is a
		// complete diff, so the only ordering this concatenation decides is between the two halves.
		// Removals first is the half that can be depended upon: an entity the target schema still
		// references is by definition present in `snapshot`, so it is in `intermediate` and is never
		// dropped, while a constraint left over from a dropped table is absent from `snapshot` and so
		// leaves in the same pass that drops the table it guarded — with drizzle-kit's own ordering
		// between them. Nothing created in the second pass can reference something the first removed.
		const removals = yield* Effect.tryPromise({
			try: () => generateMigration(previous, intermediate),
			catch: toError
		});
		const additions = yield* Effect.tryPromise({
			try: () => generateMigration(intermediate, snapshot),
			catch: toError
		});
		const statements = restoreGeneratedColumnNotNull(
			orderGeneratedColumnDependencies([...removals, ...additions]),
			snapshot
		);
		if (statements.length === 0) return undefined;
		return { tag: migrationTag(input.name ?? 'auto', input.at), statements, snapshot };
	});

/**
 * Compiles one host-owned model through the same Drizzle diff that owns workspace table DDL.
 *
 * Host control data does not join the workspace definition, sync, policies, or approvals. It still
 * needs one model declaration and one table compiler, though: keeping a handwritten `CREATE TABLE`
 * beside a `defineModel` would recreate the split schema path this compiler exists to remove.
 */
export const compileHostModelSchema = (
	name: string,
	model: ModelDeclaration
): Effect.Effect<ReadonlyArray<string>, Error> =>
	planWorkspaceMigration({
		authoring: compileWorkspaceAuthoring({
			models: { [name]: model },
			sourcePaths: { [name]: `host:${name}` }
		}),
		previous: undefined,
		name
	}).pipe(
		Effect.map((migration) =>
			(migration?.statements ?? []).map((statement) =>
				// A host acquires this schema on every process start. Workspace DDL is lineage-diffed,
				// but a host model has no authored lineage; its bootstrap table must therefore make
				// the ordinary already-present state a no-op instead of preventing every restart.
				statement.replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS ')
			)
		)
	);

/**
 * Imports one authored `+model.ts` for its declaration.
 *
 * The declaration is the authority — reading the source text recovers a builder's name and nothing
 * of what it was configured with — so the module is imported rather than scraped, and a module that
 * cannot be imported is fatal rather than skipped.
 */
const importModel = (modelFile: string) =>
	Effect.tryPromise({
		try: async () => {
			/**
			 * `sync --watch` validates repeatedly in one Node process. A plain file URL is an ESM cache
			 * key, so importing it again after an author edits `+model.ts` returns the old declaration and
			 * can falsely report that the committed snapshot still agrees. Content is the revision: an
			 * unchanged model keeps the cheap cached module, while a changed model receives a new URL.
			 */
			const source = await readFile(modelFile, 'utf8');
			const revision = createHash('sha256').update(source).digest('hex');
			return import(`${pathToFileURL(modelFile).href}?bolt-model=${revision}`);
		},
		catch: (caught) =>
			new Error(
				`Could not import ${modelFile} to read its columns.\n\n` +
					'A collection model is imported directly, so it must be strippable TypeScript — no `enum`, ' +
					'no `namespace`, and no constructor parameter properties.\n\n' +
					`Node said:\n${getErrorMessage(caught)}`,
				{ cause: caught }
			)
	}).pipe(
		Effect.flatMap((module) => {
			const imported = Schema.decodeUnknownResult(Schema.Struct({ default: Schema.Unknown }))(
				module
			);
			const declaration = Result.isSuccess(imported) ? imported.success.default : undefined;
			if (!Schema.is(Schema.Struct({ __kind: Schema.Literal('model') }))(declaration)) {
				return Effect.fail(
					new Error(`${modelFile} does not default-export a defineModel() declaration`)
				);
			}
			// The envelope is schema-checked above. Its columns are opaque Drizzle builder instances, so
			// their generic witness is the one compile-time cast this dynamic-import boundary must retain.
			return Effect.succeed(declaration as ModelDeclaration);
		})
	);

/** Imports the model declarations named by filesystem-first discovery, keyed by collection name. */
export const importWorkspaceModels = (modelFiles: ReadonlyArray<string>) =>
	Effect.forEach(modelFiles, (modelFile) =>
		importModel(modelFile).pipe(
			Effect.map((model) => [basename(dirname(modelFile)), model] as const)
		)
	).pipe(Effect.map((entries) => Object.fromEntries(entries)));

/** Imports the optional relationship function through the same content-revision boundary as models. */
export const importWorkspaceRelationships = (relationshipFile: string) =>
	Effect.tryPromise({
		try: async () => {
			let source: string;
			try {
				source = await readFile(relationshipFile, 'utf8');
			} catch (caught) {
				if (isMissingFile(caught)) return undefined;
				throw caught;
			}
			const revision = createHash('sha256').update(source).digest('hex');
			const module = await import(
				`${pathToFileURL(relationshipFile).href}?bolt-relationships=${revision}`
			);
			if (typeof module.default !== 'function')
				throw new TypeError('the module does not default-export a relationship function');
			return module.default as unknown;
		},
		catch: (caught) =>
			new Error(
				`Could not import ${relationshipFile} to compile its relationships.\n\nNode said:\n${getErrorMessage(caught)}`,
				{ cause: caught }
			)
	});

/** The newest lineage entry's snapshot, or `undefined` when the workspace has no lineage yet. */
export const latestSnapshot = (
	migrationsRoot: string
): Effect.Effect<WorkspaceSnapshot | undefined, Error> =>
	Effect.gen(function* () {
		const entries = yield* Effect.tryPromise({
			try: () => readdir(migrationsRoot, { withFileTypes: true }),
			catch: toError
		}).pipe(
			// A missing migrations root means the workspace has no lineage yet; any other read failure
			// must not masquerade as "no lineage" and let sync compile against the wrong authority.
			Effect.catch((cause) =>
				isMissingFile(cause) ? Effect.succeed<Array<Dirent>>([]) : Effect.fail(cause)
			)
		);
		const tags = entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.toSorted();
		for (const tag of tags.toReversed()) {
			const source = yield* Effect.tryPromise({
				try: () => readFile(join(migrationsRoot, tag, 'snapshot.json'), 'utf8'),
				catch: toError
			}).pipe(
				// A tag without a snapshot.json is a partial lineage entry to skip; an unreadable
				// snapshot must fail rather than silently fall back to an older tag's snapshot.
				Effect.catch((cause) =>
					isMissingFile(cause) ? Effect.succeed<string | undefined>(undefined) : Effect.fail(cause)
				)
			);
			if (source !== undefined) {
				// The snapshot is a drizzle-kit JSON document; parse it through the JSON schema so a
				// truncated file is a named failure of this read rather than a value the differ trusts.
				const parsed = Schema.decodeUnknownSync(
					Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
				)(source);
				if (Schema.is(CurrentWorkspaceSnapshot)(parsed)) return parsed as WorkspaceSnapshot;
				return yield* Effect.fail(
					new Error(`Could not read drizzle snapshot ${join(migrationsRoot, tag)}.`)
				);
			}
		}
		return undefined;
	});

type ValidatedWorkspaceMigrationLineage = Readonly<{
	readonly snapshot: WorkspaceSnapshot;
	readonly schemaFingerprint: string;
}>;

/**
 * Proves that sync is compiling exactly the schema its author committed.
 *
 * This is the read-only half of `bolt migrate`: it runs the same Drizzle diff but never writes a
 * migration, snapshot, generated module, or artifact. A successful result is therefore safe for
 * sync to reuse as its schema authority; every failure tells the author to run the one command that
 * is allowed to advance that authority.
 */
export const validateWorkspaceMigrationLineage = (
	input: Readonly<{
		readonly workspaceRoot: string;
		readonly authoring: CompiledAuthoring;
	}>
) =>
	Effect.gen(function* () {
		const migrationsRoot = join(input.workspaceRoot, '.norbital', 'migrations');
		const snapshot = yield* latestSnapshot(migrationsRoot);
		if (snapshot === undefined) {
			return yield* Effect.fail(
				new Error(
					'Migration lineage has no committed schema snapshot. Run `bolt migrate` and commit the resulting lineage before `bolt sync`.'
				)
			);
		}
		const pending = yield* planWorkspaceMigration({
			authoring: input.authoring,
			previous: snapshot
		});
		if (pending !== undefined) {
			return yield* Effect.fail(
				new Error(
					`Authored models or relationships do not agree with the latest committed migration snapshot (${pending.statements.length} pending statement${pending.statements.length === 1 ? '' : 's'}). Run \`bolt migrate\` and commit the resulting lineage before \`bolt sync\`.`
				)
			);
		}

		const schemaFingerprint = workspaceSchemaFingerprint(snapshot, input.authoring.relationships);
		return { snapshot, schemaFingerprint } satisfies ValidatedWorkspaceMigrationLineage;
	});

/**
 * Generates the next lineage entry for a workspace on disk.
 *
 * Writes `<migrations>/<tag>/{migration.sql,snapshot.json}` — the layout the lineage already uses,
 * so the entries already there stay applicable and this one joins them. It does not apply anything.
 */
export const generateWorkspaceMigration = (workspaceRoot: string, name?: string) =>
	Effect.gen(function* () {
		// Discovery is `sync`'s, not a second walk: a migration must cover exactly the collections the
		// compiler emits, and two rules for "what is a collection" would eventually disagree.
		const {
			root,
			models: modelFiles,
			datatypeNames
		} = yield* discoverAuthoredSource(workspaceRoot);
		const migrationsRoot = join(root, '.norbital', 'migrations');
		const models = yield* importWorkspaceModels(modelFiles);
		const relationshipDeclaration = yield* importWorkspaceRelationships(
			join(root, 'src', 'collections', '+relationship.ts')
		);
		const authoring = compileWorkspaceAuthoring({
			models,
			sourcePaths: Object.fromEntries(
				modelFiles.map((path) => [
					basename(dirname(path)),
					relative(root, path).replaceAll('\\', '/')
				])
			),
			relationships: relationshipDeclaration,
			customTypeNames: datatypeNames
		});
		const previous = yield* latestSnapshot(migrationsRoot);
		const migration = yield* planWorkspaceMigration({
			authoring,
			previous,
			...(name === undefined ? {} : { name })
		});
		if (migration !== undefined) yield* writeMigration(migrationsRoot, migration);
		return migration === undefined
			? { migrationsRoot, statements: [] }
			: {
					migrationsRoot,
					tag: migration.tag,
					statements: migration.statements
				};
	});

/** Writes one lineage entry in the layout drizzle-kit and the existing migrations already use. */
export const writeMigration = (migrationsRoot: string, migration: WorkspaceMigration) =>
	Effect.gen(function* () {
		const directory = join(migrationsRoot, migration.tag);
		yield* Effect.tryPromise(() => mkdir(directory, { recursive: true }));
		yield* Effect.tryPromise(() =>
			writeFile(
				join(directory, 'migration.sql'),
				`${migration.statements.join(`\n${STATEMENT_BREAKPOINT}\n`)}\n`,
				'utf8'
			)
		);
		yield* Effect.tryPromise(() =>
			writeFile(
				join(directory, 'snapshot.json'),
				`${JSON.stringify(migration.snapshot, null, 2)}\n`,
				'utf8'
			)
		);
	});
