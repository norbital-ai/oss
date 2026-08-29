import {
	defineRelations,
	getColumns,
	type AnyRelation,
	type AnyRelations,
	type RelationsRecord
} from 'drizzle-orm';
import { pgTable, text, type PgTable } from 'drizzle-orm/pg-core';
import { SYSTEM_COLUMN_NAMES } from '#lib/authoring/system-row-model.js';
import type { FieldDefinition, WorkspaceDefinition } from '#lib/authoring/workspace-schema.js';

/**
 * The physical columns one collection's rows actually have.
 *
 * A logical reference is not among them and its generated exclusive-arc UUID arms are, which is the
 * only difference between this and the authored field list.
 *
 * Two consumers, one statement. `collectionQueryTable` builds the query descriptor from it, and
 * `access-control.ts` checks an authored grant's row scope against it — because that scope compiles
 * to bare column references evaluated against this very table, so what the descriptor carries is
 * exactly what a grant is entitled to name.
 */
export const physicalColumnNames = (
	fields: Readonly<Record<string, FieldDefinition>>
): ReadonlySet<string> => {
	const names = new Set<string>(SYSTEM_COLUMN_NAMES);
	for (const [field, definition] of Object.entries(fields)) {
		if (definition.reference === undefined) names.add(field);
		else for (const target of definition.reference.targets) names.add(target.storageColumn);
	}
	return names;
};

/**
 * A query-only Drizzle descriptor for one runtime collection.
 *
 * `WorkspaceDefinition` deliberately carries portable field metadata rather than Drizzle builders.
 * Reads need column names, not DDL types, so every physical column is described as text here: the
 * descriptor emits quoted identifiers and bound values but never creates or migrates a table.
 */
export const collectionQueryTable = (
	name: string,
	fields: Readonly<Record<string, FieldDefinition>>
) => {
	const columns = Object.fromEntries(
		[...physicalColumnNames(fields)].map((column) => [column, text()])
	);
	// repository-health:allow DDL1 -- query-only Drizzle descriptor; this call emits no DDL.
	return pgTable(name, columns);
};

/**
 * The workspace's relationships, restated for Drizzle's relational query builder.
 *
 * A workspace declares its edges once, in `+relationship.ts`, and they reach the artifact as
 * `WorkspaceDefinition.relations`. This derives Drizzle's `defineRelations` input from that same
 * list, so authors declare a relationship in one place and both consumers — the schema plan that
 * emits the foreign keys, and the read path that resolves a `with` clause — read the one
 * declaration.
 *
 * Orientation is never assumed. A declaration names its endpoints as `from`/`to` in the order the
 * author wrote them, and a `many` edge routinely carries no endpoints at all because the authoring
 * module put them on the inverse `one` edge. Both readings are resolved against the collection the
 * relation is declared on, by the same resolver the write path uses.
 */

/** The endpoints of a `many` edge, resolved against the collection that declares it. */
export type ManyOrientation = Readonly<{
	readonly parentColumn: string;
	readonly childCollection: string;
	readonly childColumn: string;
}>;

export type RelationalSchemaOptions = Readonly<{
	/** Builds the query descriptor for one collection; the read path shares these instances. */
	readonly table: (
		collection: string,
		fields: Readonly<Record<string, FieldDefinition>>
	) => PgTable;
	/**
	 * Resolves a `many` edge's endpoints.
	 *
	 * Injected rather than reimplemented: `collections.ts` already owns this resolution for the
	 * write path, and a second reading of the same declaration is how the two sides drift apart.
	 */
	readonly resolveMany: (
		definition: WorkspaceDefinition,
		parentCollection: string,
		name: string
	) => ManyOrientation | undefined;
}>;

/**
 * Separates a polymorphic reference's arms, which Drizzle sees as one relation each.
 *
 * `#` cannot occur in an authored relation name or a collection field name, so an arm's key can
 * never collide with a declared relation. The key is a quoted identifier in the emitted SQL — the
 * alias of that arm's lateral join — and the property the hydrator folds back into the logical
 * handle; nothing outside this module and that hydrator reads it.
 *
 * Printable, and deliberately so. This was a control character, which is legal in a JavaScript
 * string, invisible in review, and unusable as the SQL identifier it becomes. It cost two silent
 * failures at once: the emitted alias carried a byte Postgres will not accept in an identifier, and
 * the hydrator looked for a key spelled differently from the one the row came back with — so a
 * hydrated record was dropped and its raw arm survived onto the row. A separator that cannot be
 * seen is a separator that cannot be checked.
 */
const ARM_SEPARATOR = '#';

/** The relation key one arm of a polymorphic reference is declared under. */
export const referenceArmKey = (field: string, tag: string): string =>
	`${field}${ARM_SEPARATOR}${tag}`;

/** Reads which side of a `one` relation holds the foreign key, against the collection declaring it. */
const oneOrientation = (
	relation: WorkspaceDefinition['relations'][number],
	source: string
): Readonly<{ readonly sourceColumn: string; readonly targetColumn: string }> | undefined => {
	const { from, to } = relation;
	if (from === undefined || to === undefined) return undefined;
	if (from.collection === source) return { sourceColumn: from.column, targetColumn: to.column };
	if (to.collection === source) return { sourceColumn: to.column, targetColumn: from.column };
	return undefined;
};

