// Agent roles under `src/agent/` (§3.3.6, §3.9, rules 57–63b): envoys, MCP servers and the skill frontmatter.
// Envoy behaviour is today's exactly (P22); the literal carries no authority beyond its `policies`.
import type { Checked, Exact } from '../fields.ts';
import type { EnvName } from './names.ts';

type McpBase = {
	description: string;
	/** The env name holding the server's streamable-HTTP URL. */
	url: string;
	/** A bearer token or OAuth client, by env name. */
	auth?: { bearer: string } | { oauth: { clientId: string; clientSecret?: string; scopes?: readonly string[] } };
	/** An allowlist of the server's tools; absent = every tool it lists. */
	tools?: readonly string[];
};
export type McpSpec = {
	description: string;
	/** Streamable HTTP, the current MCP revision; the URL and credentials come from the tenant's env and secrets. */
	url: EnvName;
	auth?: { bearer: EnvName } | { oauth: { clientId: EnvName; clientSecret?: EnvName; scopes?: readonly string[] } };
	/** An allowlist of the server's tools; absent = every tool it lists. */
	tools?: readonly string[];
};

/**
 * `src/agent/mcp/+<n>.mcp.ts`: an MCP server the agent may call, its `url` and credentials named from `+workspace.ts`'s
 * `env`, and an optional tool allowlist. Reachable only through a policy's `capabilities.mcp`.
 * @example
 * export default mcp({ description: 'HQ tools', url: 'HQ_URL', auth: { bearer: 'HQ_TOKEN' } });
 */
export function mcp<const S extends McpBase>(spec: S & Checked<McpBase, S, Exact<S, McpSpec>>): S {
	return spec;
}

/** The frontmatter of `src/agent/skill/+<s>.skill.md`; the body is `##` sections. The build decodes it. */
export type SkillFrontmatter = { description: string };
