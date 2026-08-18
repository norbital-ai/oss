import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Effect } from 'effect';
import { getTableColumns, sql } from 'drizzle-orm';
import {
	customType,
	foreignKey,
	index,
	integer,
	pgTable,
	timestamp,
	uniqueIndex,
	uuid,
	type AnyPgColumnBuilder,
	type ExtraConfigColumn,
	type PgTable
} from 'drizzle-orm/pg-core';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api-postgres';
import { collectionSearchTrigramIndexName } from '@norbital-ai/std/collection';
import { describeModelColumns, searchableColumns } from '../authoring/model-introspection.js';
import type { ModelDeclaration, ModelIndex } from '../authoring/models-schema.js';
import type { RelationDefinition, WorkspaceMigrationEntry } from '../authoring/workspace-schema.js';
import { extractRelationships } from './model-fields.js';
import { collectionIndexName } from './schema-plan.js';
import { STATEMENT_BREAKPOINT, discoverAuthoredSource } from './sync.js';

/**
 * Drizzle-driven schema migration.
 *
 * `buildSchemaPlan` can only ever say `create table if not exists`: it renders the current shape and
 * has nothing to compare it against, so a column removed from a model stays in the database forever.
 * Migration is a *difference* between two shapes, and Drizzle already models both halves — authored
 * models are Drizzle column builders, and drizzle-kit can serialise a schema to a snapshot and diff
 * two snapshots into DDL.
 *
 * The diff runs in this process through `drizzle-kit/api-postgres`. The legacy generator wrote a
 * throwaway config file and shelled out to `drizzle-kit generate`; Bolt may not even import
 * `node:child_process` (see `quality/audit.ts`), and the subprocess bought nothing but a TTY prompt
 * that could not be answered in CI.
 */

/** drizzle-kit's own snapshot shape, taken from the function that produces it rather than restated. */
export type WorkspaceSnapshot = Awaited<ReturnType<typeof generateDrizzleJson>>;

/**
 * A generated lineage entry: what the artifact carries, plus the snapshot only the generator uses.
 *
 * Built on `WorkspaceMigrationEntry` rather than restating `tag` and `statements`, so the shape the
 * host applies and the shape this writes to disk cannot drift apart.
 */
export type WorkspaceMigration = WorkspaceMigrationEntry & Readonly<{ readonly snapshot: WorkspaceSnapshot }>;

/**
 * The columns every collection table carries.
 *
 * The same six `schema-plan.ts` writes into its `create table if not exists`, because the plan and
 * this generator create the same tables and a database gets whichever ran first. They are kept in
 * step by `SYSTEM_COLUMN_DEFINITIONS` there and this list here saying the same thing; the tests in
 * `tests/compiler/schema-migrations.test.ts` are what hold the two to it.
 *
 * Rebuilt per table because a Drizzle column builder is mutable and carries the name it was bound
 * under.
 */
const systemColumns = (): Readonly<Record<string, AnyPgColumnBuilder>> => ({
	norbital_id: uuid().primaryKey().defaultRandom(),
	norbital_created_at: timestamp({ withTimezone: true }).defaultNow(),
	norbital_updated_at: timestamp({ withTimezone: true }).defaultNow(),
	norbital_sys_period: customType<{ data: string; driverData: string }>({ dataType: () => 'tstzrange' })()
		.notNull()
		.default(sql`tstzrange(CURRENT_TIMESTAMP, NULL, '[)')`),
	norbital_row_version: integer().default(1),
	norbital_approval_id: uuid()
});

