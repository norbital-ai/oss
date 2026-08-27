// repository-health:allow SEM_PARALLEL -- schema-migrations imports collectionIndexName from
// ./schema-plan.js, so the pair is linked, not parallel.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Effect, Result, Schema } from 'effect';
import { getColumns, sql } from 'drizzle-orm';
import { AUTH_MODELS, SYSTEM_MODEL_TABLES } from '../authoring/system-models.js';
import {
	check,
	foreignKey,
	index,
	uniqueIndex,
	type ExtraConfigColumn,
	type PgTable,
	type PgTableExtraConfigValue
} from 'drizzle-orm/pg-core';
import type * as DrizzleKitPostgres from 'drizzle-kit/api-postgres';
import { collectionSearchTrigramIndexName } from '@norbital-ai/std/collection';
import {
	compileModelTable,
	describeModelColumns,
	searchableColumns
} from '../authoring/model-introspection.js';
import {
	referenceDatabaseIdentifier,
	type AnyModelFieldBuilder,
	type ModelDeclaration,
	type ModelIndex
} from '../authoring/models-schema.js';
import type {
	FieldDefinition,
	RelationDefinition,
	WorkspaceMigrationEntry
} from '../authoring/workspace-schema.js';
import { extractRelationships } from './model-fields.js';
import { collectionIndexName } from './schema-plan.js';
import { STATEMENT_BREAKPOINT, discoverAuthoredSource } from './sync.js';
import {
	advanceMutationCompatibilityLedger,
	mutationSchemaDescriptor,
	mutationSchemaFingerprint,
	readMutationCompatibilityLedger,
	type MutationCompatibilityLedger,
	writeMutationCompatibilityLedger
} from './mutation-schema-compatibility.js';

/**
 * Drizzle-driven schema migration.
 *
 * `buildSchemaPlan` can only ever say `create table if not exists`: it renders the current shape and
 * has nothing to compare it against, so a column removed from a model stays in the database forever.
 * Migration is a *difference* between two shapes, and Drizzle already models both halves — authored
 * models are Drizzle column builders, and drizzle-kit can serialise a schema to a snapshot and diff
 * two snapshots into DDL.
 * The diff runs in this process through `drizzle-kit/api-postgres`; generation is deterministic and
 * has no subprocess or interactive prompt.
 *
 * This module is a DDL compiler boundary. Its string transforms consume and repair migration DDL
 * emitted by drizzle-kit; it neither executes application data CRUD nor exposes a query escape hatch.
 */

/** drizzle-kit's own snapshot shape, taken from the function that produces it rather than restated. */
export type WorkspaceSnapshot = Awaited<ReturnType<typeof DrizzleKitPostgres.generateDrizzleJson>>;

const DRIZZLE_KIT_POSTGRES = 'drizzle-kit/api-postgres';
const loadDrizzleKitPostgres: Effect.Effect<typeof DrizzleKitPostgres> = Effect.promise(
	() => import(/* @vite-ignore */ DRIZZLE_KIT_POSTGRES)
);

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
		if (typeof member !== 'string') {
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
								.map((column) => (typeof column === 'string' ? column : 'expression'))
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

/**
 * The declared indexes for a collection's `indexed: true` columns, as Drizzle entities.
 *
 * The schema plan creates these too, for a database it provisions from nothing; a database that
 * already exists only ever changes through this lineage, so an index that lived only in the plan
 * would never reach it. Both sides take the name from `collectionIndexName`, so whichever runs first
 * satisfies the other and the two databases hold the same index under the same name.
 *
 * Read through `describeModelColumns` rather than off the builders here, for the same reason
 * `searchIndexes` is: that is the one function that decides what a column declaration says, and a
 * second reader of the same flag is how the plan and the lineage come to index different columns.
 */
const declaredIndexes = (
	collectionName: string,
	columns: Readonly<Record<string, AnyModelFieldBuilder>>,
	self: Readonly<Record<string, ExtraConfigColumn>>
) =>
	Object.entries(describeModelColumns(columns))
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
				throw new Error(`Unknown indexed column "${collectionName}.${columnName}"`);
			return index(collectionIndexName(collectionName, columnName)).on(column);
		});

/**
 * The GIN trigram indexes for a collection's searchable columns, as Drizzle entities.
 *
 * The schema plan creates these too, for a database it provisions from nothing; a database that
 * already exists only ever changes through this lineage, so an index that lived only in the plan
 * would never reach the collections whose size is the reason #44 matters. Both sides take the name
 * from `@norbital-ai/std/collection`, so whichever runs first satisfies the other.
 *
 * Searchability is read through `describeModelColumns` rather than off the builder here: that is the
 * one function that knows what `text({ search: true })` left behind, and a second reader of the same
 * marker is how the index and the search it exists for come to disagree.
 */
