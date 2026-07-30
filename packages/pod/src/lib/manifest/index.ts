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
			trigger?:
				| { schedule?: string }
				| { trigger?: { collection?: string; event?: 'created' | 'updated' | 'deleted' } };
			spec?: {
				kind: string;
				task?: string;
				model?: string;
				systemPrompt?: string;
				collections?: string[];
				access?: 'read' | 'write';
				tools?: string[];
				profile?: string;
				maxIterations?: number;
				maxTokens?: number;
			};
		};
		const trigger = tpl.trigger;
		const isSchedule = trigger && 'schedule' in trigger;
		const eventTrigger =
			trigger && 'trigger' in trigger && trigger.trigger?.collection && trigger.trigger.event
				? {
						collection: trigger.trigger.collection,
						event: trigger.trigger.event
					}
				: undefined;
		const agentSpec =
			tpl.spec && tpl.spec.kind === 'agent' && typeof tpl.spec.task === 'string'
				? {
						kind: 'agent' as const,
						task: tpl.spec.task,
						...(tpl.spec.model ? { model: tpl.spec.model } : {}),
						...(tpl.spec.systemPrompt ? { systemPrompt: tpl.spec.systemPrompt } : {}),
						...(tpl.spec.collections ? { collections: tpl.spec.collections } : {}),
						...(tpl.spec.access ? { access: tpl.spec.access } : {}),
						...(tpl.spec.tools ? { tools: tpl.spec.tools } : {}),
						...(tpl.spec.profile ? { profile: tpl.spec.profile } : {}),
						...(tpl.spec.maxIterations ? { maxIterations: tpl.spec.maxIterations } : {}),
						...(tpl.spec.maxTokens ? { maxTokens: tpl.spec.maxTokens } : {})
					}
				: undefined;
		out[key] = {
			trigger: isSchedule ? { schedule: trigger.schedule! } : eventTrigger!,
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

/**
 * Policy definitions, flattened into the manifest so the runtime can reconcile `policy` rows from it.
 *
 * The authoring shape uses `where`/`approval`; the stored grant uses `conditions`/`approval_config`.
 * Translating here rather than in the engine keeps the runtime unchanged — the only thing that moved
 * is where the rows come from.
 */
function buildPolicyEntries(
	policies: Record<string, unknown> | undefined
): NorbitalManifest['policies'] {
	if (!policies || Object.keys(policies).length === 0) return undefined;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(policies)) {
		const policy = value as {
			name?: string;
			description?: string | null;
			apps?: readonly string[];
			grants?: readonly {
				collection?: string;
				action?: string;
				where?: Record<string, unknown>;
				approval?: Record<string, unknown> | null;
			}[];
		};
		out[key] = {
			key,
			name: policy.name ?? key,
			...(policy.description == null ? {} : { description: policy.description }),
			...(policy.apps ? { apps: [...policy.apps] } : {}),
			grants: (policy.grants ?? []).map((grant) => ({
				collection: grant.collection ?? '',
				action: grant.action ?? 'read',
				...(grant.where ? { where: grant.where } : {}),
				...(grant.approval == null ? {} : { approval: grant.approval })
			}))
		};
	}
	return out as NorbitalManifest['policies'];
}

/**
 * Channel declarations, flattened into the manifest so a host can check `transport` before it serves.
 *
 * The host never loads the workspace bundle, so a transport name that lives only in
 * `src/channels/+<name>.channel.ts` is invisible to it. Carrying it here is what lets startup refuse
 * a workspace whose channels reach a wire nobody holds open.
 */
function buildChannelEntries(
	channels: Record<string, unknown> | undefined
): NorbitalManifest['channels'] {
	if (!channels || Object.keys(channels).length === 0) return undefined;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(channels)) {
		const channel = value as {
			transport?: string;
			policy?: string;
			description?: string | null;
			task?: string;
		};
		out[key] = {
			key,
			transport: channel.transport ?? '',
			policy: String(channel.policy ?? ''),
			...(channel.description == null ? {} : { description: channel.description }),
			...(channel.task == null ? {} : { task: channel.task })
		};
	}
	return out as NorbitalManifest['channels'];
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
		policies: buildPolicyEntries(workspace.registered?.policies),
		channels: buildChannelEntries(workspace.registered?.channels),
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
