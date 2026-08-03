import {
	defineModels,
	defineRegistry,
	defineRuntimeCollection,
	defineRuntimeRegistry,
	type CollectionRegistryFor,
	type GroupDefinition,
	type ModelsDefinition,
	type PlatformRelationshipsFor,
	type RelationshipsFor,
	type TablesForModels
} from './filesystem.js';
import type { InputValuesForTables, MutationInsertFor } from './schema/mutation-types.js';
import {
	defineRuntimeWorkspace,
	defineWorkspace,
	type WorkspaceAppDef,
	type WorkspaceCollectionRegistry
} from './workspace/define-workspace.js';
import { platformIdentityTables, type PlatformSchema } from './schema/system-workspace.js';
import type { InvokeClientApi, InvokeMap } from './workspace/invoke-api-types.js';

export {
	defineModels,
	defineRegistry,
	defineRuntimeCollection,
	defineRuntimeRegistry,
	defineRuntimeWorkspace,
	defineWorkspace,
	platformIdentityTables
};
export type {
	CollectionRegistryFor,
	GroupDefinition,
	ModelsDefinition,
	PlatformRelationshipsFor,
	RelationshipsFor,
	TablesForModels,
	InputValuesForTables,
	MutationInsertFor,
	WorkspaceAppDef,
	WorkspaceCollectionRegistry
};
export type { PlatformSchema };
export type { InvokeClientApi, InvokeMap };
