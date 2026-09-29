// Agent roles under `src/agent/` (§3.3.6, §3.9, rules 57–63b): envoys, MCP servers and the skill frontmatter.
// Envoy behaviour is today's exactly (P22); the literal carries no authority beyond its `policies`.
import type { Checked, Exact } from '../fields.ts';
import type { ChannelName, PolicyName } from '../names.ts';
import type { NonEmpty } from '../values.ts';
import type { EnvName, TransportOf } from './names.ts';

type EnvoyBase = {
	/** The channel it answers. */
	channel: string;
	/** `authenticated`: unlinked senders get the registration notice; `public`: their DMs run under `policies` alone. */
	audience: 'public' | 'authenticated';
	/** The authority of every turn (a linked sender's own joins it in a DM). */
	policies: NonEmpty<string>;
	/** What the envoy is called on its channel: the name a person says when they mean it (`Norbital`). */
	name: string;
	/** Which group messages it answers; default `disabled`. */
	groupMessages?: 'disabled' | 'mention_or_reply' | 'all';
	/** Whether it may delegate to sub-agents. */
	delegation: 'enabled' | 'disabled';
	/** A standing directive on top of `+agent.md`. */
	task: string;
	/** System 1 triage of inbound messages; `false` answers every addressed message at once. */
	triage?: false | { scope?: 'dm' | 'group' | 'all' }; // hook:triage
};
type EnvoyFor<S> = {
	channel: ChannelName;
	/** 'authenticated': an unlinked sender gets the registration notice and no turn; 'public': their DM runs under `policies` alone (P32). */
	audience: 'public' | 'authenticated';
	/** Required: every group turn's whole authority, joined in a DM by a linked sender's own (P32); the source of every envoy limit. */
	policies: NonEmpty<PolicyName>;
	/** What people call it on the channel; a message that says this name is addressed to it, mention or not. */
	name: string;
	/** Default 'disabled'. Email is always addressed, so an email channel's envoy takes none. */
	groupMessages?: TransportOf<S extends { channel: infer C } ? C : never> extends 'email'
		? 'error: email is always addressed; groupMessages does not apply' : 'disabled' | 'mention_or_reply' | 'all';
	delegation: 'enabled' | 'disabled';
	/** Rule 60a (hook:triage): on where the host binds the triage port; `false` opts out; `scope` default 'all'. Not on email. */
	triage?: TransportOf<S extends { channel: infer C } ? C : never> extends 'email'
		? 'error: email is always addressed; triage does not apply' : false | { scope?: 'dm' | 'group' | 'all' };
	/** A standing directive on top of `+agent.md`; never who may do what. */
	task: string;
};

/**
 * `src/agent/envoy/+<e>.envoy.ts`: the workspace agent answering a channel: who may reach it (`audience`), the policies its
 * turns hold, how it treats group messages, delegation, triage and its standing `task`.
 * @example
 * export default envoy({
 * 	channel: 'sales_desk',
 * 	audience: 'public',
 * 	name: 'Norbital',
 * 	policies: ['products_read'],
 * 	groupMessages: 'disabled',
 * 	delegation: 'disabled',
 * 	task: 'Answer questions about products and prices.'
 * });
 */
export function envoy<const S extends EnvoyBase>(spec: S & Checked<EnvoyBase, S, Exact<S, EnvoyFor<S>>>): S {
	return spec;
}

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