/** Renders one authored index declaration as the Drizzle index the snapshot compares against. */
const authoredIndex = (
	collectionName: string,
	self: Readonly<Record<string, ExtraConfigColumn>>,
	declaration: ModelIndex
) => {
	const members = declaration.columns.map((member) => {
		if (typeof member !== 'string') return sql.raw(member.expr);
		const column = self[member];
		if (column === undefined) throw new Error(`Unknown index column "${collectionName}.${member}"`);
		const opclass = declaration.opclass?.[member];
		return opclass === undefined ? column : column.op(opclass);
	});
	const [first, ...rest] = members;
	if (first === undefined) throw new Error(`Index on "${collectionName}" must declare at least one column`);
	const builder = declaration.unique === true ? uniqueIndex(declaration.name) : index(declaration.name);
	const built = declaration.method === undefined ? builder.on(first, ...rest) : builder.using(declaration.method, first, ...rest);
	return declaration.where === undefined ? built : built.where(sql.raw(declaration.where));
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
	columns: Readonly<Record<string, AnyPgColumnBuilder>>,
	self: Readonly<Record<string, ExtraConfigColumn>>
) =>
	Object.entries(describeModelColumns(columns))
		.filter(([, field]) => field.indexed)
		.map(([columnName]) => columnName)
		.toSorted()
		.map((columnName) => {
			const column = self[columnName];
			if (column === undefined) throw new Error(`Unknown indexed column "${collectionName}.${columnName}"`);
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
	columns: Readonly<Record<string, AnyPgColumnBuilder>>,
	self: Readonly<Record<string, ExtraConfigColumn>>
) =>
	searchableColumns(describeModelColumns(columns)).map((columnName) => {
		const column = self[columnName];
		if (column === undefined) throw new Error(`Unknown searchable column "${collectionName}.${columnName}"`);
		return index(collectionSearchTrigramIndexName(collectionName, columnName)).using('gin', column.op('gin_trgm_ops'));
	});

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
		throw new Error(`Relation "${relation.name}" targets a collection this workspace does not declare`);
	}
	const column = self[from.column];
	const foreignColumn = getTableColumns(target)[to.column];
	if (column === undefined || foreignColumn === undefined) {
		throw new Error(`Relation "${relation.name}" names a column no collection declares`);
	}
	return foreignKey({
		columns: [column],
		foreignColumns: [foreignColumn],
		name: `${from.collection}_${from.column}_${to.collection}_fk`
	});
};

/** The Drizzle tables a workspace's authored models describe, as drizzle-kit serialises them. */
export const workspaceMigrationTables = (
	models: Readonly<Record<string, ModelDeclaration>>,
	relations: ReadonlyArray<RelationDefinition>
): Readonly<Record<string, PgTable>> => {
	const byCollection = foreignKeyRelations(relations);
	const tables: Record<string, PgTable> = {};
	for (const [name, model] of Object.entries(models)) {
		tables[name] = pgTable(name, { ...systemColumns(), ...model.columns }, (self) => [
			...(model.metadata?.indexes ?? []).map((declaration) => authoredIndex(name, self, declaration)),
			...declaredIndexes(name, model.columns, self),
			...searchIndexes(name, model.columns, self),
			// Read when Drizzle asks for the table config rather than now, so a relation may point at a
			// collection declared later in the same pass.
			...(byCollection.get(name) ?? []).map((relation) => authoredForeignKey(relation, self, tables))
		]);
	}
	return tables;
};

/** drizzle-kit v1 names a lineage entry `<UTC timestamp>_<name>`; a synthesized one has to match. */
export const migrationTag = (name: string, at = new Date()): string =>
	`${at.toISOString().replace(/[-:T]/g, '').slice(0, 14)}_${name}`;

/**
 * Diffs the authored models against the previous snapshot and returns the migration, or `undefined`
 * when the two already agree.
 *
 * An empty diff is the only honest "nothing to do" signal, which is why this carries no fingerprint
 * cache: the legacy path kept one to avoid paying for a subprocess, and a cache that disagrees with
 * the schema is how a changed column reaches the client with no migration behind it.
 */
export const planWorkspaceMigration = (input: {
	readonly models: Readonly<Record<string, ModelDeclaration>>;
	readonly relations: ReadonlyArray<RelationDefinition>;
	readonly previous: WorkspaceSnapshot | undefined;
	readonly name?: string;
	readonly at?: Date;
}) =>
	Effect.gen(function* () {
		const tables = workspaceMigrationTables(input.models, input.relations);
		// The previous snapshot is used whole. It used to be filtered to the tables the current models
		// declare, so that a lineage written by Pod — whose snapshot also carried its platform identity
		// tables — did not diff into a `DROP TABLE` for each. Every lineage is Bolt's own now, and against
		// one the filter had exactly one remaining effect: a collection deleted from the workspace is not
		// in the current models either, so it was stripped from both sides of the diff and no `DROP TABLE`
		// was ever generated for it. The table stayed in the database forever, which is the bug the
		// differ exists to fix.
		const previous = input.previous ?? (yield* Effect.promise(() => generateDrizzleJson({})));
		const snapshot = yield* Effect.promise(() => generateDrizzleJson(tables, previous.id));
		const statements = yield* Effect.promise(() => generateMigration(previous, snapshot));
		if (statements.length === 0) return undefined;
		return { tag: migrationTag(input.name ?? 'auto', input.at), statements, snapshot };
	});

