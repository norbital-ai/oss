import { isMcpServerName } from '$lib/mcp/names.js';
import type { McpServerDefinition } from '$lib/mcp/types.js';

export type { McpServerDefinition };

/**
 * Declare one compiler-discovered MCP server in a `src/mcp/+<name>.mcp.ts` file.
 *
 * The filename is the server identity (`stripe` from `+stripe.mcp.ts`). The host opens the
 * connection; this file only names what this workspace is allowed to see.
 */
export function defineMcpServer(definition: McpServerDefinition): McpServerDefinition {
	if (!definition.description.trim()) throw new Error('MCP server description cannot be empty');
	let url: URL;
	try {
		url = new URL(definition.url);
	} catch {
		throw new Error('MCP server url must be an absolute http(s) URL');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('MCP server url must be an absolute http(s) URL');
	}
	if (definition.tools.length === 0) {
		throw new Error('MCP server tools cannot be empty — name the tools this workspace may call');
	}
	const seen = new Set<string>();
	for (const tool of definition.tools) {
		if (!tool.trim()) throw new Error('MCP server tool names cannot be empty');
		if (seen.has(tool)) throw new Error(`MCP server lists tool ${tool} twice`);
		seen.add(tool);
	}
	return definition;
}

export function assertMcpServerId(id: string): void {
	if (!isMcpServerName(id)) {
		throw new Error(
			`MCP server ${id} must be lower_snake_case and at most 32 characters — it is the namespace on every tool name`
		);
	}
}
