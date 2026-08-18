export interface McpServerDeclaration {
	readonly name: string;
	readonly url: string;
	readonly tools: ReadonlyArray<string>;
	readonly description?: string;
}

/** Declare one compiler-discovered MCP server in a `+<name>.mcp.ts` file. */
export const defineMcpServer = (declaration: McpServerDeclaration): McpServerDeclaration => {
	if (!/^[a-z][a-z0-9_-]*$/.test(declaration.name)) {
		throw new TypeError(`MCP server name "${declaration.name}" is invalid.`);
	}
	if (declaration.url.trim() === '') {
		throw new TypeError(`MCP server ${declaration.name} requires a URL.`);
	}
	if (declaration.tools.length === 0) {
		throw new TypeError(`MCP server ${declaration.name} must allow at least one tool.`);
	}
	if (new Set(declaration.tools).size !== declaration.tools.length) {
		throw new TypeError(`MCP server ${declaration.name} contains duplicate tools.`);
	}
	return Object.freeze({
		...declaration,
		url: declaration.url.trim(),
		tools: Object.freeze([...declaration.tools]),
		description: declaration.description?.trim()
	});
};
