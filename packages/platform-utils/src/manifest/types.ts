import type { CollectionField } from '../collection/types.js';

/**
 * Presence-set marker for a registered collection hook. The manifest records
 * WHICH hooks are registered, not their implementation — the workspace
 * registry is the source of truth for callable handlers.
 */
export type ManifestHookEntry = true;

export type ManifestPipelineEntry = true;

/** One `<expr> WITH <operator>` element of a Postgres EXCLUDE constraint. */
export type ManifestExclusionElement = {
	readonly expr: string;
	readonly with: string;
};

/**
 * A Postgres EXCLUDE constraint declared by a collection. Drizzle has no entity for
 * exclusion constraints, so the manifest carries them and the pod build emits the DDL
 * out-of-band alongside the other tenant internals.
 */
export type ManifestExclusion = {
	readonly name: string;
	readonly using?: 'gist' | 'btree';
	readonly elements: readonly ManifestExclusionElement[];
	readonly where?: string;
};

export type ManifestCollectionEntry = {
	readonly collection_name: string;
	readonly description: string | null;
	readonly record_label: string | null;
	readonly icon: string | null;
	/** Portable authored fields for read-only schema inspection. */
	readonly fields?: readonly CollectionField[];
	readonly extensions: {
		readonly indexes: readonly unknown[];
		/** Postgres EXCLUDE constraints; emitted out-of-band into `schema-post-ddl.sql`. */
		readonly exclusions?: readonly ManifestExclusion[];
	};
	readonly enabled_semantic_search?: boolean | null;
	readonly hooks: Partial<Record<string, ManifestHookEntry>>;
	readonly pipelines: Partial<Record<string, ManifestPipelineEntry>>;
	readonly system: boolean | null;
};

export type ManifestHookKey = string;

export type ManifestRelationship = {
	readonly name: string;
	readonly from: string;
	readonly to: string;
	readonly from_is_array: boolean;
	readonly to_is_array: boolean;
	/** Explicit database ownership. Omitted relationships retain restrictive FK deletion. */
	readonly on_delete?: 'cascade';
	/** Ordered direct join fields on the many/source side. Empty for through relationships. */
	readonly from_fields?: readonly string[];
	/** Ordered direct join fields on the one/target side. Empty for through relationships. */
	readonly to_fields?: readonly string[];
};

export type ManifestApp = {
	readonly name: string;
	readonly label?: string | null;
	readonly description: string | null;
	readonly icon: string | null;
	/** Fully-qualified child app ID used as this group's landing destination. */
	readonly defaultChild?: string | null;
	readonly thumbnail?: string | null;
	readonly banner?: string | null;
	readonly parent?: string | null;
	readonly config?: {
		readonly whitelist?: { readonly origins?: readonly string[] };
	};
};

export type ManifestHandlerEntry = {
	readonly name: string;
	readonly description: string | null;
};

export type ManifestAutomationAgentSpec = {
	readonly kind: 'agent';
	readonly task: string;
	readonly model?: string;
	readonly systemPrompt?: string;
	readonly tools?: readonly string[];
	readonly agentProfileId?: string;
};

export type ManifestAutomationTemplate = {
	readonly name: string;
	readonly description: string;
	readonly enabled: boolean;
	readonly cron_schedule: string | null;
	readonly created_by_user_id: string | null;
	readonly config?: {
		whitelist?: { origins?: string[] | null } | null;
	} | null;
	readonly spec?: ManifestAutomationAgentSpec;
};

export type ManifestEnv = {
	readonly public?: Readonly<Record<string, string>>;
	readonly secret?: Readonly<Record<string, string>>;
};

export interface ManifestSecretRequirement {
	readonly description: string;
	readonly required: boolean;
}

export interface ManifestIntegration {
	readonly name: string;
	readonly definition: Readonly<Record<string, unknown>>;
}

/**
 * Serializable projection of a workspace definition — collections, hooks,
 * pipelines, handlers, automations, apps, relationships, env.
 *
 * Field shapes are a portable, serializable projection. Drizzle columns remain
 * private to the tenant registry.
 */
export type NorbitalManifest = {
	readonly version: 1;
	readonly collections: Record<string, ManifestCollectionEntry>;
	readonly relationships: Record<string, ManifestRelationship>;
	readonly apps?: Record<string, ManifestApp>;
	readonly handlers?: Record<string, ManifestHandlerEntry>;
	readonly automations: Record<string, ManifestAutomationTemplate>;
	readonly env?: ManifestEnv;
	readonly secrets?: Readonly<Record<string, ManifestSecretRequirement>>;
	readonly integrations?: Readonly<Record<string, ManifestIntegration>>;
};
