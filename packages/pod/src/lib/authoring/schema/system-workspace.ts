import type { TablesRelationalConfig } from 'drizzle-orm';
import { buildInputSchemas } from './input-schemas.js';
import type { AnySchema } from './types.js';
import { deriveManifestRelationships } from '../workspace/derive-relationships.js';
import type {
	ManifestCollectionEntry,
	NorbitalManifest
} from '@norbital-ai/platform-utils/manifest/types';
import {
	MANIFEST_VERSION,
	parseNorbitalManifest
} from '@norbital-ai/platform-utils/manifest/parse';
import {
	getSystemTableMeta,
	platformRelations,
	platformTables,
	systemTables
} from '@norbital-ai/platform-utils/system/workspace-schema';
import {
	SYSTEM_COLLECTION_NAMES,
	type SystemCollectionName
} from '@norbital-ai/platform-utils/system/collections';

export const systemWorkspace = systemTables;

/** Subset of platform tables that tenant collections can define FK relationships to. */
export const platformIdentityTables = {
	user: platformTables.user,
	team: platformTables.team,
	team_members: platformTables.team_members
} as const;

/** Platform collections — merged with tenant schema in defineWorkspace. */
export const platformSchema = {
	tables: platformTables,
	relations: platformRelations as TablesRelationalConfig,
	inputs: buildInputSchemas(platformTables)
} satisfies AnySchema;

export type PlatformSchema = typeof platformSchema;

export type PlatformCollectionName = keyof PlatformSchema['tables'] & string;

type TenantOnlyTables<S extends AnySchema> = Pick<
	S['tables'],
	Exclude<keyof S['tables'], keyof PlatformSchema['tables']>
>;

export function mergePlatformSchema<S extends AnySchema>(tenant: S) {
	return {
		tables: { ...platformSchema.tables, ...tenant.tables },
		relations: { ...platformSchema.relations, ...tenant.relations },
		inputs: { ...platformSchema.inputs, ...tenant.inputs }
	};
}

export type MergedWorkspaceSchema<S extends AnySchema> = {
	readonly tables: PlatformSchema['tables'] & TenantOnlyTables<S>;
	readonly relations: PlatformSchema['relations'] & S['relations'];
	readonly inputs: PlatformSchema['inputs'] & S['inputs'];
};

export { MANIFEST_VERSION, parseNorbitalManifest };

function systemCollectionEntry(name: SystemCollectionName): ManifestCollectionEntry {
	const meta = getSystemTableMeta(systemTables[name].table);
	return {
		collection_name: name,
		description: meta?.description ?? null,
		record_label: meta?.record_label ?? null,
		icon: meta?.icon ?? null,
		extensions: { indexes: [] },
		enabled_semantic_search: meta?.semanticSearch ?? null,
		hooks: {},
		pipelines: {},
		system: true
	};
}

/** Platform baseline: system collections, junction tables, empty apps/env. */
export const emptyNorbitalManifest: NorbitalManifest = {
	version: MANIFEST_VERSION,
	collections: Object.fromEntries(
		SYSTEM_COLLECTION_NAMES.map((name) => [name, systemCollectionEntry(name)])
	) as NorbitalManifest['collections'],
	relationships: deriveManifestRelationships(platformRelations),
	apps: {},
	automations: {},
	env: { public: {} }
};

/** Template/workspace manifest with platform system collections and junction tables layered on top. */
export function mergeSystemCollections(template: NorbitalManifest): NorbitalManifest {
	return {
		...template,
		version: 1,
		collections: { ...emptyNorbitalManifest.collections, ...template.collections },
		relationships: { ...emptyNorbitalManifest.relationships, ...template.relationships }
	};
}
