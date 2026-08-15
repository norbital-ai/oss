/**
 * The tool funnel: one assembly path for every model that can call tools.
 *
 * Surfaces
 * --------
 * `agent` — interactive chat, channels, subagents. Owns a `chat_session` transcript.
 * `infer` — `api.infer` in hooks, automations, remotes. Ephemeral messages only; never a transcript.
 *
 * Layers (applied in order, then sorted by name)
 * ----------------------------------------------
 * 1. Platform read builtins — always
 *    `describe_workspace`, `read_collection`, `list_skills`, `read_skill`
 * 2. Platform write — `agent` only, `access === 'write'`, not plan mode
 *    `write_collection`
 * 3. Platform coordination — `agent` only, not plan mode
 *    sandbox coordination tools; `spawn_subagent` on the root turn
 * 4. Workspace tools (`+*.tool.ts`)
 *    `agent`: omit `spec.tools` → all; otherwise that allowlist
 *    `infer`: only names passed to `api.infer({ tools })`
 *    then subtract `spec.denyTools` (agent) — sandbox host tools cannot appear here
 * 5. MCP — `agent` only, `spec.mcpServers`
 * 6. Sandbox host tools — `agent` only, and only when this session has a bound sandbox
 *    Taken from `agentTools.list()`, never from `spec.hostTools` / allow / deny
 * 7. Other host tools — `agent` only, names in `spec.hostTools` that are not sandbox-gated
 *
 * Plan mode keeps layer 1 only.
 * `denyTools` cannot remove layer 6. Naming a `sandbox_*` tool there is a runtime error.
 */
import { z } from 'zod';
import type { AgentAutomationSpec } from '$lib/authoring/automations/automations.js';
import {
	isSandboxHostToolName,
	PLATFORM_AGENT_READ_TOOL_NAMES
} from '$lib/authoring/automations/platform-agent-tools.js';
import {
	getTenantManifest,
	getTenantWorkspace
} from '$lib/server/bootstrap/tenant_workspace.server.js';
import { getRuntimeFacilities } from '$lib/server/facilities.js';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { resolveMcpToolSpecs } from '$lib/server/agent/mcp-tools.server.js';
import { sandboxCoordinationTools } from '$lib/server/agent/sandbox-agents.server.js';
import type { AiToolSpec, HostAgentToolSpec } from '@norbital-ai/platform-utils/runtime/binding';

export const collectionReadInput = z.object({
	collection: z.string(),
	where: z.record(z.string(), z.unknown()).optional(),
	limit: z.number().int().min(1).max(250).optional()
});

export const skillReadInput = z.object({
	name: z.string(),
	file: z.string().optional()
});

export const TOOL_FUNNEL_SURFACES = ['agent', 'infer'] as const;
export type ToolFunnelSurface = (typeof TOOL_FUNNEL_SURFACES)[number];

export type ToolFunnelInput = {
	readonly surface: ToolFunnelSurface;
	readonly spec?: Pick<
		AgentAutomationSpec,
		'tools' | 'denyTools' | 'hostTools' | 'mcpServers' | 'collections' | 'access'
	>;
	readonly inferTools?: readonly string[];
	readonly planMode: boolean;
	readonly canSpawnSubagent: boolean;
	readonly sandboxBound: boolean;
};

function hostToolRequiresSandbox(tool: HostAgentToolSpec): boolean {
	if (tool.requiresSandbox === true) return true;
	if (tool.requiresSandbox === false) return false;
	return isSandboxHostToolName(tool.name);
}

/**
 * The collections this run may name, narrowed by its spec.
 *
 * Not the security boundary: `read_collection` goes through `findMany` without elevation, so the
 * requestor's policy decides what actually comes back. This narrows on top of that, so an agent
 * declared for `quotes` cannot wander into `accounts` even where its requestor could.
 */
export function allowedCollections(spec: {
	readonly collections?: readonly string[];
}): Set<string> {
	const all = Object.values(getTenantManifest().collections)
		.filter((collection) => collection.system !== true)
		.map((collection) => collection.collection_name)
		.sort();
	const selected = spec.collections ? [...spec.collections] : all;
	const unknown = selected.filter((collection) => !all.includes(collection));
	if (unknown.length > 0) {
		throw new Error(`Agent references unknown collections: ${unknown.join(', ')}`);
	}
	return new Set(selected);
}

function platformReadTools(): AiToolSpec[] {
	return [
		{
			name: 'describe_workspace',
			description: 'Describe the workspace schema and the collections relevant to this run.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false }
		},
		{
			name: 'read_collection',
			description: 'Read policy-visible records from an allowed collection.',
			inputSchema: z.toJSONSchema(collectionReadInput)
		},
		{
			name: 'list_skills',
			description:
				'List the skills available here, with their descriptions and the files each one carries. Skills document how the Norbital platform behaves and how this workspace expects to be worked with.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false }
		},
		{
			name: 'read_skill',
			description:
				'Read a skill, or one of its reference files. Your training data does not contain this platform, so call this before answering any question about how Norbital itself behaves — approvals, permissions, record history, schema changes, or your own capabilities.',
			inputSchema: z.toJSONSchema(skillReadInput)
		}
	];
}

