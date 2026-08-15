import {
	defineRelations as drizzleDefineRelations,
	getTableColumns,
	type RelationsBuilder,
	type RelationsBuilderConfig
} from 'drizzle-orm';
import { foreignKey, type PgTable } from 'drizzle-orm/pg-core';
import type { CollectionType } from '@norbital-ai/platform-utils/collection';
import type { z } from 'zod';
import { resolveCustomTypeSchema, type AnyCustomTypeDefinition } from './custom-type.js';
import { defineSchema, type BuiltSchema, type SchemaBuilder } from './schema/define-schema.js';
import { defineTable, type TableDeclaration } from './schema/define-table.js';
import type { MutationInsertFor, MutationUpdateFor } from './schema/input-schemas.js';
import type { AnySchema, SchemaRow, TableName } from './schema/types.js';
import {
	deriveManifestRelationships,
	RELATIONSHIP_ON_DELETE
} from './workspace/derive-relationships.js';
import { buildTablesFromDeclarations } from './workspace/workspace-runtime.js';
import { bindColumnCustomSchema, readBuilderCustom } from './schema/columns.js';
import {
	type InferTableSelect,
	type NorbitalColumns,
	type NorbitalTable,
	type TableExclusion,
	type TableIndex,
	type TableMeta
} from './schema/table.js';

export type ModelMetadata = {
	readonly description?: string;
	readonly recordLabel?: string | readonly string[];
	readonly icon?: string;
	/**
	 * Whether this collection keeps a typed `<collection>_history` temporal relation, so every
	 * revision of every row stays queryable. Defaults to true.
	 *
	 * Opt out only for a high-volume, append-only collection whose rows are already ordered by their
	 * own sequence — a transcript, an event log — where the history row roughly doubles the write
	 * cost of every insert to buy a revision trail nothing reads.
	 *
	 * Turning this off on a collection that already has a history relation drops that relation, and
	 * the revisions in it, in the next generated migration. Turning it back on starts a fresh one.
	 */
	readonly history?: boolean;
	/** Whether writes must go through `collection_ops`. Defaults to true for tenant collections. */
	readonly opsGuard?: boolean;
	/** Whether `_approval_lock_gate` attaches. Defaults to true. */
	readonly approvalLock?: boolean;
	/** Whether the collection is included in the client replica DDL. Defaults to true. */
	readonly replica?: boolean;
	/** Whether UPDATE/DELETE are rejected. Defaults to false. */
	readonly insertOnly?: boolean;
	readonly indexes?: readonly TableIndex[];
	/** Postgres EXCLUDE constraints, emitted out-of-band (drizzle cannot express them). */
	readonly exclusions?: readonly TableExclusion[];
};

export type ModelDeclaration<TColumns extends NorbitalColumns = NorbitalColumns> = {
	readonly __kind: 'model';
	readonly columns: TColumns;
	readonly metadata?: ModelMetadata;
};

export function defineModel<const TColumns extends NorbitalColumns>(
	columns: TColumns,
	metadata?: ModelMetadata
): ModelDeclaration<TColumns> {
	return {
		__kind: 'model',
		columns,
		metadata
	};
}

/** Mark a direct child relationship as parent-owned. Unmarked foreign keys remain restrictive. */
export function cascade<const TRelationship extends object>(
	relationship: TRelationship
): TRelationship {
	Object.defineProperty(relationship, RELATIONSHIP_ON_DELETE, {
		value: 'cascade',
		enumerable: false
	});
	return relationship;
}

export type ModelsDefinition = Readonly<Record<string, ModelDeclaration>>;

type HookMutationInput<THooks, TKind extends 'create' | 'update', TFallback> =
	THooks extends Record<TKind, infer TSection>
		? TSection extends { readonly input: infer TInput }
			? TInput extends z.ZodType
				? z.output<TInput>
				: TFallback
			: TFallback
		: TFallback;