const searchIndexes = (
	collectionName: string,
	columns: Readonly<Record<string, AnyModelFieldBuilder>>,
	self: Readonly<Record<string, ExtraConfigColumn>>
) =>
	searchableColumns(describeModelColumns(columns)).map((columnName) => {
		const column = self[columnName];
		if (column === undefined)
			throw new Error(`Unknown searchable column "${collectionName}.${columnName}"`);
		return index(collectionSearchTrigramIndexName(collectionName, columnName)).using(
			'gin',
			column.op('gin_trgm_ops')
		);
	});

/** Exclusive-arc constraints and per-arm indexes for every logical polymorphic reference. */
const referenceEntities = (
	collectionName: string,
	columns: Readonly<Record<string, AnyModelFieldBuilder>>,
	self: Readonly<Record<string, ExtraConfigColumn>>,
	tables: Readonly<Record<string, PgTable>>
): Array<PgTableExtraConfigValue> => {
	const entities: Array<PgTableExtraConfigValue> = [];
	for (const [fieldName, field] of Object.entries(describeModelColumns(columns))) {
		const reference = field.reference;
		if (reference === undefined) continue;
		if (field.required && reference.onDelete === 'set null')
			throw new TypeError(
				`Required reference "${collectionName}.${fieldName}" cannot use ON DELETE SET NULL.`
			);
		const arms = reference.targets.map((target) => {
			const column = self[target.storageColumn];
			if (column === undefined)
				throw new Error(
					`Reference "${collectionName}.${fieldName}" is missing generated column "${target.storageColumn}".`
				);
			return { ...target, column };
		});
		const count = sql`num_nonnulls(${sql.join(
			arms.map((arm) => arm.column),
			sql`, `
		)})`;
		entities.push(
			check(
				referenceDatabaseIdentifier(collectionName, fieldName, 'reference', 'check'),
				field.required ? sql`${count} = 1` : sql`${count} <= 1`
			)
		);
		for (const arm of arms) {
			const targetTable = tables[arm.collection];
			const targetId = targetTable === undefined ? undefined : getColumns(targetTable).id;
			if (targetId === undefined)
				throw new Error(
					`Reference "${collectionName}.${fieldName}" targets undeclared collection "${arm.collection}".`
				);
			const constraint = foreignKey({
				columns: [arm.column],
				foreignColumns: [targetId],
				name: referenceDatabaseIdentifier(collectionName, fieldName, arm.tag.toLowerCase(), 'fk')
			});
			entities.push(constraint.onDelete(reference.onDelete));
			const indexName = referenceDatabaseIdentifier(
				collectionName,
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

/**
 * The Drizzle tables a workspace's authored models describe, as drizzle-kit serialises them.
 *
 * The identity table is reachable as a foreign-key target but is never returned, and the difference
 * matters: this map is also what the migration is diffed against, so including it would write a
 * `CREATE TABLE user` into every workspace's lineage — for a table the schema plan already
 * owns and creates before any lineage runs.
 */
const workspaceMigrationTables = (
	models: Readonly<Record<string, ModelDeclaration>>,
	relations: ReadonlyArray<RelationDefinition>
): Readonly<Record<string, PgTable>> => {
	const byCollection = foreignKeyRelations(relations);
	const tables: Record<string, PgTable> = {};
	const targets: Record<string, PgTable> = { ...REFERENCE_ONLY_TABLES };
	for (const [name, model] of Object.entries(models)) {
		const table = compileModelTable(name, model, (self) => [
			...(model.metadata?.indexes ?? []).flatMap((declaration) =>
				authoredIndex(name, self, declaration, describeModelColumns(model.columns))
			),
			...declaredIndexes(name, model.columns, self),
			...searchIndexes(name, model.columns, self),
			...referenceEntities(name, model.columns, self, targets),
			// Read when Drizzle asks for the table config rather than now, so a relation may point at a
			// collection declared later in the same pass.
			...(byCollection.get(name) ?? []).map((relation) =>
				authoredForeignKey(relation, self, targets)
			)
		]);
		tables[name] = table;
		targets[name] = table;
	}
	return tables;
};

/** drizzle-kit v1 names a lineage entry `<UTC timestamp>_<name>`; a synthesized one has to match. */
const migrationTag = (name: string, at = new Date()): string =>
	`${at.toISOString().replace(/[-:T]/g, '').slice(0, 14)}_${name}`;

/** The plan input: what the workspace authored, the lineage's previous snapshot, and what to name it. */
type WorkspaceMigrationPlanInput = Readonly<{
	readonly models: Readonly<Record<string, ModelDeclaration>>;
	readonly relations: ReadonlyArray<RelationDefinition>;
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
 * Diffs the authored models against the previous snapshot and returns the migration, or `undefined`
 * when the two already agree.
 *
 * An empty diff is the only honest "nothing to do" signal, which is why this carries no fingerprint
 * cache: one would exist only to avoid paying for a subprocess, and a cache that disagrees with the
 * schema is how a changed column reaches the client with no migration behind it.
 *
 * The diff runs in two passes, and that is a correctness requirement rather than a structuring
 * choice. drizzle-kit resolves create-versus-rename through a resolver it asks whenever, for a
 * single entity kind, one diff both created and deleted something; `generateMigration` constructs
 * those resolvers with no `HintsHandler`, so reaching that question at all throws
 * `Internal error: resolver(table) was called without a HintsHandler`. The resolver returns early
 * when either side is empty, which is why a workspace that only ever grew never hit it, and why the
 * first restructure that deleted collections while adding others did.
 *
 * Splitting the diff removes the question instead of answering it. `intermediate` is `previous`
 * carrying only the entities whose identity also appears in `snapshot`, so the first pass can only
 * delete — its target is a subset of its source, taken from the source's own entity objects — and
 * the second can only create or alter, because its source is a subset of its target. Neither pass
 * can present both sides for any kind, and that holds for every kind the resolver covers, including
 * a column dropped from a table that survives, because the subset relation is established over the
 * whole entity list rather than kind by kind. This also matches what Bolt already promises authors:
 * a rename is not a supported edit, it is a drop and an add.
 *
 * The intermediate is emphatically not the previous-snapshot filter this function used to apply and
 * that the comment below records. That filter narrowed the *source* of the only diff to what the
 * current models declare, which hid a deleted collection from the differ entirely and generated no
 * `DROP TABLE`. This filter narrows the *target* of the first pass, so a deleted collection is
 * present in that pass's source and absent from its target — it is precisely the drop the old filter
 * suppressed, and it is now the entire content of the first pass.
 */
export const planWorkspaceMigration = (
	input: WorkspaceMigrationPlanInput
): Effect.Effect<WorkspaceMigration | undefined> =>
	Effect.gen(function* () {
		const { generateDrizzleJson, generateMigration } = yield* loadDrizzleKitPostgres;
		const tables = workspaceMigrationTables(input.models, input.relations);
		// The previous snapshot is used whole. It used to be filtered to the tables the current models
		// declare, so that a lineage written by Bolt — whose snapshot also carried its platform identity
		// tables — did not diff into a `DROP TABLE` for each. Every lineage is Bolt's own now, and against
		// one the filter had exactly one remaining effect: a collection deleted from the workspace is not
		// in the current models either, so it was stripped from both sides of the diff and no `DROP TABLE`
		// was ever generated for it. The table stayed in the database forever, which is the bug the
		// differ exists to fix.
		const previous = input.previous ?? (yield* Effect.promise(() => generateDrizzleJson({})));
		const snapshot = yield* Effect.promise(() => generateDrizzleJson(tables, previous.id));
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
		const removals = yield* Effect.promise(() => generateMigration(previous, intermediate));
		const additions = yield* Effect.promise(() => generateMigration(intermediate, snapshot));
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
): Effect.Effect<ReadonlyArray<string>> =>
	planWorkspaceMigration({
		models: { [name]: model },
		relations: [],
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
					`Node said:\n${caught instanceof Error ? caught.message : String(caught)}`,
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
	Effect.gen(function* () {
		const models: Record<string, ModelDeclaration> = {};
		for (const modelFile of modelFiles) {
			models[basename(dirname(modelFile))] = yield* importModel(modelFile);
		}
		return models;
	});

/** The newest lineage entry's snapshot, or `undefined` when the workspace has no lineage yet. */
export const latestSnapshot = (
	migrationsRoot: string
): Effect.Effect<WorkspaceSnapshot | undefined, Error> =>
	Effect.gen(function* () {
		const entries = yield* Effect.tryPromise(() =>
			readdir(migrationsRoot, { withFileTypes: true })
		).pipe(Effect.catch(() => Effect.succeed<Array<Dirent>>([])));
		const tags = entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.toSorted();
		for (const tag of tags.toReversed()) {
			const source = yield* Effect.tryPromise(() =>
				readFile(join(migrationsRoot, tag, 'snapshot.json'), 'utf8')
			).pipe(Effect.catch(() => Effect.succeed<string | undefined>(undefined)));
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

export type ValidatedWorkspaceMigrationLineage = Readonly<{
	readonly snapshot: WorkspaceSnapshot;
	readonly mutationCompatibilityLedger: MutationCompatibilityLedger;
}>;

/**
 * Proves that sync is compiling exactly the schema its author committed.
 *
 * This is the read-only half of `bolt migrate`: it runs the same Drizzle diff but never writes a
 * migration, snapshot, compatibility checkpoint, generated module, or artifact. A successful
 * result is therefore safe for sync to reuse as its schema authority; every failure tells the
 * author to run the one command that is allowed to advance that authority.
 */
export const validateWorkspaceMigrationLineage = (
	input: Readonly<{
		readonly workspaceRoot: string;
		readonly models: Readonly<Record<string, ModelDeclaration>>;
		readonly relations: ReadonlyArray<RelationDefinition>;
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
		const mutationCompatibilityLedger = yield* readMutationCompatibilityLedger(input.workspaceRoot);
		if (mutationCompatibilityLedger === undefined) {
			return yield* Effect.fail(
				new Error(
					'Mutation compatibility lineage is missing. Run `bolt migrate` and commit the resulting lineage before `bolt sync`.'
				)
			);
		}

		const pending = yield* planWorkspaceMigration({
			models: input.models,
			relations: input.relations,
			previous: snapshot
		});
		if (pending !== undefined) {
			return yield* Effect.fail(
				new Error(
					`Authored models or relationships do not agree with the latest committed migration snapshot (${pending.statements.length} pending statement${pending.statements.length === 1 ? '' : 's'}). Run \`bolt migrate\` and commit the resulting lineage before \`bolt sync\`.`
				)
			);
		}

		const schema = mutationSchemaDescriptor(snapshot, input.relations);
		const fingerprint = mutationSchemaFingerprint(schema);
		const currentCheckpoint = mutationCompatibilityLedger.checkpoints.find(
			(checkpoint) =>
				checkpoint.schemaFingerprint === mutationCompatibilityLedger.currentSchemaFingerprint
		);
		if (
			mutationCompatibilityLedger.currentSchemaFingerprint !== fingerprint ||
			currentCheckpoint === undefined ||
			mutationSchemaFingerprint(currentCheckpoint.schema) !== fingerprint
		) {
			return yield* Effect.fail(
				new Error(
					'Mutation compatibility lineage does not match the latest committed schema. Run `bolt migrate` and commit the resulting lineage before `bolt sync`.'
				)
			);
		}

		return { snapshot, mutationCompatibilityLedger } satisfies ValidatedWorkspaceMigrationLineage;
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
		const { root, models: modelFiles } = yield* discoverAuthoredSource(workspaceRoot);
		const migrationsRoot = join(root, '.norbital', 'migrations');
		const models = yield* importWorkspaceModels(modelFiles);
		const relationshipSource = yield* Effect.tryPromise(() =>
			readFile(join(root, 'src', 'collections', '+relationship.ts'), 'utf8')
		).pipe(Effect.catch(() => Effect.succeed<string | undefined>(undefined)));
		const previous = yield* latestSnapshot(migrationsRoot);
		const relations =
			relationshipSource === undefined ? [] : extractRelationships(relationshipSource);
		const migration = yield* planWorkspaceMigration({
			models,
			relations,
			previous,
			...(name === undefined ? {} : { name })
		});
		if (migration !== undefined) yield* writeMigration(migrationsRoot, migration);
		const currentSnapshot = migration?.snapshot ?? previous;
		if (currentSnapshot === undefined)
			return yield* Effect.fail(
				new Error('A workspace with authored models did not produce a mutation schema snapshot.')
			);
		const previousCompatibility = yield* readMutationCompatibilityLedger(root);
		const nextCompatibility = advanceMutationCompatibilityLedger({
			previous: previousCompatibility,
			schema: mutationSchemaDescriptor(currentSnapshot, relations),
			statements: migration?.statements ?? [],
			atEpochMs: Date.now()
		});
		const compatibilityLedgerWritten = nextCompatibility !== previousCompatibility;
		if (compatibilityLedgerWritten)
			yield* writeMutationCompatibilityLedger(root, nextCompatibility);
		return migration === undefined
			? { migrationsRoot, statements: [], compatibilityLedgerWritten }
			: {
					migrationsRoot,
					tag: migration.tag,
					statements: migration.statements,
					compatibilityLedgerWritten
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
