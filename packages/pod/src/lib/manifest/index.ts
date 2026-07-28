import type { CollectionPipelinesDef } from '$lib/authoring/automations/pipelines.js';
import type { RegisteredWorkspaceState } from '$lib/authoring/workspace/define-workspace.js';
import { hooksDeclaredFromBehavior } from '$lib/server/collection/hook-context.js';
import { isCollectionBehavior } from '$lib/authoring/schema/collection-behavior.js';
import {
	getTableColumnDefs,
	getTableMeta,
	portableCollectionField
} from '$lib/authoring/schema/table.js';
import { MANIFEST_VERSION } from '@norbital-ai/platform-utils/manifest/parse';
import type {
	ManifestApp,
	ManifestAutomationTemplate,
	ManifestCollectionEntry,
	ManifestHandlerEntry,
	ManifestHookEntry,
	ManifestPipelineEntry,
	ManifestRelationship,
	NorbitalManifest
} from '@norbital-ai/platform-utils/manifest/types';

export type {
	ManifestApp,
	ManifestAutomationTemplate,
	ManifestCollectionEntry,
	ManifestHandlerEntry,
	ManifestHookEntry,
	ManifestPipelineEntry,
	ManifestRelationship,
	NorbitalManifest
};

export const COLLECTION_HOOK_KEYS = [
	'beforeCreate',
	'afterCreate',
	'beforeUpdate',
	'afterUpdate',
	'beforeDelete',
	'afterDelete',
	'onApprovalRequestCreated',
	'onApprovalRequestUpdated',
	'onApprovalRequestDeleted',
	'onApprovalRequestApproved',
	'onApprovalRequestRejected',
	'onApprovalRequestChangeRequested',
	'onApprovalRequestPathChanged'
] as const;

export type CollectionHookKey = (typeof COLLECTION_HOOK_KEYS)[number];

export type ManifestPipelineKey = keyof CollectionPipelinesDef;

function buildCollectionEntries(
	collections: Record<string, unknown>,
	pipelines: Record<string, Record<string, unknown>> | undefined
): Record<string, ManifestCollectionEntry> {
	const out: Record<string, ManifestCollectionEntry> = {};
	for (const [, handle] of Object.entries(collections)) {
		if (!isCollectionBehavior(handle)) continue;
		const meta = getTableMeta(handle.table);
		const collectionName = handle.name;
		const declaredHooks = hooksDeclaredFromBehavior(handle);
		out[collectionName] = {
			collection_name: collectionName,
			description: meta?.description ?? null,
			record_label: meta?.record_label ?? null,
			icon: meta?.icon ?? null,
			fields: Object.entries(getTableColumnDefs(handle.table)).map(([name, column]) =>
				portableCollectionField(name, column)
			),
			extensions: { indexes: meta?.indexes ?? [], exclusions: meta?.exclusions ?? [] },
			enabled_semantic_search: meta?.semanticSearch === true ? true : null,
			hooks: collectHooks(declaredHooks),
			pipelines: collectPipelines(pipelines?.[collectionName]),
			system: meta?.system === true ? true : null
		};
	}
	return out;
}

function collectHooks(
	declared: Record<string, unknown> | undefined
): Partial<Record<CollectionHookKey, ManifestHookEntry>> {
	const out: Partial<Record<CollectionHookKey, ManifestHookEntry>> = {};
	if (!declared) return out;
	for (const hookKey of COLLECTION_HOOK_KEYS) {
		const value = declared[hookKey];
		if (value === true || typeof value === 'function') out[hookKey] = true;
	}
	return out;
}

function collectPipelines(
	declared: Record<string, unknown> | undefined
): Partial<Record<ManifestPipelineKey, ManifestPipelineEntry>> {
	const out: Partial<Record<ManifestPipelineKey, ManifestPipelineEntry>> = {};
	if (!declared) return out;
	for (const pipelineKey of ['import', 'export'] as const) {
		if (typeof declared[pipelineKey] === 'function') out[pipelineKey] = true;
	}
	return out;
}

