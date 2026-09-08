import { Schema } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import type { AIRequest, ConnectorRequest, ConnectorResponse } from '@norbital-ai/bolt-protocol';
import { AgentId, DirectiveMode, DirectivePriority, ConversationId } from '@norbital-ai/bolt-protocol';
import type { FacilityBinding, FacilityResult } from '@norbital-ai/bolt-protocol';
import { policy, workspace, type ToolDeclaration } from '../src/authoring/workspace-schema.js';
import * as Agents from '../src/runtime/agents/agents.js';
import { MCP_PROTOCOL_VERSION } from '../src/runtime/agents/capability-catalog.js';
import {
	makeBoltTestRuntime,
	TEST_TENANT,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { toolResultFor } from './agents-canonical-ai-fixture.js';
import { fileURLToPath } from 'node:url';
import { cassetteTranscript, readCassetteFile } from '@norbital-ai/test-utilities';

const cassette = (name: string) =>
	readCassetteFile(fileURLToPath(new URL(`./assets/${name}.cassette.json`, import.meta.url)));

const subject = {
	userId: 'operator-1',
	tenantId: TEST_TENANT,
	teamPath: ['operator'],
	policies: []
};

const SEARCH_TOOL: ToolDeclaration = {
	name: 'search:lookup',
	description: 'Search the registry over MCP.',
	command: 'mcp:tools/call',
	inputSchema: {
		type: 'object',
		properties: { q: { type: 'string' } },
		required: ['q'],
		additionalProperties: false
	},
	mcp: { server: 'search', url: 'https://mcp.example.test', tool: 'lookup' }
};

const definitionWith = (mcpServers: ReadonlyArray<string>) =>
	workspace({
		name: 'mcp-operations',
		version: '1.0.0',
		collections: [],
		apps: [],
		policies: [
			policy({
				name: 'operator',
				effect: 'allow',
				actions: ['agent'],
				capabilities: {
					apps: ['*'],
					...(mcpServers.length === 0 ? {} : { mcp: mcpServers })
				}
			})
		],
		teams: { operator: ['operator'] },
		automations: [],
		envoys: [],
		integrations: [],
		prompt: 'You are the MCP operations agent.',
		tools: [SEARCH_TOOL],
		skills: [],
		requiredFacilities: []
	});

type JsonRpcBody = {
	jsonrpc: '2.0';
	id?: string | number;
	method: string;
	params?: unknown;
};

/**
 * A scripted stateless MCP server behind the connector facility: the same seam the unit adapter
 * test uses, driven through the host connector binding a real tenant provisions.
 */
const scriptedMcpConnector = (
	respond: (request: JsonRpcBody) => {
		status?: number;
		headers?: Record<string, string>;
		body?: unknown;
	}
): { readonly methods: Array<string> } & FacilityBinding<ConnectorRequest, ConnectorResponse> => {
	const methods: Array<string> = [];
	return {
		methods,
		call: async (_metadata, request) => {
			const body = (request.input as { body: JsonRpcBody }).body;
			methods.push(body.method);
			const reply = respond(body);
			return {
				_tag: 'Success',
				value: {
					output: {
						status: reply.status ?? 200,
						headers: reply.headers ?? { 'content-type': 'application/json' },
						body: {
							jsonrpc: '2.0',
							id: body.id ?? null,
							...(reply.body as Record<string, unknown>)
						}
					}
				}
			} satisfies FacilityResult<ConnectorResponse>;
		}
	};
};

const discoverOk = {
	body: {
		result: {
			supportedVersions: [MCP_PROTOCOL_VERSION],
			capabilities: { tools: {} }
		}
	}
};

const callOk = {
	body: {
		result: {
			resultType: 'complete',
			content: [{ type: 'text', text: 'Two hits' }],
			structuredContent: { hits: 2 }
		}
	}
};

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const runTurn = async (
	ai: ReturnType<typeof cassetteTranscript>['ai'],
	connector: FacilityBinding<ConnectorRequest, ConnectorResponse>,
	name: string
) => {
	harness = await makeBoltTestRuntime(definitionWith(['search']), { ai, connector });
	const agents = await harness.runtime.runPromise(Agents.Service);
	const conversationId = ConversationId.make(`00000000-0000-4000-8000-000000000b${name}`);
	await harness.runtime.runPromise(
		agents.submit(harness.effectId(`submit:${name}`), subject, {
			conversationId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput('Look up the registry entry.'),
			mode: DirectiveMode.make('agent'),
			priority: DirectivePriority.make('normal')
		})
	);
	const result = await harness.runtime.runPromise(
		agents.execute(harness.effectId(`execute:${name}`), subject, conversationId)
	);
	return { agents, conversationId, result };
};

describe('remote MCP tools inside the agent loop', () => {
	it('completes the handshake, calls the tool, and feeds the official result back to the model', async () => {
		const connector = scriptedMcpConnector((request) =>
			request.method === 'server/discover' ? discoverOk : callOk
		);
		const { ai, feed, requests } = cassetteTranscript(cassette('agents-mcp-ok'));
		const { result, conversationId } = await runTurn(ai, connector, '01');
		expect(result.status).toBe('done');
		expect(toolResultFor(requests[1]!, 'search:lookup')).toEqual({
			content: [{ type: 'text', text: 'Two hits' }],
			structuredContent: { hits: 2 }
		});
		expect(connector.methods).toEqual(['server/discover', 'tools/call']);
		expect(feed).toHaveLength(2);

		const snapshot = await harness!.database.query(
			`select run.capability_snapshot->'capabilities' as capabilities
			 from turn run where run.conversation_id = $1`,
			[conversationId]
		);
		const mcp = Schema.decodeUnknownSync(
			Schema.Array(Schema.Struct({ kind: Schema.String, id: Schema.String }))
		)(snapshot[0]?.capabilities).filter(
			(capability: { kind: string }) => capability.kind === 'mcp'
		);
		expect(mcp).toEqual([expect.objectContaining({ kind: 'mcp', id: 'tenant/search:lookup' })]);
		expect(requests).toHaveLength(2);
	});

	it('returns a tool failure when the server answers with a JSON-RPC error', async () => {
		const connector = scriptedMcpConnector((request) =>
			request.method === 'server/discover'
				? discoverOk
				: { body: { error: { code: -32000, message: 'lookup exploded' } } }
		);
		const { ai, requests } = cassetteTranscript(cassette('agents-mcp-fail'));
		const { result } = await runTurn(ai, connector, '02');
		expect(result.status).toBe('done');
		const failure = JSON.stringify(requests[1]!.messages.at(-1));
		expect(failure).toContain('MCP search:lookup failed');
		expect(failure).toContain('lookup exploded');
	});

	it('fails closed when the server negotiates an unsupported protocol version', async () => {
		const connector = scriptedMcpConnector(() => ({
			body: {
				result: {
					supportedVersions: ['2025-06-18'],
					capabilities: { tools: {} }
				}
			}
		}));
		const { ai, requests } = cassetteTranscript(cassette('agents-mcp-fail'));
		const { result } = await runTurn(ai, connector, '03');
		expect(result.status).toBe('done');
		const failure = JSON.stringify(requests[1]!.messages.at(-1));
		expect(failure).toContain('MCP search:lookup failed');
	});

	it('returns an http-status failure when the server responds 500', async () => {
		const connector = scriptedMcpConnector((request) =>
			request.method === 'server/discover' ? discoverOk : { status: 500, body: { error: {} } }
		);
		const { ai, requests } = cassetteTranscript(cassette('agents-mcp-fail'));
		const { result } = await runTurn(ai, connector, '04');
		expect(result.status).toBe('done');
		const failure = JSON.stringify(requests[1]!.messages.at(-1));
		expect(failure).toContain('HTTP 500');
	});
});