export type CollectionRegistryFor<
	S extends AnySchema,
	THooks extends Readonly<Partial<Record<TableName<S>, unknown>>> = Readonly<
		Partial<Record<TableName<S>, unknown>>
	>
> = {
	readonly [N in TableName<S>]: CollectionType<
		SchemaRow<S, N>,
		HookMutationInput<THooks[N], 'create', MutationInsertFor<S, N>>,
		HookMutationInput<THooks[N], 'update', MutationUpdateFor<S, N>>
	>;
};

export function defineModels<const TModels extends ModelsDefinition>(models: TModels): TModels {
	for (const [name, model] of Object.entries(models)) {
		if (model.__kind !== 'model') {
			throw new Error(`Model "${name}" must come from defineModel()`);
		}
	}
	return models;
}

type ModelColumns<TModel extends ModelDeclaration> =
	TModel extends ModelDeclaration<infer TColumns> ? TColumns : never;

export type TablesForModels<TModels extends ModelsDefinition> = {
	readonly [K in keyof TModels & string]: NorbitalTable<
		K,
		InferTableSelect<ModelColumns<TModels[K]>>
	>;
};

export type RelationshipsFor<TModels extends ModelsDefinition> = (
	helpers: RelationsBuilder<TablesForModels<TModels>>
) => RelationsBuilderConfig<TablesForModels<TModels>>;

/** Like RelationshipsFor but includes platform identity tables so tenant collections can FK to user, team, and team_members. */
export type PlatformRelationshipsFor<TModels extends ModelsDefinition> = (
	helpers: RelationsBuilder<TablesForModels<TModels> & Record<string, PgTable>>
) => RelationsBuilderConfig<TablesForModels<TModels> & Record<string, PgTable>>;

type ModelName<TModels extends ModelsDefinition> = keyof TModels & string;

type TableDeclarationForModels<
	TModels extends ModelsDefinition,
	TName extends ModelName<TModels> = ModelName<TModels>
> =
	TName extends ModelName<TModels>
		? TableDeclaration<TName, InferTableSelect<ModelColumns<TModels[TName]>>>
		: never;

type TableDeclarationsForModels<TModels extends ModelsDefinition> =
	readonly TableDeclarationForModels<TModels>[];

type RegistryFor<
	TModels extends ModelsDefinition,
	TConfig extends RelationsBuilderConfig<TablesForModels<TModels>>
> = SchemaBuilder<
	BuiltSchema<TableDeclarationsForModels<TModels>, TConfig, TablesForModels<TModels>>
>;

function modelTableMeta(metadata: ModelMetadata | undefined): TableMeta | undefined {
	if (!metadata) return undefined;
	const recordLabel = metadata.recordLabel;
	const labelFields = typeof recordLabel === 'string' ? [recordLabel] : recordLabel;
	return {
		description: metadata.description,
		record_label: labelFields?.map((field) => `scope.record.${field}`).join(" + ' · ' + "),
		icon: metadata.icon,
		history: metadata.history,
		opsGuard: metadata.opsGuard,
		approvalLock: metadata.approvalLock,
		replica: metadata.replica,
		insertOnly: metadata.insertOnly,
		indexes: metadata.indexes,
		exclusions: metadata.exclusions
	};
}