function deniedNames(spec: ToolFunnelInput['spec']): Set<string> {
	const deny = spec?.denyTools ?? [];
	const sandbox = deny.filter(isSandboxHostToolName);
	if (sandbox.length > 0) {
		throw new Error(
			`denyTools cannot name sandbox host tool ${sandbox.join(', ')}; sandbox tools are supplied only when a sandbox is bound to the session`
		);
	}
	return new Set(deny);
}

function applyDeny(tools: AiToolSpec[], deny: ReadonlySet<string>): AiToolSpec[] {
	if (deny.size === 0) return tools;
	return tools.filter((tool) => !deny.has(tool.name));
}

function workspaceToolNames(input: ToolFunnelInput): readonly string[] {
	const registered = Object.keys(getTenantWorkspace().registered.agentTools);
	if (input.surface === 'infer') return [...(input.inferTools ?? [])];
	return input.spec?.tools ? [...input.spec.tools] : registered;
}

/**
 * Whether this agent session can receive sandbox host tools.
 *
 * Bound means: the host actually exposes `agentTools`, and this turn has a requestor the host can
 * resolve as a sandbox principal. Infer never qualifies — it has no session.
 */
export function sessionHasBoundSandbox(surface: ToolFunnelSurface): boolean {
	if (surface !== 'agent') return false;
	if (!getRuntimeFacilities().agentTools) return false;
	return Boolean(getWorkspace({ provision: true }).baseScope.requestor.norbital_id);
}

export async function assembleToolSpecs(input: ToolFunnelInput) {
	const deny = deniedNames(input.spec);
	if (input.planMode) {
		const specs = applyDeny(platformReadTools(), deny);
		specs.sort((left, right) => left.name.localeCompare(right.name));
		return {
			specs,
			hostTools: new Set<string>(),
			mcpTools: new Set<string>(),
			workspaceTools: new Set<string>()
		};
	}

	const tools: AiToolSpec[] = applyDeny(platformReadTools(), deny);
	if (
		input.surface === 'agent' &&
		(input.spec?.access ?? 'read') === 'write' &&
		!deny.has('write_collection')
	) {
		tools.push({
			name: 'write_collection',
			description: 'Create, update, or delete records through Pod collection operations.',
			inputSchema: {
				type: 'object',
				properties: {
					collection: { type: 'string' },
					action: { type: 'string', enum: ['create', 'update', 'delete'] },
					id: { type: 'string', format: 'uuid' },
					record: { type: 'object', additionalProperties: true }
				},
				required: ['collection', 'action'],
				additionalProperties: false
			}
		});
	}
	if (input.surface === 'agent') {
		tools.push(...applyDeny([...sandboxCoordinationTools()], deny));
		if (input.canSpawnSubagent && !deny.has('spawn_subagent')) {
			tools.push({
				name: 'spawn_subagent',
				description:
					'Spawn one focused subagent for a delegated task. The child uses the same approved data and workspace tools, streams its own transcript, and returns its final answer.',
				inputSchema: {
					type: 'object',
					properties: {
						task: { type: 'string', minLength: 1 }
					},
					required: ['task'],
					additionalProperties: false
				}
			});
		}
	}

	const registered = getTenantWorkspace().registered.agentTools;
	const workspaceTools = new Set<string>();
	for (const name of workspaceToolNames(input)) {
		if (deny.has(name)) continue;
		if (
			name === 'write_collection' ||
			name === 'spawn_subagent' ||
			isSandboxHostToolName(name) ||
			(PLATFORM_AGENT_READ_TOOL_NAMES as readonly string[]).includes(name)
		) {
			continue;
		}
		const definition = registered[name];
		if (!definition) throw new Error(`Agent references unknown tenant tool: ${name}`);
		workspaceTools.add(name);
		tools.push({
			name,
			description: definition.description,
			inputSchema: z.toJSONSchema(definition.input)
		});
	}

	const taken = new Set(tools.map((tool) => tool.name));
	const hostTools = new Set<string>();
	if (input.surface === 'agent') {
		const binding = getRuntimeFacilities().agentTools;
		const available = binding ? await binding.list() : [];
		const byName = new Map(available.map((tool) => [tool.name, tool]));
		const addHostTool = (tool: HostAgentToolSpec) => {
			if (taken.has(tool.name)) {
				throw new Error(
					`Host tool ${tool.name} collides with a workspace tool of the same name; the agent cannot tell them apart`
				);
			}
			taken.add(tool.name);
			hostTools.add(tool.name);
			const { requiresSandbox: _requiresSandbox, ...modelTool } = tool;
			tools.push(modelTool);
		};
		if (input.sandboxBound) {
			for (const tool of available) {
				if (hostToolRequiresSandbox(tool)) addHostTool(tool);
			}
		}
		for (const name of input.spec?.hostTools ?? []) {
			if (hostTools.has(name)) continue;
			const tool = byName.get(name);
			if (!tool) throw new Error(`Agent references unknown host tool: ${name}`);
			if (hostToolRequiresSandbox(tool)) continue;
			addHostTool(tool);
		}
	}

	const mcp =
		input.surface === 'agent' && input.spec
			? await resolveMcpToolSpecs(input.spec, taken)
			: { specs: [], names: new Set<string>() };
	tools.push(...mcp.specs);

	tools.sort((left, right) => left.name.localeCompare(right.name));
	return {
		specs: tools,
		hostTools,
		mcpTools: mcp.names,
		workspaceTools
	};
}

export type ResolvedTools = Awaited<ReturnType<typeof assembleToolSpecs>>;
