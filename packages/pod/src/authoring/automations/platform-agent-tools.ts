/**
 * Platform tools the agent loop owns. Workspace tools are generated names; host sandbox tools are
 * not in this union — the runtime offers them only when a sandbox is bound to the session.
 */
export const PLATFORM_AGENT_TOOL_NAMES = [
	'describe_workspace',
	'list_skills',
	'read_skill',
	'read_collection',
	'write_collection',
	'spawn_subagent',
	'list_sandbox_agents',
	'read_sandbox_agent',
	'message_sandbox_agent',
	'await_sandbox_agent'
] as const;

export type PlatformAgentToolName = (typeof PLATFORM_AGENT_TOOL_NAMES)[number];

export const PLATFORM_AGENT_READ_TOOL_NAMES = [
	'describe_workspace',
	'list_skills',
	'read_skill',
	'read_collection'
] as const satisfies readonly PlatformAgentToolName[];

export type PlatformAgentReadToolName = (typeof PLATFORM_AGENT_READ_TOOL_NAMES)[number];

/** Host sandbox tools live in this namespace. They are never authored onto a profile. */
export const SANDBOX_HOST_TOOL_PREFIX = 'sandbox_';

export function isSandboxHostToolName(name: string): boolean {
	return name.startsWith(SANDBOX_HOST_TOOL_PREFIX);
}
