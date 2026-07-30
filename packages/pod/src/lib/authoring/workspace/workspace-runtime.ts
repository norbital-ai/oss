import type { PgTable } from 'drizzle-orm/pg-core';
import type { TablesRelationalConfig } from 'drizzle-orm';
import {
	requireCollectionBehavior,
	type AnyCollectionBehavior
} from '../schema/collection-behavior.js';
import type { TableDeclaration } from '../schema/define-table.js';
import type { AnySchema } from '../schema/types.js';
import type { HandlerDefinition } from '../automations/handlers.js';
import type { WorkspaceClient } from '$lib/client/workspace-client.js';
import { buildWorkspaceApi } from './build-workspace-api.js';
import type { InvokeMap } from './invoke-api-types.js';
import type {
	RegisteredWorkspaceState,
	RuntimeWorkspaceInstance,
	WorkspaceMeta,
	WorkspaceRelationshipMap
} from './define-workspace.js';
import type { RegisteredIntegration } from '../integrations/integrations.js';
import type { WorkspaceSeedDefinition } from '@norbital-ai/platform-utils/seed/plan';
import type { CollectionDefinition } from '@norbital-ai/platform-utils/collection';
import { buildCollectionDefinitions } from '../schema/table.js';

export type RuntimeWorkspaceEnv = {
	readonly public?: Readonly<Record<string, string>>;
	readonly secret?: Readonly<Record<string, string>>;
};

/**
 * Structural shape the runtime reads from the tenant workspace singleton.
 * Collapses {@link WorkspaceInstance} schema/collection generics so runtime
 * consumers avoid `WorkspaceInstance<any, any>` or per-call-site casts.
 */
export type RuntimeWorkspace = {
	readonly schema: AnySchema;
	readonly collections: Readonly<Record<string, AnyCollectionBehavior>>;
	readonly collectionDefinitions: Readonly<Record<string, CollectionDefinition>>;
	readonly tables: Readonly<Record<string, PgTable>>;
	readonly relations: TablesRelationalConfig;
	readonly relationships: WorkspaceRelationshipMap;
	readonly meta?: WorkspaceMeta;
	readonly seed?: WorkspaceSeedDefinition;
	readonly env?: RuntimeWorkspaceEnv;
	/**
	 * The compiled integration definitions, carried so the manifest can name them.
	 *
	 * Dropping these here is not cosmetic: the manifest is the only thing the outbound path consults
	 * to decide a mutation should be queued (`activeOutboundBindings`), and the only thing
	 * `requiredRuntimeFacilities` reads to demand `integrationDelivery` and `queue`. A projection
	 * without them silently turns every declared integration into no rows and no facility check.
	 */
	readonly integrations?: readonly RegisteredIntegration[];
	readonly secrets?: Readonly<
		Record<string, { readonly description: string; readonly required?: boolean }>
	>;
	readonly registered: RegisteredWorkspaceState;
};

/** Minimal structural input accepted from a compiler-generated workspace module. */
export type RuntimeWorkspaceSource = RuntimeWorkspaceInstance;

/**
 * Projects workspace generics into the schema-independent runtime shape.
 * `WorkspaceInstance<S, TCollections>` carries per-schema type parameters that
 * cannot live in a process-wide singleton without `any` at every call site.
 * Runtime shape is unchanged; only compile-time variance is collapsed.
 */
export function toRuntimeWorkspace(ws: RuntimeWorkspaceSource): RuntimeWorkspace {
	return {
		schema: ws.schema,
		collections: Object.fromEntries(
			Object.values(ws.collections).map((behavior) => {
				const runtimeBehavior = requireCollectionBehavior(behavior);
				return [runtimeBehavior.name, runtimeBehavior];
			})
		),
		collectionDefinitions: buildCollectionDefinitions(ws.tables),
		tables: ws.tables,
		relations: ws.relations,
		relationships: ws.relationships,
		meta: ws.meta,
		seed: ws.seed,
		env: ws.env,
		integrations: ws.integrations,
		secrets: ws.secrets,
		registered: ws.registered
	};
}

export type TablesFromDeclarations<T extends readonly TableDeclaration[]> = {
	[K in T[number]['name']]: Extract<T[number], { readonly name: K }>['table'];
};

/** Validated collection behaviors lose per-table generics when assembled at runtime. */
export function toRuntimeBehaviors<const TCollections extends readonly { readonly name: string }[]>(
	collections: TCollections
): readonly AnyCollectionBehavior[] {
	return collections.map(requireCollectionBehavior);
}

export function buildCollectionsRecord<
	const TCollections extends readonly { readonly name: string }[]
>(
	collections: TCollections
): {
	readonly [K in TCollections[number]['name']]: Extract<TCollections[number], { readonly name: K }>;
} {
	// Safe: entries preserve the validated per-table collection behavior types.
	return Object.fromEntries(collections.map((behavior) => [behavior.name, behavior])) as {
		readonly [K in TCollections[number]['name']]: Extract<
			TCollections[number],
			{ readonly name: K }
		>;
	};
}

export function buildTablesFromDeclarations<const T extends readonly TableDeclaration[]>(
	tables: T
): TablesFromDeclarations<T> {
	// Safe: each entry.name maps to its paired declaration table object.
	return Object.fromEntries(
		tables.map((entry) => [entry.name, entry.table])
	) as TablesFromDeclarations<T>;
}

export function buildTypedWorkspaceClient<S extends AnySchema, TInvoke extends InvokeMap>(
	schema: S,
	collectionsRecord: Readonly<Record<string, AnyCollectionBehavior>>,
	remotes: Record<string, HandlerDefinition>
): WorkspaceClient<S, TInvoke> {
	// Safe: buildWorkspaceApi mirrors defineWorkspace assembly; the schema type is compile-time only.
	return buildWorkspaceApi(schema, collectionsRecord, remotes) as WorkspaceClient<S, TInvoke>;
}
