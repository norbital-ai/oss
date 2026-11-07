// Agent roles under `src/agent/` (§3.3.6, §3.9, rules 57–63b): envoys, MCP servers and the skill frontmatter.
// A tenant-created envoy is a `sys_envoy` row; a source envoy here is a declared default. Either is deployed by setting
// `sys_integration.envoy` on a workspace conversation instance (a `+workspace.ts` connection's `envoy` is that default).
// The role carries no authority beyond its `policies`.
import type { Checked, Exact, InputFields, ValidInputs } from '../fields.ts';
import type { PolicyName } from '../names.ts';
import type { Json, NonEmpty } from '../values.ts';
import type { RunInput } from './automation.ts';
import type { SecretName } from './names.ts';

/** An envoy literal's general shape. */
export type EnvoySpec = {
	/** What people call it: a message that says this name is addressed to it, mention or not. */
	name: string;
	/** `private`: only a sender whose handle is a member's; `public`: anyone, an unknown sender under `policies` alone. */
	audience: 'public' | 'private';
	/** Every group turn's whole authority, joined in a DM by a linked member's own (`dm`); the source of every envoy limit. */
	policies: NonEmpty<string>;
	/** Which group messages it answers; default `mention_or_reply`. Email is always addressed. */
	groupMessages?: 'disabled' | 'mention_or_reply' | 'all';
	/** Whether it may delegate to sub-agents. */
	delegation: 'enabled' | 'disabled';
	/** System 1 triage of inbound messages (where the host binds it); `false` answers every addressed message at once. */
	triage?: false | { scope?: 'dm' | 'group' | 'all' }; // hook:triage
	/**
	 * A linked member's DM: `union` (default) holds the envoy's policies and the member's own; `envoy` holds the envoy's
	 * alone, its operands bound to the member (never admin, no member routes), and `history`'s 'mine' to this instance.
	 */
	dm?: 'union' | 'envoy';
	/** A standing directive on top of `+agent.md`; never who may do what. */
	task: string;
};
type EnvoyFor = Omit<EnvoySpec, 'policies'> & { policies: NonEmpty<PolicyName> };

/**
 * `src/agent/envoy/+<id>.envoy.ts`: the workspace agent as it answers outside senders on a conversation instance: who may
 * reach it (`audience`), the policies its turns hold, group messages, delegation, triage, DM authority and its `task`.
 * @example
 * export default envoy({
 * 	name: 'Norbital',
 * 	audience: 'private',
 * 	policies: ['field_ops_whatsapp'],
 * 	delegation: 'disabled',
 * 	task: 'Answer questions about job assignments and keep them up to date from what people report.'
 * });
 */
export function envoy<const S extends EnvoySpec>(
	spec: S & Checked<EnvoySpec, S, Exact<S, EnvoyFor>>
): S {
	return spec;
}

/** A tool literal's data: what the manifest holds. */
export type ToolSpec = {
	/** What it does, as the agent reads it. */
	description: string;
	/** The typed input a call passes to `run.ts`. */
	input?: InputFields;
};
type ToolFor<S> = {
	description: string;
	input?: S extends { input: infer I } ? ValidInputs<I> : InputFields;
};

/**
 * `src/agent/tool/<name>/+tool.ts`: a tool the agent calls with `run_tool`, told of it once it is merged. This file is data
 * the compiler reads. The body is `run.ts` beside it, whose default export is a `ToolRun`: it runs on Node in a VM of its
 * own, with the workspace's packages, and never reaches the network, a process, a native addon or the workspace's records.
 * @example
 * export default tool({
 * 	description: 'The sheets of a drawing, each with its layers.',
 * 	input: { sheet: { kind: 'text', optional: true } }
 * });
 */
export function tool<const S extends ToolSpec>(
	spec: S & Checked<ToolSpec, S, Exact<S, ToolFor<S>>>
): S {
	return spec;
}

/** The files a call handed a tool, and the files it gives the person. */
export type ToolFiles = {
	readonly names: readonly string[];
	read(name: string): Promise<Uint8Array>;
	write(name: string, content: Uint8Array | string): Promise<void>;
};
/** The default export of a tool's `run.ts`, `S` its `+tool.ts`: what it returns is the agent's answer. */
export type ToolRun<S> = (input: RunInput<S>, files: ToolFiles) => Json | Promise<Json>;

/** The authoring shape of an MCP server: `url` is a secret name, so a string until the names are checked. */
export type McpBase = {
	description: string;
	/** The secret name holding the server's streamable-HTTP URL. */
	url: string;
	/** A bearer token or OAuth client, by secret name. */
	auth?:
		| { bearer: string }
		| { oauth: { clientId: string; clientSecret?: string; scopes?: readonly string[] } };
	/** An allowlist of the server's tools; absent = every tool it lists. */
	tools?: readonly string[];
};
/** The checked MCP spec: every secret is a `SecretName` declared in `+secrets.ts`. */
export type McpSpec = {
	description: string;
	/** Streamable HTTP, the current MCP revision; the URL and credentials are workspace secrets. */
	url: SecretName;
	auth?:
		| { bearer: SecretName }
		| { oauth: { clientId: SecretName; clientSecret?: SecretName; scopes?: readonly string[] } };
	/** An allowlist of the server's tools; absent = every tool it lists. */
	tools?: readonly string[];
};

/**
 * `src/agent/mcp/+<n>.mcp.ts`: an MCP server the agent may call, its `url` and credentials named from `+secrets.ts`, and an
 * optional tool allowlist. Reachable only through a policy's `capabilities.mcp`. Declare the names, merge the change
 * to live, then `navigate { configure: { capability: 'mcp.configure', record: '<n>' } }` opens the native pairing
 * sheet; each secret opens the write-only form. Its tools appear on the next turn as `mcp__<n>__<tool>`.
 * @example
 * export default mcp({ description: 'HQ tools', url: 'HQ_URL', auth: { bearer: 'HQ_TOKEN' } });
 */
export function mcp<const S extends McpBase>(spec: S & Checked<McpBase, S, Exact<S, McpSpec>>): S {
	return spec;
}

/** The frontmatter of `src/agent/skill/<s>/+skill.md`; the body is `##` sections. The build decodes it. */
export type SkillFrontmatter = { description: string };
