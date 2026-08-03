import type { AgentAutomationSpec } from '$lib/authoring/automations/automations.js';
import { getTenantWorkspace } from '$lib/server/bootstrap/tenant_workspace.server.js';
import { getRuntimeFacilities } from '$lib/server/facilities.js';
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
 * Every host tool this deployment offers, or none if it offers no tool facility at all.
 *
 * Read per turn rather than cached: the host's inventory is the host's, and a copy here would be a
 * second answer to "what can this agent call" that is free to go stale against the one dispatching.
 */
async function allHostTools(): Promise<readonly string[]> {
	const binding = getRuntimeFacilities().agentTools;
	if (!binding) return [];
	return (await binding.list()).map((tool) => tool.name);
}

/**
 * The profile every interactive conversation runs under when the workspace authored none.
 *
 * **This grants the full tool surface, host tools included, to every signed-in user.** That is a
 * deliberate operator decision and it is not the conservative one, so the consequence belongs in
 * writing next to the code that causes it.
 *
 * Data access is the safe half. `read_collection` and `write_collection` both run unelevated, so
 * policy, hooks and approval gates apply exactly as they would to the same person clicking in the
 * app: the agent is a faster hand on the same controls, not a wider set of them. Leaving
 * `collections` unset is part of that — the ceiling comes from policy rather than from the spec.
 *
 * Host tools are the half that trades something away. A host tool carries no requestor — the binding
 * frame has nowhere to put one, and the runtime is a single microVM shared by the whole organization
 * — so it authorizes on the principal it *acts as*, which is the tenant's builder principal. Naming
 * them here therefore hands a `basic` user the reach of a builder: the workspace's source tree, its
 * shell, its dependencies. The one remaining gate is that the tenant must hold a builder seat at all.
 *
 * Narrowing this back to a per-requestor decision needs a requestor on the host-tool binding first;
 * until that exists the choice is all users or no users, and this deployment chose all.
 *
 * An authored `src/+agent.ts` still wins outright. A workspace that wrote its own boundary meant it,
 * and widening it from here would make that file advisory.
 */
export async function interactiveAgentSpec(
	message: string,
	model?: string
): Promise<AgentAutomationSpec> {
	const authored = getTenantWorkspace().registered.agent;
	const chosen = model === undefined ? {} : { model };
	// An explicit choice overrides the authored profile's model, and only for this turn — the profile
	// is a workspace-level default, not a lock on which model a person may talk to.
	if (authored) return { ...authored, task: message, ...chosen };
	return {
		kind: 'agent',
		task: message,
		access: 'write',
		tools: workspaceAgentTools() as AgentAutomationSpec['tools'],
		hostTools: await allHostTools(),
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
 * Host tools are the exception, and they are withheld for as long as they have to be. A host tool
 * carries no requestor — a binding call has nowhere to put one — so it authorizes on the
 * principal it *acts as*, and nothing in a channel declaration chooses that principal. The channel's
 * policy, which bounds everything above, does not reach it at all. A hosted deployment resolves that
 * principal once per organization and to a builder, so a channel run offered `sandbox_bash` or
 * `sandbox_write` would not be refused: it would succeed, as the organization's builder, with shell
 * and git access to the workspace's own source tree. A Telegram or WhatsApp group is a semi-public
 * surface, and that is the failure being prevented — being a participant in a group conversation
 * must not be a way to edit the workspace.
 *
 * This is a hold on the identity gap rather than a judgement that a channel agent should be narrow.
 * Once a host-tool binding can carry the acting principal, a channel run should be offered the host
 * tools its own principal is entitled to, on exactly the footing everything else here already has.
 *
 * An authored `src/+agent.ts` is supplementary here rather than authoritative, which is the one place
 * this deliberately differs from interactive chat. Its prompt and its model and budget choices are
 * carried, because those are the workspace speaking about how its agent should work; its
 * `collections`, `access`, `tools` and `hostTools` are not, because permission for this run belongs
 * to the channel's policy and a file that could widen or narrow it from the side would make the
 * policy advisory.
 */
export async function channelAgentSpec(input: {
	/** The declared `task` — what this channel's agent is for, in the workspace's own words. */
	readonly standingInstruction: string;
}): Promise<AgentAutomationSpec> {
	const authored = getTenantWorkspace().registered.agent;
	const systemPrompt = layerAuthoredPrompts(authored?.systemPrompt, input.standingInstruction);
	return {
		kind: 'agent',
		task: input.standingInstruction,
		access: 'write',
		tools: workspaceAgentTools() as AgentAutomationSpec['tools'],
		hostTools: [],
		...(systemPrompt === undefined ? {} : { systemPrompt }),
		...(authored?.model === undefined ? {} : { model: authored.model }),
		...(authored?.profile === undefined ? {} : { profile: authored.profile }),
		...(authored?.maxIterations === undefined ? {} : { maxIterations: authored.maxIterations }),
		...(authored?.maxTokens === undefined ? {} : { maxTokens: authored.maxTokens })
	};
}