function buildAutomationEntries(
	automations: Record<string, unknown> | undefined
): Record<string, ManifestAutomationTemplate> {
	const out: Record<string, ManifestAutomationTemplate> = {};
	for (const [key, raw] of Object.entries(automations ?? {})) {
		const tpl = raw as {
			trigger?: { schedule?: string } | { collection?: string; event?: string };
			spec?: {
				kind: string;
				task?: string;
				model?: string;
				systemPrompt?: string;
				tools?: string[];
			};
		};
		const trigger = tpl.trigger as { schedule?: string } | undefined;
		const isSchedule = trigger && 'schedule' in trigger;
		const agentSpec =
			tpl.spec && tpl.spec.kind === 'agent' && typeof tpl.spec.task === 'string'
				? {
						kind: 'agent' as const,
						task: tpl.spec.task,
						...(tpl.spec.model ? { model: tpl.spec.model } : {}),
						...(tpl.spec.systemPrompt ? { systemPrompt: tpl.spec.systemPrompt } : {}),
						...(tpl.spec.tools ? { tools: tpl.spec.tools } : {})
					}
				: undefined;
		out[key] = {
			name: key,
			description: '',
			enabled: true,
			cron_schedule: isSchedule ? trigger!.schedule! : null,
			created_by_user_id: null,
			...(agentSpec ? { spec: agentSpec } : {})
		};
	}
	return out;
}

function buildAppEntries(apps: Record<string, unknown> | undefined): Record<string, ManifestApp> {
	const out: Record<string, ManifestApp> = {};

	function flatten(key: string, raw: unknown, parent: string | null) {
		const app = raw as {
			name?: string | null;
			description?: string | null;
			icon?: string | null;
			defaultChild?: string | null;
			thumbnail?: string | null;
			banner?: string | null;
			component?: unknown;
			config?: ManifestApp['config'];
		};
		const appId = parent == null ? key : `${parent}/${key}`;
		out[appId] = {
			name: appId,
			label: app.name ?? null,
			description: app.description ?? null,
			icon: app.icon ?? null,
			...(app.defaultChild ? { defaultChild: `${appId}/${app.defaultChild}` } : {}),
			thumbnail: app.thumbnail ?? null,
			banner: app.banner ?? null,
			...(parent != null ? { parent } : {}),
			...(app.config ? { config: app.config } : {})
		};

		if (
			app.component != null &&
			typeof app.component === 'object' &&
			!Array.isArray(app.component)
		) {
			for (const [childKey, childRaw] of Object.entries(app.component)) {
				flatten(childKey, childRaw, appId);
			}
		}
	}

	for (const [key, raw] of Object.entries(apps ?? {})) {
		flatten(key, raw, null);
	}

	return out;
}

function buildHandlerEntries(
	handlers: Record<string, unknown> | undefined
): Record<string, ManifestHandlerEntry> {
	const out: Record<string, ManifestHandlerEntry> = {};
	for (const [key, raw] of Object.entries(handlers ?? {})) {
		const handler = raw as { name?: string; description?: string | null };
		out[key] = {
			name: handler.name ?? key,
			description: handler.description ?? null
		};
	}
	return out;
}

export function buildNorbitalManifest(workspace: {
	readonly collections: Record<string, unknown>;
	readonly relationships?: Record<string, ManifestRelationship>;
	readonly env?: NorbitalManifest['env'];
	readonly registered?: RegisteredWorkspaceState;
	readonly secrets?: Readonly<
		Record<string, { readonly description: string; readonly required?: boolean }>
	>;
	readonly integrations?: readonly {
		readonly name: string;
		readonly definition: Readonly<Record<string, unknown>>;
	}[];
}): NorbitalManifest {
	return {
		version: MANIFEST_VERSION,
		collections: buildCollectionEntries(workspace.collections, workspace.registered?.pipelines),
		relationships: workspace.relationships ?? {},
		apps: buildAppEntries(workspace.registered?.apps),
		handlers: buildHandlerEntries(workspace.registered?.remotes),
		automations: buildAutomationEntries(workspace.registered?.automations),
		env: workspace.env,
		secrets: workspace.secrets
			? Object.fromEntries(
					Object.entries(workspace.secrets).map(([name, requirement]) => [
						name,
						{ description: requirement.description, required: requirement.required !== false }
					])
				)
			: undefined,
		integrations: workspace.integrations
			? Object.fromEntries(
					workspace.integrations.map((integration) => [integration.name, integration])
				)
			: undefined
	};
}
