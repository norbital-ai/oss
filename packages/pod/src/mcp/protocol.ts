/**
 * MCP 2026-07-28 — the stateless protocol core.
 *
 * @see https://blog.cloudflare.com/mcp-v2/
 * @see https://blog.modelcontextprotocol.io/posts/2026-07-28
 */
export const MCP_PROTOCOL_VERSION = '2026-07-28';

export const MCP_PROTOCOL_VERSION_HEADER = 'MCP-Protocol-Version';
export const MCP_METHOD_HEADER = 'Mcp-Method';
export const MCP_NAME_HEADER = 'Mcp-Name';

export const MCP_METHODS = {
	discover: 'server/discover',
	listTools: 'tools/list',
	callTool: 'tools/call',
	listPrompts: 'prompts/list',
	getPrompt: 'prompts/get',
	listResources: 'resources/list',
	readResource: 'resources/read'
} as const;

export type McpMethod = (typeof MCP_METHODS)[keyof typeof MCP_METHODS];

export const MCP_CLIENT_INFO = {
	name: 'norbital-pod',
	version: '1.0.0'
} as const;
