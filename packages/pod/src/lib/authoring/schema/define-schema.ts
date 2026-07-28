import {
	defineRelations as drizzleDefineRelations,
	type ExtractTablesWithRelations,
	type RelationsBuilder,
	type RelationsBuilderConfig,
	type Schema
} from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import {
	buildCollectionBehavior,
	type CollectionAuthoringDef,
	type CollectionBehaviorDef,
	type CollectionBehaviorFromDef,
	type CollectionMutationDef,
	type ResolvedCollectionDef
} from './collection-behavior.js';
import type { TExportManifest } from '../automations/pipelines.js';
import type { z } from 'zod';
import { type TableDeclaration, isTableDeclaration } from './define-table.js';
import { buildInputSchemas, type InputSchemasFor } from './input-schemas.js';
import type { AnySchema, TableName } from './types.js';
import {
	buildTablesFromDeclarations,
	type TablesFromDeclarations as TablesMapFromDeclarations
} from '../workspace/workspace-runtime.js';

type TablesFromDeclarations<T extends readonly TableDeclaration[]> = TablesMapFromDeclarations<T>;

type BuiltSchema<
	TTables extends readonly TableDeclaration[],
	TConfig extends RelationsBuilderConfig<TSchemaTables>,
	TSchemaTables extends Schema = TablesFromDeclarations<TTables>
> = {
	readonly tables: TablesFromDeclarations<TTables>;
	readonly relations: ExtractTablesWithRelations<TConfig, TSchemaTables>;
	readonly inputs: InputSchemasFor<TablesFromDeclarations<TTables>>;
};

export type { BuiltSchema };

export type SchemaBuilder<S extends AnySchema> = S & {
	readonly collection: <
		N extends TableName<S>,
		const TMutation extends CollectionMutationDef,
		TImportSchema extends z.ZodTypeAny = z.ZodUnknown,
		TExport extends TExportManifest = TExportManifest
	>(
		name: N,
		def: CollectionAuthoringDef<S, N, TMutation, TImportSchema, TExport>
	) => CollectionBehaviorFromDef<
		S,
		N,
		ResolvedCollectionDef<S, N, TMutation, TImportSchema, TExport>
	>;
};

const _claimedBySchema = new WeakMap<object, Set<string>>();

function asBuiltSchema<
	TTables extends readonly TableDeclaration[],
	TConfig extends RelationsBuilderConfig<TablesFromDeclarations<TTables>>
>(core: unknown): BuiltSchema<TTables, TConfig> {
	// Safe: tables, relations, and inputs are assembled from the same declaration set.
	return core as BuiltSchema<TTables, TConfig>;
}

function asRegisteredCollectionBehavior<
	S extends AnySchema,
	N extends TableName<S>,
	TDef extends CollectionBehaviorDef<S, N>
>(
	built: CollectionBehaviorFromDef<S, N, CollectionBehaviorDef<S, N>>
): CollectionBehaviorFromDef<S, N, TDef> {
	// Safe: buildCollectionBehavior output matches the declared table/def pair.
	return built as CollectionBehaviorFromDef<S, N, TDef>;
}

function attachCollectionRegistrar<S extends AnySchema>(
	core: S,
	collectionMethod: SchemaBuilder<S>['collection']
): SchemaBuilder<S> {
	// Safe: core schema fields plus collection registrar form the schema builder surface.
	return Object.assign(core, { collection: collectionMethod }) as SchemaBuilder<S>;
}

export function defineSchema<
	const TTables extends readonly TableDeclaration[],
	const TConfig extends RelationsBuilderConfig<TSchemaTables>,
	TSchemaTables extends Record<string, PgTable> = TablesFromDeclarations<TTables> & Record<string, PgTable>
>(
	tables: TTables,
	relationsBuilder: (helpers: RelationsBuilder<TSchemaTables>) => TConfig,
	platformTables?: Readonly<Record<string, PgTable>>
): SchemaBuilder<BuiltSchema<TTables, TConfig>> {
	for (const entry of tables) {
		if (!isTableDeclaration(entry)) {
			throw new Error('defineSchema tables must come from defineTable()');
		}
	}

	const tenantTables = buildTablesFromDeclarations(tables);
	const tablesMap = { ...platformTables, ...tenantTables };
	const relations = drizzleDefineRelations(tablesMap, relationsBuilder);
	const inputs = buildInputSchemas(tenantTables);

	const schemaCore = asBuiltSchema<TTables, TConfig>({ tables: tenantTables, relations, inputs });
	const claimed = new Set<string>();
	_claimedBySchema.set(schemaCore, claimed);

	return attachCollectionRegistrar(schemaCore, function collection<
		N extends TableName<typeof schemaCore>,
		const TMutation extends CollectionMutationDef,
		TImportSchema extends z.ZodTypeAny = z.ZodUnknown,
		TExport extends TExportManifest = TExportManifest
	>(name: N, def: CollectionAuthoringDef<typeof schemaCore, N, TMutation, TImportSchema, TExport>): CollectionBehaviorFromDef<
		typeof schemaCore,
		N,
		ResolvedCollectionDef<typeof schemaCore, N, TMutation, TImportSchema, TExport>
	> {
		if (!(name in tablesMap)) {
			throw new Error(`Unknown table "${String(name)}" — not in defineSchema tables`);
		}
		if (claimed.has(name)) {
			throw new Error(`Collection "${String(name)}" is already registered on this schema`);
		}
		claimed.add(name);
		return asRegisteredCollectionBehavior(buildCollectionBehavior(schemaCore, name, def));
	}) as SchemaBuilder<BuiltSchema<TTables, TConfig>>;
}