function materializeModel<const TName extends string, const TColumns extends NorbitalColumns>(
	name: TName,
	model: ModelDeclaration<TColumns>,
	foreignKeys: readonly RelationshipForeignKey[] = [],
	finalTables: Readonly<Record<string, PgTable>> = {}
): TableDeclaration<TName, InferTableSelect<TColumns>> {
	const meta = modelTableMeta(model.metadata);
	if (foreignKeys.length > 0) {
		return defineTable(
			name,
			model.columns,
			(self) => [
				...foreignKeys.map((relationship) => {
					const target = finalTables[relationship.to];
					if (!target) throw new Error(`Unknown relationship target "${relationship.to}"`);
					const targetColumns = getTableColumns(target);
					const mappedColumns = relationship.fromFields.map((field) => {
						const column = self[field];
						if (!column) throw new Error(`Unknown relationship field "${name}.${field}"`);
						return column;
					});
					const mappedForeignColumns = relationship.toFields.map((field) => {
						const column = targetColumns[field];
						if (!column)
							throw new Error(`Unknown relationship target field "${relationship.to}.${field}"`);
						return column;
					});
					const [firstColumn, ...remainingColumns] = mappedColumns;
					const [firstForeignColumn, ...remainingForeignColumns] = mappedForeignColumns;
					if (!firstColumn || !firstForeignColumn)
						throw new Error(`Relationship "${name}" requires at least one field`);
					const constraint = foreignKey({
						columns: [firstColumn, ...remainingColumns],
						foreignColumns: [firstForeignColumn, ...remainingForeignColumns],
						name: `${name}_${relationship.fromFields.join('_')}_${relationship.to}_fk`
					});
					return relationship.onDelete ? constraint.onDelete(relationship.onDelete) : constraint;
				})
			],
			meta
		);
	}
	return meta ? defineTable(name, model.columns, meta) : defineTable(name, model.columns);
}

interface RelationshipForeignKey {
	readonly to: string;
	readonly fromFields: readonly string[];
	readonly toFields: readonly string[];
	readonly onDelete?: 'cascade';
}