/**
 * `defineRelations`' builder, as a schema assembled at run time can reach it.
 *
 * Drizzle types `r.one`/`r.many` and `r.<table>.<column>` from a schema object literal known at
 * compile time; this one is derived from the artifact, so the table and column names are `string`.
 * What each call *produces* stays exact — `AnyRelation` — which is what `defineRelations` asks its
 * config for, so the config below is typed rather than opaque.
 */
type RelationBuilders = Readonly<{
	readonly one: Readonly<Record<string, ((config: unknown) => AnyRelation) | undefined>>;
	readonly many: Readonly<Record<string, ((config: unknown) => AnyRelation) | undefined>>;
}>;
type ColumnBuilders = Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>>;

/**
 * Builds `defineRelations` input for every collection the workspace declares.
 *
 * An edge whose endpoints cannot be resolved, or that names a collection or column this workspace
 * does not have, is left out. Drizzle refuses a malformed relation by throwing while the layer is
 * being constructed, which would take the whole runtime down for one bad declaration; leaving it
 * out costs exactly the `with` entry that named it, which is what the read path did before.
 */
const relationConfig = (
	definition: WorkspaceDefinition,
	tables: Readonly<Record<string, PgTable>>,
	columnsOf: (collection: string) => ReadonlySet<string>,
	options: RelationalSchemaOptions,
	helpers: RelationBuilders & ColumnBuilders
): Readonly<Record<string, RelationsRecord>> => {
	const config: Record<string, Record<string, AnyRelation>> = {};
	const column = (collection: string, name: string): unknown =>
		(helpers as ColumnBuilders)[collection]?.[name];
	const declare = (collection: string, key: string, relation: AnyRelation | undefined): void => {
		if (relation === undefined) return;
		(config[collection] ??= {})[key] = relation;
	};

	for (const collection of definition.collections) {
		const own = columnsOf(collection.name);
		for (const relation of definition.relations) {
			if (relation.source !== collection.name) continue;
			// Drizzle refuses a relation whose name is also a column of its table, and it is right to:
			// the row would carry one key meaning two things.
			if (own.has(relation.name)) continue;
			if (tables[relation.target] === undefined) continue;

			if (relation.cardinality === 'many') {
				const oriented = options.resolveMany(definition, collection.name, relation.name);
				if (oriented === undefined || oriented.childCollection !== relation.target) continue;
				const from = column(collection.name, oriented.parentColumn);
				const to = column(oriented.childCollection, oriented.childColumn);
				if (from === undefined || to === undefined) continue;
				declare(collection.name, relation.name, helpers.many[relation.target]?.({ from, to }));
				continue;
			}

			const oriented = oneOrientation(relation, collection.name);
			if (oriented === undefined) continue;
			const from = column(collection.name, oriented.sourceColumn);
			const to = column(relation.target, oriented.targetColumn);
			if (from === undefined || to === undefined) continue;
			declare(
				collection.name,
				relation.name,
				helpers.one[relation.target]?.({ from, to, optional: true })
			);
		}

		// A polymorphic reference is one logical column over an exclusive set of physical arms, and
		// each arm is an ordinary foreign key. Declaring one `one` relation per arm is what lets the
		// hydrated record for every target come back in the same statement as the row that names it.
		for (const [field, definitionOfField] of Object.entries(collection.fields)) {
			const reference = definitionOfField.reference;
			if (reference === undefined) continue;
			for (const target of reference.targets) {
				if (tables[target.collection] === undefined) continue;
				const from = column(collection.name, target.storageColumn);
				const to = column(target.collection, 'id');
				if (from === undefined || to === undefined) continue;
				declare(
					collection.name,
					referenceArmKey(field, target.tag),
					helpers.one[target.collection]?.({ from, to, optional: true })
				);
			}
		}
	}
	return config;
};

/** The physical column names one collection's query descriptor carries. */
const tableColumnNames = (table: PgTable): ReadonlySet<string> =>
	new Set(Object.keys(getColumns(table)));

/**
 * The workspace's collections and their relationships, as Drizzle's relational query builder needs
 * them.
 *
 * The tables come from the caller so the relational reads and the ordinary composed selects share
 * one descriptor per collection rather than two that happen to agree.
 */
export const relationalSchema = (
	definition: WorkspaceDefinition,
	options: RelationalSchemaOptions
): AnyRelations => {
	const tables: Record<string, PgTable> = {};
	const columnNames = new Map<string, ReadonlySet<string>>();
	for (const collection of definition.collections) {
		const table = options.table(collection.name, collection.fields);
		tables[collection.name] = table;
		columnNames.set(collection.name, tableColumnNames(table));
	}
	// Two casts, both for the same reason and neither hiding a shape mismatch. `defineRelations` is
	// typed for a schema written as an object literal: the helper it hands the callback keys `one`,
	// `many` and every column off literal table names, and what it returns keys its result off those
	// same literals. This schema is derived from the artifact, so those keys are `string` on both
	// sides. What crosses the boundary is exact — the config's values are `AnyRelation`, which is what
	// `RelationsBuilderConfig` asks for, and the result is the `TablesRelationalConfig` the query
	// builder reads — only the key literals are unavailable.
	return defineRelations(tables, (helpers) =>
		relationConfig(
			definition,
			tables,
			(collection) => columnNames.get(collection) ?? new Set<string>(),
			options,
			helpers as unknown as RelationBuilders & ColumnBuilders
		)
	) as unknown as AnyRelations;
};
