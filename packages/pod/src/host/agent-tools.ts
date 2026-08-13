import type {
	HostAgentToolBinding,
	HostAgentToolRunContext,
	HostAgentToolSpec
} from '@norbital-ai/platform-utils/runtime/binding';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';
import { z } from 'zod';

/**
 * One tool the host implements and a tenant's agent may call.
 *
 * The mirror of `defineAgentTool`, on the other side of the boundary. A workspace tool is compiled
 * into the guest bundle and runs in the isolate under the requestor's policy; a host tool runs in the
 * host process, with whatever the host process can reach — a sandbox, a deploy pipeline, a credential
 * the tenant must never hold. That difference is the entire reason this type exists separately, and
 * the reason nothing is offered it by default.
 *
 * `run` receives input already validated against `input`, and returns a value that has to survive
 * structured clone on its way back into the isolate — plain data, no functions, no class instances.
 *
 * Optional context carries the Pod-selected sandbox principal and authored mount policy. A host
 * must resolve and authorize that principal itself before opening a workbench; the id crossing this
 * binding is a directory lookup key, not a trusted role or permission claim.
 */
export type HostAgentTool<TInput extends z.ZodType = z.ZodType> = {
	/** How the model names it. Shares one namespace with the workspace's own agent tools. */
	readonly name: string;
	readonly description: string;
	readonly input: TInput;
	/**
	 * When true, the funnel offers this tool only if the session has a bound sandbox.
	 * When omitted, names in the `sandbox_` namespace are treated as requiring a sandbox.
	 */
	readonly requiresSandbox?: boolean;
	run(input: z.infer<TInput>, context?: HostAgentToolRunContext): unknown | Promise<unknown>;
};

/** Tool names a provider will accept; also what the agent loop's built-ins are named. */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Names the agent loop always offers. A host tool may not take one of them.
 *
 * They are not in the manifest — they are Pod's, not the workspace's — so the collision check has to
 * carry them itself or `read_collection` becomes a host tool nobody can reach past.
 */
const BUILT_IN_TOOL_NAMES = [
	'describe_workspace',
	'list_skills',
	'read_skill',
	'read_collection',
	'write_collection',
	// Added conditionally by the loop rather than unconditionally, which is exactly why it belongs
	// here: a host tool of this name would dispatch on root turns and vanish inside subagents.
	'spawn_subagent',
	'list_sandbox_agents',
	'read_sandbox_agent',
	'message_sandbox_agent',
	'await_sandbox_agent'
] as const;

/**
 * Assemble the `agentTools` facility from the tools this host actually has.
 *
 * The same shape as `messagingProviders`: a host config stays data, and the runner turns the list
 * into the binding. `list()` is a method rather than a field for the reason every facility obeys —
 * `facilityProxy` answers a property get with a call forwarder, so a field arrives inside a hosted
 * isolate as a function.
 *
 * `run` validates here, host-side, and not only in the guest. Input reaches this point from a model,
 * relayed by a tenant runtime, and neither is a trusted source; a host tool must not depend on the
 * isolate having checked its arguments.
 */
export function hostAgentTools(tools: readonly HostAgentTool[]): HostAgentToolBinding {
	const byName = new Map<string, HostAgentTool>();
	for (const tool of tools) {
		if (byName.has(tool.name)) throw new Error(`Duplicate host agent tool: ${tool.name}`);
		byName.set(tool.name, tool);
	}
	const specs: readonly HostAgentToolSpec[] = [...byName.values()].map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: z.toJSONSchema(tool.input),
		...(tool.requiresSandbox === undefined ? {} : { requiresSandbox: tool.requiresSandbox })
	}));
	return {
		list() {
			return Promise.resolve(specs);
		},
		async run(name, input, context) {
			const tool = byName.get(name);
			if (!tool) throw new Error(`This host supplies no agent tool named ${name}`);
			return tool.run(tool.input.parse(input), context);
		}
	};
}

/**
 * Refuse, before the process serves anything, a host tool set that cannot be dispatched unambiguously
 * — and a workspace that names a host tool this host does not have.
 *
 * Both halves are the same failure in different directions, and both are silent without this. The
 * agent offers the model *one* flat list of tools; a host tool called `create_quote` next to a
 * workspace tool called `create_quote` produces a tool call that names one thing and could mean two,
 * and whichever the dispatcher happens to reach first wins. That is a shadow, and a shadow is worse
 * than a refusal: the workspace's own tool keeps type-checking, keeps appearing in source, and simply
 * stops being what runs. The other direction — an agent naming `deploy_workspace` on a host with no
 * such tool — reads at runtime as an agent that mysteriously never uses the tool it was given.
 *
 * A name is knowable from the host config and the manifest carries the rest, so this is a
 * cross-reference that can be settled once, at startup, naming both sides.
 */
export function assertHostAgentTools(
	tools: readonly HostAgentTool[],
	manifest: NorbitalManifest
): void {
	const seen = new Set<string>();
	for (const tool of tools) {
		if (!TOOL_NAME.test(tool.name)) {
			throw new Error(
				`Host agent tool name "${tool.name}" is not usable: use 1-64 characters of A-Z, a-z, 0-9, underscore or hyphen.`
			);
		}
		if (!tool.description.trim()) {
			throw new Error(`Host agent tool "${tool.name}" needs a description; the model reads it.`);
		}
		if (seen.has(tool.name)) throw new Error(`Duplicate host agent tool: ${tool.name}`);
		seen.add(tool.name);
		if ((BUILT_IN_TOOL_NAMES as readonly string[]).includes(tool.name)) {
			throw new Error(
				`Host agent tool "${tool.name}" collides with a built-in agent tool of the same name. Rename the host tool.`
			);
		}
		if (manifest.agentTools?.[tool.name]) {
			throw new Error(
				`Host agent tool "${tool.name}" collides with the workspace agent tool of the same name (src/tools/+${tool.name}.tool.ts). One of them has to be renamed; the agent is offered a single list of tools and cannot tell them apart.`
			);
		}
	}

	const missing = new Map<string, string[]>();
	for (const named of manifest.agent?.hostTools ?? []) {
		if (seen.has(named)) continue;
		missing.set(named, [...(missing.get(named) ?? []), 'workspace agent']);
	}
	for (const [name, channel] of Object.entries(manifest.channels ?? {})) {
		for (const named of channel.hostTools ?? []) {
			if (seen.has(named)) continue;
			missing.set(named, [...(missing.get(named) ?? []), `channel:${name}`]);
		}
	}
	if (missing.size === 0) return;
	const known = [...seen].sort();
	throw new Error(
		[...missing]
			.map(
				([name, automations]) =>
					`Agent "${automations.join('", "')}" names host tool "${name}", which this host does not supply.` +
					(known.length > 0
						? ` Available host tools: ${known.join(', ')}.`
						: ' This host supplies no agent tools.')
			)
			.join('\n')
	);
}
