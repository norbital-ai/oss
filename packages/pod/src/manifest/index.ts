import type { CollectionPipelinesDef } from '$lib/authoring/automations/pipelines.js';
import type { RegisteredWorkspaceState } from '$lib/authoring/workspace/define-workspace.js';
import { hooksDeclaredFromBehavior } from '$lib/server/collection/hook-context.js';
import {
	isCollectionBehavior,
	type AnyCollectionBehavior
} from '$lib/authoring/schema/collection-behavior.js';
import {
	getTableColumnDefs,
	getTableMeta,
	portableCollectionField
} from '$lib/authoring/schema/table.js';
import { MANIFEST_VERSION } from '@norbital-ai/platform-utils/manifest/parse';
import type {
	ManifestApp,
	ManifestAutomationAgentSpec,
	ManifestAutomationTemplate,
	ManifestCollectionEntry,
	ManifestHandlerEntry,
	ManifestHookEntry,
	ManifestPipelineEntry,
	ManifestPolicyApproval,
	ManifestRelationship,
	ManifestSkill,
	NorbitalManifest
} from '@norbital-ai/platform-utils/manifest/types';
import type { Skill } from '$lib/skills/types.js';

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
	collections: Record<string, unknown>
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
			extensions: {
				indexes: meta?.indexes ?? [],
				exclusions: meta?.exclusions ?? [],
				history: meta?.history
			},
			enabled_semantic_search: meta?.semanticSearch === true ? true : null,
			hooks: collectHooks(declaredHooks),
			pipelines: collectPipelines(handle),
			system: meta?.system === true ? true : null
		};
	}
	return out;
}

function collectHooks(
	declared: Record<string, { readonly description: string }>
): Partial<Record<CollectionHookKey, ManifestHookEntry>> {
	const out: Partial<Record<CollectionHookKey, ManifestHookEntry>> = {};
	for (const hookKey of COLLECTION_HOOK_KEYS) {
		const declaration = declared[hookKey];
		if (declaration) out[hookKey] = { description: declaration.description };
	}
	return out;
}

/**
 * Read pipelines off the behavior rather than off the registered handler map.
 *
 * The registry holds the normalized handlers, which is what dispatch needs and all a `typeof ===
 * 'function'` probe could ever see. The description lives on the behavior beside them, so taking both
 * from one place is what stops a pipeline from appearing in the manifest with nothing said about it.
 */
function collectPipelines(
	behavior: AnyCollectionBehavior
): Partial<Record<ManifestPipelineKey, ManifestPipelineEntry>> {
	const out: Partial<Record<ManifestPipelineKey, ManifestPipelineEntry>> = {};
	for (const pipelineKey of ['import', 'export'] as const) {
		if (!behavior[pipelineKey]) continue;
		const description = behavior.pipelineDescriptions?.[pipelineKey];
		// Empty would satisfy this function and then fail `nonEmpty` when the built manifest is
		// parsed — a schema error naming a path rather than the pipeline that has nothing said
		// about it. Authoring already requires the description, so reaching here is a bug in the
		// behavior builder, and it should say which pipeline lost its text.
		if (!description) {
			throw new Error(
				`Collection "${behavior.name}" declares a ${pipelineKey} pipeline with no description.`
			);
		}
		out[pipelineKey] = { description };
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
				description?: string;
				task?: string;
				model?: string;
				systemPrompt?: string;
				collections?: string[];
				access?: 'read' | 'write';
				tools?: string[];
				hostTools?: string[];
				profile?: string;
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
		const agentSpec = buildAgentEntry(tpl.spec);
		out[key] = {
			description: tpl.spec?.description ?? '',
			trigger: isSchedule ? { schedule: trigger.schedule! } : eventTrigger!,
			...(agentSpec ? { spec: agentSpec } : {})
		};
	}
	return out;
}

function buildAgentEntry(raw: unknown): ManifestAutomationAgentSpec | undefined {
	const spec = raw as Partial<ManifestAutomationAgentSpec> | null | undefined;
	if (!spec || spec.kind !== 'agent' || typeof spec.task !== 'string') return undefined;
	return {
		kind: 'agent',
		description: spec.description ?? '',
		task: spec.task,
		...(spec.model ? { model: spec.model } : {}),
		...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
		...(spec.collections ? { collections: spec.collections } : {}),
		...(spec.access ? { access: spec.access } : {}),
		...(spec.tools ? { tools: spec.tools } : {}),
		...(spec.hostTools ? { hostTools: spec.hostTools } : {}),
		...(spec.profile ? { profile: spec.profile } : {}),
		...(spec.maxTokens ? { maxTokens: spec.maxTokens } : {})
	};
}

