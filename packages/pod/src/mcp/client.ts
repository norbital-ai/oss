import {
	MCP_CLIENT_INFO,
	MCP_METHOD_HEADER,
	MCP_METHODS,
	MCP_NAME_HEADER,
	MCP_PROTOCOL_VERSION,
	MCP_PROTOCOL_VERSION_HEADER,
	type McpMethod
} from './protocol.js';
import type {
	McpContentBlock,
	McpElicitationRequest,
	McpJsonRpcResponse,
	McpServerDefinition,
	McpToolDefinition,
	McpToolResult
} from './types.js';

export type McpClientHooks = {
	readonly fetch?: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Stateless MCP 2026-07-28 client.
 *
 * Each call is one HTTP POST. There is no initialize handshake and no session id. Method and tool
 * names travel in `Mcp-Method` / `Mcp-Name` so a gateway can route without parsing the body.
 */
export function createMcpClient(hooks: McpClientHooks = {}) {
	const fetchImpl = hooks.fetch ?? globalThis.fetch.bind(globalThis);

	async function rpc(
		server: McpServerDefinition,
		method: McpMethod,
		params: Record<string, unknown>,
		name?: string
	): Promise<unknown> {
		const url = new URL(server.url);
		const headers = new Headers(server.headers);
		headers.set('Content-Type', 'application/json');
		headers.set(MCP_PROTOCOL_VERSION_HEADER, MCP_PROTOCOL_VERSION);
		headers.set(MCP_METHOD_HEADER, method);
		if (name) headers.set(MCP_NAME_HEADER, name);

		const body = {
			jsonrpc: '2.0',
			id: 1,
			method,
			params: {
				...params,
				_meta: {
					'io.modelcontextprotocol/clientInfo': MCP_CLIENT_INFO
				}
			}
		};

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), server.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		let response: Response;
		try {
			response = await fetchImpl(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: controller.signal
			});
		} catch (cause) {
			if (controller.signal.aborted) {
				throw new Error(`MCP server ${describe(server)} timed out calling ${method}`);
			}
			throw new Error(
				`MCP server ${describe(server)} could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`
			);
		} finally {
			clearTimeout(timeout);
		}

		if (!response.ok) {
			throw new Error(
				`MCP server ${describe(server)} returned HTTP ${response.status} for ${method}`
			);
		}

		const payload = (await response.json()) as McpJsonRpcResponse;
		if ('error' in payload) {
			throw new Error(
				`MCP server ${describe(server)} rejected ${method}: ${payload.error.message}`
			);
		}
		return payload.result;
	}

	return {
		async listTools(server: McpServerDefinition): Promise<readonly McpToolDefinition[]> {
			const result = await rpc(server, MCP_METHODS.listTools, {});
			const tools = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
			return tools.flatMap((entry) => {
				if (!isRecord(entry) || typeof entry.name !== 'string') return [];
				return [
					{
						name: entry.name,
						description: typeof entry.description === 'string' ? entry.description : entry.name,
						inputSchema: entry.inputSchema ?? { type: 'object', properties: {} }
					}
				];
			});
		},

		async callTool(
			server: McpServerDefinition,
			name: string,
			args: Record<string, unknown>,
			inputResponses?: unknown
		): Promise<McpToolResult> {
			const result = await rpc(
				server,
				MCP_METHODS.callTool,
				{
					name,
					arguments: args,
					...(inputResponses === undefined ? {} : { inputResponses })
				},
				name
			);
			return parseToolResult(result);
		}
	};
}

export type McpClient = ReturnType<typeof createMcpClient>;

function parseToolResult(result: unknown): McpToolResult {
	if (!isRecord(result)) {
		return { resultType: 'success', content: [{ type: 'text', text: String(result) }] };
	}
	if (result.resultType === 'input_required') {
		const requests = Array.isArray(result.requests)
			? result.requests.flatMap((entry, index) => {
					if (!isRecord(entry) || typeof entry.message !== 'string') return [];
					const request: McpElicitationRequest = {
						id: typeof entry.id === 'string' ? entry.id : `elicitation-${index}`,
						message: entry.message,
						...(entry.mode === 'form' || entry.mode === 'url' ? { mode: entry.mode } : {}),
						...(entry.schema === undefined ? {} : { schema: entry.schema }),
						...(typeof entry.url === 'string' ? { url: entry.url } : {})
					};
					return [request];
				})
			: [];
		return { resultType: 'input_required', requests };
	}
	const content = Array.isArray(result.content)
		? (result.content.filter((block) => isRecord(block) && typeof block.type === 'string') as McpContentBlock[])
		: [{ type: 'text', text: JSON.stringify(result) }];
	return {
		resultType: 'success',
		content,
		...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
		...(result.isError === true ? { isError: true } : {})
	};
}

function describe(server: McpServerDefinition): string {
	return server.url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
