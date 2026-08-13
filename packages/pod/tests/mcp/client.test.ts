import { describe, expect, it, vi } from 'vitest';
import { createMcpClient } from '../../src/mcp/client.js';
import {
	MCP_METHOD_HEADER,
	MCP_METHODS,
	MCP_NAME_HEADER,
	MCP_PROTOCOL_VERSION,
	MCP_PROTOCOL_VERSION_HEADER
} from '../../src/mcp/protocol.js';

const SERVER = {
	description: 'Stripe billing and customers.',
	url: 'https://mcp.stripe.com/mcp',
	tools: ['list_customers']
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

describe('MCP 2026-07-28 client', () => {
	it('posts tools/list with protocol headers and no initialize handshake', async () => {
		const fetch = vi.fn(async (_url, init) =>
			jsonResponse({
				jsonrpc: '2.0',
				id: 1,
				result: {
					tools: [{ name: 'list_customers', description: 'List customers', inputSchema: {} }]
				}
			})
		);
		const client = createMcpClient({ fetch });

		const tools = await client.listTools(SERVER);
		expect(tools).toEqual([
			{ name: 'list_customers', description: 'List customers', inputSchema: {} }
		]);

		expect(fetch).toHaveBeenCalledTimes(1);
		const init = fetch.mock.calls[0]![1] as RequestInit;
		const headers = new Headers(init.headers);
		expect(headers.get(MCP_PROTOCOL_VERSION_HEADER)).toBe(MCP_PROTOCOL_VERSION);
		expect(headers.get(MCP_METHOD_HEADER)).toBe(MCP_METHODS.listTools);
		expect(headers.get('Content-Type')).toBe('application/json');
		expect(headers.get(MCP_NAME_HEADER)).toBeNull();
		expect(init.method).toBe('POST');
	});

	it('sets Mcp-Name to the raw tool name on tools/call', async () => {
		const fetch = vi.fn(async (_url, init) =>
			jsonResponse({
				jsonrpc: '2.0',
				id: 1,
				result: { resultType: 'success', content: [{ type: 'text', text: 'ok' }] }
			})
		);
		const client = createMcpClient({ fetch });

		await client.callTool(SERVER, 'list_customers', { limit: 5 });

		const init = fetch.mock.calls[0]![1] as RequestInit;
		const headers = new Headers(init.headers);
		expect(headers.get(MCP_METHOD_HEADER)).toBe(MCP_METHODS.callTool);
		expect(headers.get(MCP_NAME_HEADER)).toBe('list_customers');
		const body = JSON.parse(String(init.body)) as { method: string; params: { name: string } };
		expect(body.method).toBe(MCP_METHODS.callTool);
		expect(body.params.name).toBe('list_customers');
	});

	it('parses input_required results', async () => {
		const fetch = vi.fn(async () =>
			jsonResponse({
				jsonrpc: '2.0',
				id: 1,
				result: {
					resultType: 'input_required',
					requests: [{ id: 'req-1', message: 'Which customer?', mode: 'form' }]
				}
			})
		);
		const client = createMcpClient({ fetch });

		const result = await client.callTool(SERVER, 'list_customers', {});
		expect(result).toEqual({
			resultType: 'input_required',
			requests: [{ id: 'req-1', message: 'Which customer?', mode: 'form' }]
		});
	});

	it('throws on HTTP errors', async () => {
		const fetch = vi.fn(async () => new Response('boom', { status: 500 }));
		const client = createMcpClient({ fetch });

		await expect(client.listTools(SERVER)).rejects.toThrow(/HTTP 500/);
	});
});