function buildAppEntries(apps: Record<string, unknown> | undefined): Record<string, ManifestApp> {
	const out: Record<string, ManifestApp> = {};

	function flatten(key: string, raw: unknown, parent: string | null) {
		const app = raw as {
			name?: string | null;
			description?: string;
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
			description: app.description ?? '',
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
		const handler = raw as { name?: string; description?: string };
		out[key] = {
			name: handler.name ?? key,
			description: handler.description ?? ''
		};
	}
	return out;
}

/**
 * Workspace agent tool names, flattened into the manifest so a host can see the namespace it shares.
 *
 * Only name and description travel: the implementation is compiled into the guest bundle and the
 * host never loads it. What a host cannot otherwise know is which names are already taken, and it
 * has to know that before it registers tools of its own — an agent is offered one flat list, so two
 * tools called the same thing make the model's call unresolvable.
 */
function buildAgentToolEntries(
	agentTools: Record<string, unknown> | undefined
): NorbitalManifest['agentTools'] {
	if (!agentTools || Object.keys(agentTools).length === 0) return undefined;
	const out: Record<string, ManifestHandlerEntry> = {};
	for (const [key, raw] of Object.entries(agentTools)) {
		const tool = raw as { description?: string };
		out[key] = { name: key, description: tool.description ?? '' };
	}
	return out;
}

/**
 * The workspace's skill catalogue, without the skills themselves.
 *
 * Bodies and attachments stay in the bundle. They are the reason a skill is worth having and also
 * the reason it cannot travel here: a handful of them would outweigh the rest of the manifest, which
 * every client of this workspace downloads whether or not it will ever talk to the agent.
 */
function buildSkillEntries(skills: readonly Skill[] | undefined): NorbitalManifest['skills'] {
	if (!skills || skills.length === 0) return undefined;
	const out: Record<string, ManifestSkill> = {};
	for (const skill of skills) {
		out[skill.name] = { name: skill.name, description: skill.description };
	}
	return out;
}

/**
 * Policy definitions, flattened into the manifest so the runtime can reconcile `policy` rows from it.
 *
 * The authoring shape uses `where`/`approval`; the stored grant uses `conditions`/`approval_config`.
 * Both translations happen at reconcile, which is also where `approval.approvers` — team *names* —
 * become `teams_that_can_approve` ids, because that resolution needs the tenant database. The
 * manifest therefore carries the authoring shape verbatim, and `ManifestPolicyApprovalSchema`
 * validates it here rather than leaving a misspelled key to fail at request time.
 */
function buildPolicyEntries(
	policies: Record<string, unknown> | undefined
): NorbitalManifest['policies'] {
	if (!policies || Object.keys(policies).length === 0) return undefined;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(policies)) {
		const policy = value as {
			name?: string;
			description?: string;
			apps?: readonly string[];
			grants?: readonly {
				collection?: string;
				action?: string;
				where?: Record<string, unknown>;
				approval?: ManifestPolicyApproval | null;
			}[];
		};
		out[key] = {
			key,
			name: policy.name ?? key,
			description: policy.description ?? '',
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
			description?: string;
			task?: string;
			hostTools?: readonly string[];
			hostSandbox?: { readonly workspace: 'read-only' | 'read-write' };
		};
		out[key] = {
			key,
			transport: channel.transport ?? '',
			policy: String(channel.policy ?? ''),
			description: channel.description ?? '',
			...(channel.task == null ? {} : { task: channel.task }),
			...(channel.hostTools && channel.hostTools.length > 0
				? { hostTools: [...channel.hostTools] }
				: {}),
			...(channel.hostSandbox ? { hostSandbox: { ...channel.hostSandbox } } : {})
		};
	}
	return out as NorbitalManifest['channels'];
}

/**
 * The custom column types this workspace declares, by name — the description only.
 *
 * The schema itself compiles into the guest bundle and stays there; what a reader outside the tenant
 * needs is what `settlement_policy` on a column actually means, which is otherwise only discoverable
 * by opening `src/custom-types` in the repository the workspace was built from.
 */
function buildCustomTypeEntries(
	customTypes: Readonly<Record<string, { readonly description?: string }>> | undefined
): NorbitalManifest['customTypes'] {
	if (!customTypes || Object.keys(customTypes).length === 0) return undefined;
	return Object.fromEntries(
		Object.entries(customTypes).map(([name, definition]) => [
			name,
			{ name, description: definition.description ?? '' }
		])
	);
}

export function buildNorbitalManifest(workspace: {
	readonly collections: Record<string, unknown>;
	readonly relationships?: Record<string, ManifestRelationship>;
	readonly customTypes?: Readonly<Record<string, { readonly description?: string }>>;
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
		collections: buildCollectionEntries(workspace.collections),
		relationships: workspace.relationships ?? {},
		customTypes: buildCustomTypeEntries(workspace.customTypes),
		apps: buildAppEntries(workspace.registered?.apps),
		handlers: buildHandlerEntries(workspace.registered?.remotes),
		agentTools: buildAgentToolEntries(workspace.registered?.agentTools),
		skills: buildSkillEntries(workspace.registered?.skills),
		agent: buildAgentEntry(workspace.registered?.agent),
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