function relationshipForeignKeys(
	relationships: ReturnType<typeof deriveManifestRelationships>
): Readonly<Record<string, readonly RelationshipForeignKey[]>> {
	const byCollection: Record<string, RelationshipForeignKey[]> = {};
	const seen = new Set<string>();
	for (const relationship of Object.values(relationships)) {
		const fromFields = relationship.from_fields ?? [];
		const toFields = relationship.to_fields ?? [];
		if (
			fromFields.length === 0 ||
			fromFields.length !== toFields.length ||
			relationship.to_is_array
		)
			continue;
		const key = `${relationship.from}:${fromFields.join(',')}:${relationship.to}:${toFields.join(',')}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const collectionForeignKeys = byCollection[relationship.from] ?? [];
		collectionForeignKeys.push({
			to: relationship.to,
			fromFields,
			toFields,
			onDelete: relationship.on_delete
		});
		byCollection[relationship.from] = collectionForeignKeys;
	}
	return byCollection;
}

export function defineRegistry<
	const TModels extends ModelsDefinition,
	const TConfig extends RelationsBuilderConfig<TablesForModels<TModels>>,
	const TCustomTypes extends Readonly<Record<string, AnyCustomTypeDefinition>> = Readonly<
		Record<never, never>
	>
>(input: {
	readonly models: TModels;
	readonly relationships: (
		helpers: RelationsBuilder<TablesForModels<TModels> & Record<string, PgTable>>
	) => TConfig;
	readonly customTypes?: TCustomTypes;
	readonly platformTables?: Readonly<Record<string, PgTable>>;
}): RegistryFor<TModels, TConfig> {
	const customTypes: Readonly<Record<string, AnyCustomTypeDefinition>> = input.customTypes ?? {};
	const platform = input.platformTables ?? {};

	for (const [name, definition] of Object.entries(customTypes)) {
		if (definition.name !== name) {
			throw new Error(
				`Custom type definition name "${definition.name}" does not match directory name "${name}".`
			);
		}
	}
	for (const [modelName, model] of Object.entries(input.models)) {
		for (const [columnName, builder] of Object.entries(model.columns)) {
			const metadata = readBuilderCustom(builder);
			if (!metadata || !('definitionBacked' in metadata)) continue;
			const definition = customTypes[metadata.kind];
			if (!definition) {
				throw new Error(
					`Custom type ${metadata.kind} used by ${modelName}.${columnName} has no bound definition schema.`
				);
			}
			bindColumnCustomSchema(builder, resolveCustomTypeSchema(definition, metadata.options));
		}
	}
	const provisionalDeclarations = Object.entries(input.models).map(([name, model]) =>
		materializeModel(name, model)
	) as unknown as TableDeclarationsForModels<TModels>; // stupidity: boundary-cast — Object.entries erases the model key paired with each materialized Drizzle table.
	const provisionalTables: Record<string, PgTable> = {
		...platform,
		...buildTablesFromDeclarations(provisionalDeclarations)
	};
	const provisionalRelations = drizzleDefineRelations(
		provisionalTables,
		// stupidity:allow R3b -- Drizzle's invariant builder parameter cannot express the platform-table widening at this non-data framework boundary.
		input.relationships as unknown as (
			helpers: RelationsBuilder<Record<string, PgTable>>
		) => RelationsBuilderConfig<Record<string, PgTable>>
	);
	const foreignKeys = relationshipForeignKeys(deriveManifestRelationships(provisionalRelations));
	const finalTables: Record<string, PgTable> = { ...platform };
	const tables = Object.entries(input.models).map(([name, model]) => {
		const declaration = materializeModel(name, model, foreignKeys[name], finalTables);
		finalTables[name] = declaration.table;
		return declaration;
	}) as unknown as TableDeclarationsForModels<TModels>; // stupidity: boundary-cast — Object.entries erases the model key paired with each materialized Drizzle table.

	return defineSchema<TableDeclarationsForModels<TModels>, TConfig, TablesForModels<TModels>>(
		tables,
		input.relationships,
		platform
	) as unknown as RegistryFor<TModels, TConfig>; // stupidity: boundary-cast — defineSchema materializes this exact keyed Drizzle table map, but its declaration-array projection loses mapped-key correlation.
}

/**
 * Runtime-only registry materialization for compiler-generated tenant modules.
 *
 * The compiler emits tenant row and query types separately, so a tenant checker
 * does not need to instantiate Drizzle's complete relational generic graph just
 * to type a runtime value.
 */
export function defineRuntimeRegistry(input: {
	readonly models: ModelsDefinition;
	readonly relationships: unknown;
	readonly customTypes?: Readonly<Record<string, AnyCustomTypeDefinition>>;
	readonly platformTables?: Readonly<Record<string, PgTable>>;
}): AnySchema & {
	readonly collection: (name: string, definition: unknown) => unknown;
} {
	return defineRegistry({
		models: input.models,
		relationships: input.relationships as (
			helpers: RelationsBuilder<TablesForModels<ModelsDefinition> & Record<string, PgTable>>
		) => RelationsBuilderConfig<TablesForModels<ModelsDefinition>>,
		customTypes: input.customTypes,
		platformTables: input.platformTables
	}) as AnySchema & {
		readonly collection: (name: string, definition: unknown) => unknown;
	};
}

/** Merge authored collection facets at the erased generated-runtime boundary. */
export function defineRuntimeCollection(
	registry: { readonly collection: (name: string, definition: unknown) => unknown },
	name: string,
	definitions: readonly unknown[]
): unknown {
	const definition = Object.assign(
		{},
		...definitions.filter((value): value is object => typeof value === 'object' && value !== null)
	);
	return registry.collection(name, definition);
}

export type GroupDefinition = {
	readonly label: string;
	/**
	 * What the applications under this group are collectively for.
	 *
	 * Required, and carried into the manifest as the group's app entry: a group is a first-class row
	 * in the studio's application list, and one that says only "HR Controller" leaves a reader to
	 * infer the whole of it from an icon.
	 */
	readonly description: string;
	readonly icon: string;
	/** Child app key used when navigating to the group itself. */
	readonly defaultChild?: string;
};

export function group<const TGroup extends GroupDefinition>(definition: TGroup): TGroup {
	return definition;
}
