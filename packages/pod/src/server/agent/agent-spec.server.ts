import type { AgentAutomationSpec } from '$lib/authoring/automations/automations.js';
import { getTenantWorkspace } from '$lib/server/bootstrap/tenant_workspace.server.js';
import { declaredMcpServerNames } from '$lib/server/agent/mcp-tools.server.js';
import { layerAuthoredPrompts } from '$lib/server/agent/system-prompt.js';

/**
 * The workspace's own agent tools, all of them.
 *
 * Deliberately not caller-supplied. `executeTool` will only run a tool the spec names, so letting a
 * request choose would let it widen its own reach; an authored tool is a surface the workspace already
 * decided to expose.
 */
function workspaceAgentTools(): readonly string[] {
	return Object.keys(getTenantWorkspace().registered.agentTools);
}

/**
 * The profile every interactive conversation runs under when the workspace authored none.
 *
 * **This grants the full workspace tool surface to every signed-in user.** Sandbox host tools are
 * not listed here: the funnel adds them when this session has a bound sandbox. That is the same
 * rule every agent profile follows, including channels.
 *
 * Data access is the safe half. `read_collection` and `write_collection` both run unelevated, so
 * policy, hooks and approval gates apply exactly as they would to the same person clicking in the
 * app: the agent is a faster hand on the same controls, not a wider set of them. Leaving
 * `collections` unset is part of that — the ceiling comes from policy rather than from the spec.
 *
 * An authored `src/+agent.ts` still wins outright. A workspace that wrote its own boundary meant it,
 * and widening it from here would make that file advisory. `denyTools` on that file can withhold
 * workspace or platform tools; it cannot hide a bound sandbox.
 */
export function interactiveAgentSpec(message: string, model?: string): AgentAutomationSpec {
	const authored = getTenantWorkspace().registered.agent;
	const chosen = model === undefined ? {} : { model };
	// An explicit choice overrides the authored profile's model, and only for this turn — the profile
	// is a workspace-level default, not a lock on which model a person may talk to.
	if (authored) return { ...authored, task: message, ...chosen };
	return {
		kind: 'agent',
		// Synthesized per turn rather than authored, so the description states what this spec is for
		// rather than what any one message asks — the manifest never sees it, but the same shape is
		// what an authored `+agent.ts` fills, and a required field with no honest value is a lie.
		description: 'Answers one interactive request from a person in this workspace.',
		task: message,
		access: 'write',
		tools: workspaceAgentTools() as AgentAutomationSpec['tools'],
		mcpServers: declaredMcpServerNames(),
		...chosen
	};
}

/**
 * The profile a channel conversation runs under.
 *
 * The workspace surface is the full one — write access and every workspace tool — because the thing
 * that bounds an agent there is permission and not which tools it was handed. A curated subset would
 * remove capability without removing reach, and would have to be kept in step with a policy it
 * cannot read.
 *
 * What differs is where the permission comes from. An interactive run inherits the signed-in user's;
 * a channel may be a group chat, so there is no single person behind it to inherit from, and the run
 * acts instead as the channel's own `kind='agent'` principal, which `reconcileDeclaredChannels` puts
 * in a team carrying the channel's declared `policy`. That policy is the boundary: `read_collection`
 * and `write_collection` run unelevated, so every read and write meets the same policy, hooks and
 * approval gates the same principal would meet anywhere else, and a channel whose principal holds no
 * grants can do nothing. Adding a tool-shaped second boundary here would be redundant where it
 * agreed with the policy and misleading where it did not.
 *
 * Sandbox host tools are not listed on the channel. The funnel adds them when this session has a
 * bound sandbox, the same way it does for interactive chat. `hostTools` remains the opt-in for
 * non-sandbox host tools; `denyTools` withholds workspace or platform tools without touching sandbox.
 *
 * An authored `src/+agent.ts` is supplementary here rather than authoritative, which is the one place
 * this deliberately differs from interactive chat. Its prompt and its model and budget choices are
 * carried, because those are the workspace speaking about how its agent should work; its
 * `collections`, `access`, `tools`, `denyTools`, `hostTools` and `mcpServers` are not, because permission for
 * this run belongs to the channel's policy (and the channel's own allow/deny lists), and a file that
 * could widen or narrow that from the side would make those declarations advisory.
 */
export async function channelAgentSpec(input: {
	/** The declared `task` — what this channel's agent is for, in the workspace's own words. */
	readonly standingInstruction: string;
	/**
	 * Non-sandbox host tools the channel declaration opted into. Omitted / empty keeps the default:
	 * none. Sandbox tools are not named here.
	 */
	readonly hostTools?: readonly string[];
	readonly denyTools?: AgentAutomationSpec['denyTools'];
	/**
	 * MCP servers the channel declaration opted into. Omitted / empty keeps the default: none.
	 */
	readonly mcpServers?: readonly string[];
	/**
	 * How sandbox host tools may touch the worktree. Channels default to read-only.
	 */
	readonly hostSandbox?: AgentAutomationSpec['hostSandbox'];
}): Promise<AgentAutomationSpec> {
	const authored = getTenantWorkspace().registered.agent;
	const systemPrompt = layerAuthoredPrompts(authored?.systemPrompt, input.standingInstruction);
	const hostTools = [...(input.hostTools ?? [])];
	const mcpServers = [...(input.mcpServers ?? [])];
	const hostSandbox = input.hostSandbox ?? ({ workspace: 'read-only' } as const);
	return {
		kind: 'agent',
		description: 'Handles one inbound channel conversation under its standing instruction.',
		task: input.standingInstruction,
		access: 'write',
		tools: workspaceAgentTools() as AgentAutomationSpec['tools'],
		...(input.denyTools && input.denyTools.length > 0 ? { denyTools: [...input.denyTools] } : {}),
		hostTools,
		mcpServers,
		hostSandbox,
		...(systemPrompt === undefined ? {} : { systemPrompt }),
		...(authored?.model === undefined ? {} : { model: authored.model }),
		...(authored?.profile === undefined ? {} : { profile: authored.profile }),
		...(authored?.maxTokens === undefined ? {} : { maxTokens: authored.maxTokens })
	};
}