/**
 * Imports one authored `+model.ts` for its declaration.
 *
 * The declaration is the authority — reading the source text recovers a builder's name and nothing
 * of what it was configured with — so the module is imported rather than scraped, and a module that
 * cannot be imported is fatal rather than skipped.
 */
const importModel = (modelFile: string) =>
	Effect.tryPromise({
		try: () => import(pathToFileURL(modelFile).href),
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
			const declaration = module !== null && typeof module === 'object' ? Reflect.get(module, 'default') : undefined;
			if (declaration === null || typeof declaration !== 'object' || Reflect.get(declaration, '__kind') !== 'model') {
				return Effect.fail(new Error(`${modelFile} does not default-export a defineModel() declaration`));
			}
			return Effect.succeed(declaration as ModelDeclaration);
		})
	);

/** The newest lineage entry's snapshot, or `undefined` when the workspace has no lineage yet. */
export const latestSnapshot = (migrationsRoot: string) =>
	Effect.gen(function* () {
		const entries = yield* Effect.tryPromise(() => readdir(migrationsRoot, { withFileTypes: true })).pipe(
			Effect.catch(() => Effect.succeed([] as Array<Dirent>))
		);
		const tags = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).toSorted();
		for (const tag of tags.toReversed()) {
			const source = yield* Effect.tryPromise(() => readFile(join(migrationsRoot, tag, 'snapshot.json'), 'utf8')).pipe(
				Effect.catch(() => Effect.succeed(undefined as string | undefined))
			);
			if (source !== undefined) return JSON.parse(source) as WorkspaceSnapshot;
		}
		return undefined;
	});

export type MigrationResult = Readonly<{
	readonly migrationsRoot: string;
	readonly tag?: string;
	readonly statements: ReadonlyArray<string>;
}>;

/**
 * Generates the next lineage entry for a workspace on disk.
 *
 * Writes `<migrations>/<tag>/{migration.sql,snapshot.json}` — the layout the lineage already uses,
 * so the entries already there stay applicable and this one joins them. It does not apply anything.
 */
export const generateWorkspaceMigration = (
	workspaceRoot: string,
	name?: string
) =>
	Effect.gen(function* () {
		// Discovery is `sync`'s, not a second walk: a migration must cover exactly the collections the
		// compiler emits, and two rules for "what is a collection" would eventually disagree.
		const { root, models: modelFiles } = yield* discoverAuthoredSource(workspaceRoot);
		const migrationsRoot = join(root, '.norbital', 'migrations');
		const models: Record<string, ModelDeclaration> = {};
		// stupidity:allow A6 -- imported one at a time so a module that fails names itself
		for (const modelFile of modelFiles) {
			models[basename(dirname(modelFile))] = yield* importModel(modelFile);
		}
		const relationshipSource = yield* Effect.tryPromise(() =>
			readFile(join(root, 'src', 'collections', '+relationship.ts'), 'utf8')
		).pipe(Effect.catch(() => Effect.succeed(undefined as string | undefined)));
		const migration = yield* planWorkspaceMigration({
			models,
			relations: relationshipSource === undefined ? [] : extractRelationships(relationshipSource),
			previous: yield* latestSnapshot(migrationsRoot),
			...(name === undefined ? {} : { name })
		});
		if (migration === undefined) return { migrationsRoot, statements: [] };
		yield* writeMigration(migrationsRoot, migration);
		return { migrationsRoot, tag: migration.tag, statements: migration.statements };
	});

/** Writes one lineage entry in the layout drizzle-kit and the existing migrations already use. */
export const writeMigration = (
	migrationsRoot: string,
	migration: WorkspaceMigration
) =>
	Effect.gen(function* () {
		const directory = join(migrationsRoot, migration.tag);
		yield* Effect.tryPromise(() => mkdir(directory, { recursive: true }));
		yield* Effect.tryPromise(() =>
			writeFile(join(directory, 'migration.sql'), `${migration.statements.join(`\n${STATEMENT_BREAKPOINT}\n`)}\n`, 'utf8')
		);
		yield* Effect.tryPromise(() =>
			writeFile(join(directory, 'snapshot.json'), `${JSON.stringify(migration.snapshot, null, 2)}\n`, 'utf8')
		);
	});
