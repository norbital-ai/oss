import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { EffectId } from '@norbital-ai/bolt-protocol';
import {
	ToolNotAllowed,
	resolveTool,
	mcpToolName,
	parseMcpToolName
} from '../../src/runtime/agents/agents.js';
import { agentTools, describeMcpServer } from '../../src/authoring/workspace-schema.js';
import { callMcpTool } from '../../src/runtime/agents/mcp.js';

describe('Agents tools and MCP owners', () => {
	it('enforces the authored tool allowlist', () =>
		expect(resolveTool([], 'web', 'missing')).toBeInstanceOf(ToolNotAllowed));
	it('round trips neutral MCP tool names', () =>
		expect(parseMcpToolName(mcpToolName('crm', 'search'))).toEqual({
			server: 'crm',
			tool: 'search'
		}));
	it('compiles declared MCP tools into the ordinary typed tool registry', () => {
		const [lookup] = describeMcpServer('search', {
			url: 'https://mcp.example.test',
			tools: [
				{
					name: 'lookup',
					description: 'Search indexed records.',
					inputSchema: {
						type: 'object',
						properties: { q: { type: 'string' } },
						required: ['q']
					}
				}
			]
		});
		expect(lookup).toEqual({
			name: 'search:lookup',
			description: 'Search indexed records.',
			command: 'mcp:tools/call',
			inputSchema: {
				type: 'object',
				properties: { q: { type: 'string' } },
				required: ['q']
			},
			mcp: { server: 'search', url: 'https://mcp.example.test', tool: 'lookup' }
		});
	});
	it('refuses duplicate or non-object MCP tool declarations at the schema boundary', () => {
		expect(() =>
			describeMcpServer('search', {
				url: 'https://mcp.example.test',
				tools: ['lookup', 'lookup']
			})
		).toThrow();
		expect(() =>
			describeMcpServer('search', {
				url: 'https://mcp.example.test',
				tools: [{ name: 'lookup', inputSchema: { type: 'string' } }]
			})
		).toThrow();
	});
	it('refuses a name collision in the one combined tool registry', () => {
		expect(() =>
			agentTools(
				[{ name: 'search:lookup', description: 'Local lookup.', command: 'workspace:lookup' }],
				{ search: { url: 'https://mcp.example.test', tools: ['lookup'] } }
			)
		).toThrow(/duplicate tool names/);
	});
	it.effect('preserves typed MCP content returned through the connector', () =>
		Effect.gen(function* () {
			const id = EffectId.make('mcp-content');
			const result = yield* callMcpTool(
				{ server: 'search', url: 'https://mcp.example.test', tool: 'lookup' },
				{ q: 'payroll' },
				id,
				{
					execute: () =>
						Effect.succeed({
							output: {
								status: 200,
								headers: { 'content-type': 'application/json' },
								body: {
									jsonrpc: '2.0',
									id,
									result: {
										resultType: 'complete',
										content: [{ type: 'text', text: 'Two hits' }],
										structuredContent: { hits: 2 }
									}
								}
							}
						})
				}
			);
			expect(result).toEqual({
				resultType: 'complete',
				content: [{ type: 'text', text: 'Two hits' }],
				structuredContent: { hits: 2 }
			});
		})
	);
});
