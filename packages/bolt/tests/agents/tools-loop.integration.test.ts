import { afterEach, describe, expect, it } from 'vitest';
import type {
	AIRequest,
	AIResponse,
	ConnectorRequest,
	ConnectorResponse,
	FacilityBinding,
	HostToolRequest,
	HostToolResponse
} from '@norbital-ai/bolt-protocol';
import type { ModelMessage } from '@tanstack/ai';
import * as Agents from '../../src/runtime/agents/agents.js';
import { describeMcpServer, tool } from '../../src/authoring/workspace-schema.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';
import {
	assistantText,
	assistantToolCall,
	lastToolResult,
	modelCatalogResponse,
	modelMessages,
	successfulAI
} from './canonical-ai-fixture.js';

const workspace = testWorkspace({
	tools: [
		tool({ name: 'summarize', description: 'Summarize records.', command: 'summarize' }),
		tool({ name: 'sandbox_files', description: 'Inspect files.', command: 'host:sandbox_files' }),
		...describeMcpServer('search', {
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
		})
	],
	skills: [{ name: 'payroll', body: '# Payroll\n\nUse the approved workflow.' }]
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const run = async (
	ai: FacilityBinding<AIRequest, AIResponse>,
	conversationId: string,
	bindings: Parameters<typeof makeBoltTestRuntime>[1] = {}
) => {
	harness = await makeBoltTestRuntime(workspace, { ...bindings, ai });
	const agents = await harness.runtime.runPromise(Agents.Service);
	return agents
		.enqueue(
			harness.effectId(`enqueue:${conversationId}`),
			adminSubject,
			'web',
			conversationId,
			`input:${conversationId}`,
			Agents.userAgentInput('Complete the task.')
		)
		.pipe((effect) => harness!.runtime.runPromise(effect));
};

describe('canonical Bolt agent tool loop', () => {
	it('executes a platform tool and persists distinct assistant/tool iterations', async () => {
		const requests: Array<Extract<AIRequest, { readonly _tag: 'Turn' }>> = [];
		const ai = successfulAI((request, index) => {
			requests.push(request);
			return {
				output:
					index === 0
						? assistantToolCall('describe_workspace', {}, 'describe-1', 'Inspecting.')
						: assistantText('Workspace has people.', 'answer-1')
			};
		});
		const result = await run(ai, 'conversation-tools');
		expect(result.status).toBe('completed');
		expect(requests).toHaveLength(2);
		expect(requests[0]?.tools).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: 'describe_workspace' })])
		);
		expect(
			await harness!.database.query(
				`select role, content_text, run_id, iteration_index from chat_message
				 where conversation_id = $1 order by sequence`,
				['conversation-tools']
			)
		).toEqual([
			expect.objectContaining({ role: 'user', content_text: 'Complete the task.' }),
			expect.objectContaining({
				role: 'assistant',
				content_text: 'Inspecting.',
				iteration_index: 0
			}),
			expect.objectContaining({ role: 'tool', iteration_index: 0 }),
			expect.objectContaining({
				role: 'assistant',
				content_text: 'Workspace has people.',
				iteration_index: 1
			})
		]);
	});

	it('stores an explicit compact turn as the newest context checkpoint without tools', async () => {
		const requests: Array<Extract<AIRequest, { readonly _tag: 'Turn' }>> = [];
		const ai = successfulAI((request) => {
			requests.push(request);
			return {
				output: assistantText('Decisions, constraints, and open risks.', 'compact-summary')
			};
		});
		harness = await makeBoltTestRuntime(workspace, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const result = await harness.runtime.runPromise(
			agents.enqueue(
				harness.effectId('enqueue:compact'),
				adminSubject,
				'web',
				'conversation-compact',
				'input:compact',
				Agents.userAgentInput('Keep decisions and open risks.'),
				undefined,
				undefined,
				undefined,
				'web',
				'compact'
			)
		);

		expect(result.status).toBe('completed');
		expect(requests[0]?.tools).toEqual([]);
		expect(
			await harness.database.query(
				`select app_metadata from chat_message where message_id = 'compact-summary'`
			)
		).toEqual([
			expect.objectContaining({
				app_metadata: expect.objectContaining({
					kind: 'summary',
					fold: 'compact',
					intent: 'compact'
				})
			})
		]);
	});

	it('commits the complete call batch before invoking an authored tool', async () => {
		let observed: Readonly<Record<string, unknown>> | undefined;
		const ai = successfulAI((_request, index) => ({
			output:
				index === 0
					? assistantToolCall('summarize', { path: 'src' }, 'summarize-1')
					: assistantText('Done.', 'answer-durable')
		}));
		await run(ai, 'conversation-durable', {
			remoteHandlers: {
				summarize: (() => async () => {
					const [row] = await harness!.database.query(
						`select run.status,
							(select count(*)::int from chat_message_part part
							 join chat_message message on message.message_id = part.message_id
							 where message.conversation_id = $1 and part.field = 'toolCalls') as calls
						 from agent_run run where run.conversation_id = $1`,
						['conversation-durable']
					);
					observed = row;
					return { entries: ['src'] };
				})()
			}
		});
		expect(observed).toEqual({ status: 'running', calls: 1 });
	});

	it('runs beyond the retired eight-round ceiling with stable tool-call identities', async () => {
		const effectIds: Array<string> = [];
		let turn = 0;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: (metadata, request) => {
				if (request._tag === 'Models') return modelCatalogResponse();
				effectIds.push(String(metadata.effectId));
				const output =
					turn < 10
						? assistantToolCall('describe_workspace', {}, `describe-${turn}`)
						: assistantText('Finished.', 'answer-long');
				turn += 1;
				return Promise.resolve({ _tag: 'Success', value: { output } });
			}
		};
		expect((await run(ai, 'conversation-long')).status).toBe('completed');
		expect(turn).toBe(11);
		expect(new Set(effectIds).size).toBe(effectIds.length);
	});

	it('executes an MCP tool through the connector and preserves its typed result', async () => {
		const connectorCalls: Array<ConnectorRequest> = [];
		const connector: FacilityBinding<ConnectorRequest, ConnectorResponse> = {
			call: async (_metadata, request) => {
				connectorCalls.push(request);
				const input = request.input as { readonly body?: { readonly id?: string } };
				return {
					_tag: 'Success',
					value: {
						output: {
							status: 200,
							headers: { 'content-type': 'application/json' },
							body: {
								jsonrpc: '2.0',
								id: input.body?.id ?? 'missing-id',
								result: {
									resultType: 'complete',
									content: [{ type: 'text', text: 'Two hits' }],
									structuredContent: { hits: 2 }
								}
							}
						}
					}
				};
			}
		};
		let result: Readonly<Record<string, unknown>> | undefined;
		const ai = successfulAI((request, index) => {
			if (index > 0) result = lastToolResult(request);
			return {
				output:
					index === 0
						? assistantToolCall('search:lookup', { q: 'payroll' }, 'mcp-1')
						: assistantText('Found it.', 'answer-mcp')
			};
		});
		await run(ai, 'conversation-mcp', { connector });
		expect(connectorCalls).toHaveLength(1);
		expect(result).toMatchObject({ resultType: 'complete', structuredContent: { hits: 2 } });
	});

	it('does not dispatch a provider-requested tool that was never offered', async () => {
		let connectorCalls = 0;
		const connector: FacilityBinding<ConnectorRequest, ConnectorResponse> = {
			call: async () => {
				connectorCalls += 1;
				return { _tag: 'Success', value: { output: {} } };
			}
		};
		const ai = successfulAI((_request, index) => ({
			output:
				index === 0
					? assistantToolCall('search:delete', {}, 'undeclared-1')
					: assistantText('Refused.', 'answer-refused')
		}));
		await run(ai, 'conversation-undeclared', { connector });
		expect(connectorCalls).toBe(0);
	});

	it('routes host-owned tools through the host facility', async () => {
		const calls: Array<HostToolRequest> = [];
		const hostTools: FacilityBinding<HostToolRequest, HostToolResponse> = {
			call: async (_metadata, request) => {
				calls.push(request);
				return { _tag: 'Success', value: { output: { entries: ['src'] } } };
			}
		};
		const ai = successfulAI((_request, index) => ({
			output:
				index === 0
					? assistantToolCall('sandbox_files', { path: 'src' }, 'host-1')
					: assistantText('Inspected.', 'answer-host')
		}));
		await run(ai, 'conversation-host', { hostTools });
		expect(calls).toEqual([{ tool: 'sandbox_files', input: { path: 'src' } }]);
	});

	it('awaits a spawned child within the same parent invocation', async () => {
		let parentRound = 0;
		const ai = successfulAI((request) => {
			const messages = modelMessages(request);
			const isChild = messages.some(
				(message) => message.role === 'user' && String(message.content).includes('Draft the offer')
			);
			if (isChild) return { output: assistantText('Child draft.', 'child-answer') };
			const result = lastToolResult(request);
			if (parentRound === 0) {
				parentRound += 1;
				return { output: assistantToolCall('spawn_agent', { task: 'Draft the offer' }, 'spawn-1') };
			}
			if (parentRound === 1) {
				parentRound += 1;
				return {
					output: assistantToolCall(
						'await_agent',
						{ agentId: String(result?.agentId), taskId: String(result?.taskId) },
						'await-1'
					)
				};
			}
			return { output: assistantText('Parent complete.', 'parent-answer') };
		});
		await run(ai, 'conversation-parent');
		expect(
			await harness!.database.query(`select parent_id from chat_session where parent_id = $1`, [
				'conversation-parent'
			])
		).toEqual([{ parent_id: 'conversation-parent' }]);
		expect(
			await harness!.database.query(
				`select content_text from chat_message where content_text = 'Child draft.'`
			)
		).toEqual([{ content_text: 'Child draft.' }]);
	});

	it('executes a compiled workspace tool handler and exposes its result to the next model call', async () => {
		let observed: Readonly<Record<string, unknown>> | undefined;
		const ai = successfulAI((request, index) => {
			if (index > 0) observed = lastToolResult(request);
			return {
				output:
					index === 0
						? assistantToolCall('summarize', { limit: 3 }, 'authored-1')
						: assistantText('Summary ready.', 'answer-authored')
			};
		});
		await run(ai, 'conversation-authored', {
			remoteHandlers: { summarize: (() => () => ({ count: 3 }))() }
		});
		expect(observed).toEqual({ count: 3 });
	});
});
