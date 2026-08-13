/**
 * Model-facing MCP tool names: `mcp__<server>__<tool>`.
 *
 * Same qualification Claude Code, Codex, DeepSeek Harness, and Flue use, so a transcript and a
 * prompt stay readable across agents. The public name is never sent on the wire — `tools/call`
 * uses the server's raw name.
 */

const PUBLIC_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const SERVER_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export function isMcpServerName(name: string): boolean {
	return SERVER_NAME.test(name) && name.length <= 32;
}

export function publicMcpToolName(serverName: string, rawName: string): string {
	const candidate = `mcp__${serverName}__${rawName}`.replace(/[^A-Za-z0-9_-]/g, '_');
	if (PUBLIC_NAME.test(candidate)) return candidate;
	return `${candidate.slice(0, 51)}_${fnv1a12(serverName, rawName)}`;
}

export function parsePublicMcpToolName(
	name: string
): { readonly server: string; readonly tool: string } | null {
	if (!name.startsWith('mcp__')) return null;
	const rest = name.slice('mcp__'.length);
	const separator = rest.indexOf('__');
	if (separator <= 0 || separator === rest.length - 2) return null;
	const server = rest.slice(0, separator);
	const tool = rest.slice(separator + 2);
	if (!server || !tool) return null;
	return { server, tool };
}

/** 12 hex chars — enough to keep two truncated names from collapsing. */
function fnv1a12(serverName: string, rawName: string): string {
	const input = `${serverName}\0${rawName}`;
	let hash = 0x811c9dc5;
	for (let index = 0; index < input.length; index += 1) {
		hash ^= input.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 12);
}
