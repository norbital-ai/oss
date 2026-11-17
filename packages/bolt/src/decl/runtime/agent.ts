import type { Checked, Exact } from '../fields.ts';
import type { SecretName } from './names.ts';

/** The authoring shape of an MCP server: `url` is a secret name, so a string until the names are checked. */
export type McpBase = {
	description: string;
	/** The secret name holding the server's streamable-HTTP URL. */
	url: string;
	/** A bearer token or OAuth client, by secret name. */
	auth?:
		| { bearer: string }
		| { oauth: { client_id: string; client_secret?: string; scopes?: readonly string[] } };
	/** An allowlist of the server's tools; absent = every tool it lists. */
	tools?: readonly string[];
};
/** The checked MCP spec: every secret is a `SecretName` declared in `+secrets.ts`. */
type McpSpec = {
	description: string;
	/** Streamable HTTP, the current MCP revision; the URL and credentials are workspace secrets. */
	url: SecretName;
	auth?:
		| { bearer: SecretName }
		| { oauth: { client_id: SecretName; client_secret?: SecretName; scopes?: readonly string[] } };
	/** An allowlist of the server's tools; absent = every tool it lists. */
	tools?: readonly string[];
};

/**
 * `src/agent/mcp/+<n>.mcp.ts`: an MCP server the agent may call, its `url` and credentials named from `+secrets.ts`, and an
 * optional tool allowlist. Reachable only through a policy's `capabilities.mcp`. Declare the names, merge the change
 * to live, then an administrator's agent calls `page { path, configure: { capability: 'mcp.configure', record: '<n>' } }`
 * (its path from `describe_workspace { names: ['system'] }`) to open the native MCP settings; each secret opens the
 * write-only form. Its tools are offered as `<n>__<tool>` (in a conversation begun earlier, through `run_tool`); a tool
 * name outside `[A-Za-z0-9_-]`, a server name with a double or trailing underscore, or a pair past 64 characters is
 * offered as its readable start and a 12-hex digest of the pair. A tool whose name a native, host or other MCP tool also
 * takes is not offered.
 * @example
 * export default mcp({ description: 'HQ tools', url: 'HQ_URL', auth: { bearer: 'HQ_TOKEN' } });
 */
export function mcp<const S extends McpBase>(spec: S & Checked<McpBase, S, Exact<S, McpSpec>>): S {
	return spec;
}

/** The frontmatter of `src/agent/skill/<s>/+skill.md`; the body is `##` sections. The build decodes it. */
export type SkillFrontmatter = { description: string };
