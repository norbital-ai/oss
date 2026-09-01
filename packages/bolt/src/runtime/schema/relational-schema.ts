import {
	defineRelations,
	getColumns,
	type AnyRelation,
	type AnyRelations,
	type RelationsRecord
} from 'drizzle-orm';
import { pgTable, text, type PgTable } from 'drizzle-orm/pg-core';
import { SYSTEM_COLUMN_NAMES } from '../../authoring/system-row-model.js';
import type { FieldDefinition, WorkspaceDefinition } from '../../authoring/workspace-schema.js';

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


type ManyOrientation = Readonly<{
	readonly parentColumn: string;
	readonly childCollection: string;
	readonly childColumn: string;
}>;

type RelationalSchemaOptions = Readonly<{
	readonly table: (
		collection: string,
		fields: Readonly<Record<string, FieldDefinition>>
	) => PgTable;
	readonly resolveMany: (
		definition: WorkspaceDefinition,
		parentCollection: string,
		name: string
	) => ManyOrientation | undefined;
}>;

const ARM_SEPARATOR = '#';

export const referenceArmKey = (field: string, tag: string): string =>
	`${field}${ARM_SEPARATOR}${tag}`;

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

type RelationBuilders = Readonly<{
	readonly one: Readonly<Record<string, ((config: unknown) => AnyRelation) | undefined>>;
	readonly many: Readonly<Record<string, ((config: unknown) => AnyRelation) | undefined>>;
}>;
type ColumnBuilders = Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>>;

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

const tableColumnNames = (table: PgTable): ReadonlySet<string> =>
	new Set(Object.keys(getColumns(table)));

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
