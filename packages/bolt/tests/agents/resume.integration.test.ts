import { afterEach, describe, expect, it } from 'vitest';
import type { AIRequest, AIResponse, FacilityBinding } from '@norbital-ai/bolt-protocol';
import * as Agents from '../../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const modelCatalog: AIResponse = {
	output: {
		defaultModel: 'test-model',
		options: [{ id: 'test-model', contextLength: 128_000 }]
	}
};

describe('agent replay controls', () => {
	it('replays only the newest stopped turn in one ordinary invocation', async () => {
		let turns = 0;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Models') return { _tag: 'Success', value: modelCatalog };
				turns += 1;
				return { _tag: 'Success', value: { output: { text: 'resumed once' } } };
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = 'resume-newest-only';
		await harness.runtime.runPromise(
			agents.open(harness.effectId('open'), adminSubject, 'web', conversationId)
		);
		await harness.database.query(
			`insert into agent_mailbox (conversation_id, status) values ($1, 'stopped')`,
			[conversationId]
		);
		for (const id of ['first', 'second']) {
			await harness.database.query(
				`insert into chat_message (conversation_id, turn_id, role, content)
				 values ($1, $2, 'user', $3::jsonb),
				        ($1, $2, 'assistant', $4::jsonb)`,
				[
					conversationId,
					`stopped-${id}`,
					JSON.stringify({ kind: 'user_message', text: id }),
					JSON.stringify({
						id: `stopped-${id}`,
						status: 'stopped',
						depth: 0,
						parts: [],
						subject: adminSubject,
						agent_name: 'web',
						usage_unreported: false
					})
				]
			);
		}
		await harness.runtime.runPromise(
			agents.resume(harness.effectId('resume'), adminSubject, conversationId)
		);

		expect(turns).toBe(1);
		const rows = await harness.database.query(
			`select turn_id, content->>'status' as status
			 from chat_message
			 where conversation_id = $1 and role = 'assistant'
			 order by sequence`,
			[conversationId]
		);
		expect(rows).toEqual([
			{ turn_id: 'stopped-first', status: 'stopped' },
			{ turn_id: 'stopped-second', status: 'completed' }
		]);
	});

	it('joins the exact requested child turn rather than draining sibling work', async () => {
		let turns = 0;
		const childId = 'agent:fifo-parent-turn:tool:0:0';
		const newerTaskId = 'fifo-parent-turn:tool:1:0';
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Models') return { _tag: 'Success', value: modelCatalog };
				turns += 1;
				const output: AIResponse['output'] =
					turns === 1
						? { toolCalls: [{ name: 'spawn_agent', input: { task: 'older child task' } }] }
						: turns === 2
							? { toolCalls: [{ name: 'message_agent', input: { agentId: childId, message: 'newer child task' } }] }
							: turns === 3
								? { toolCalls: [{ name: 'await_agent', input: { agentId: childId, taskId: newerTaskId } }] }
								: turns === 4
									? { text: 'newer child finished' }
									: { text: 'parent joined newer child' };
				return { _tag: 'Success', value: { output } };
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		await harness.runtime.runPromise(
			agents.enqueue(
				harness.effectId('enqueue'),
				adminSubject,
				'web',
				'fifo-parent',
				'fifo-parent-turn',
				{ kind: 'user_message', text: 'join only the named child' }
			)
		);

		expect(turns).toBe(5);
		const rows = await harness.database.query(
			`select turn_id, content->>'status' as status
			 from chat_message
			 where conversation_id = $1 and role = 'assistant'
			 order by sequence`,
			[childId]
		);
		expect(rows).toEqual([
			{ turn_id: 'fifo-parent-turn:tool:0:0', status: 'running' },
			{ turn_id: newerTaskId, status: 'completed' }
		]);
	});

	it('executes each admitted user turn in its own invocation boundary', async () => {
		const turns: Array<Extract<AIRequest, { readonly _tag: 'Turn' }>> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Models') return { _tag: 'Success', value: modelCatalog };
				if (request._tag === 'Turn') turns.push(request);
				return { _tag: 'Success', value: { output: { text: `answer-${turns.length}` } } };
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = 'one-turn-per-invocation';
		for (const id of ['first', 'second']) {
			await harness.runtime.runPromise(
				agents.enqueue(
					harness.effectId(`enqueue:${id}`),
					adminSubject,
					'web',
					conversationId,
					`turn-${id}`,
					{ kind: 'user_message', text: id }
				)
			);
		}

		expect(turns).toHaveLength(2);
		const rows = await harness.database.query(
			`select turn_id, content->>'status' as status
			 from chat_message
			 where conversation_id = $1 and role = 'assistant'
			 order by sequence`,
			[conversationId]
		);
		expect(rows).toEqual([
			{ turn_id: 'turn-first', status: 'completed' },
			{ turn_id: 'turn-second', status: 'completed' }
		]);
	});

	it('replays committed parts through the ordinary execution path', async () => {
		const turns: Array<Extract<AIRequest, { readonly _tag: 'Turn' }>> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Models') return { _tag: 'Success', value: modelCatalog };
				if (request._tag === 'Turn') turns.push(request);
				return { _tag: 'Success', value: { output: { text: 'Continued from rows.' } } };
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = 'fresh-resume';
		const admitted = await harness.runtime.runPromise(
			agents.enqueue(
				harness.effectId('enqueue'),
				adminSubject,
				'web',
				conversationId,
				'turn-stopped',
				{ kind: 'user_message', text: 'Continue this from durable history.' }
			)
		);
		await harness.database.query(
			`update chat_message set content = jsonb_set(content, '{status}', '"stopped"'::jsonb)
			 where conversation_id = $1 and turn_id = $2 and role = 'assistant'`,
			[conversationId, admitted.turnId]
		);
		await harness.database.query(
			`update agent_mailbox set status = 'stopped' where conversation_id = $1`,
			[conversationId]
		);
		turns.length = 0;
		await harness.runtime.runPromise(
			agents.resume(harness.effectId('resume'), adminSubject, conversationId)
		);

		expect(turns).toHaveLength(1);
		expect(JSON.stringify(turns[0]?.messages)).toContain('Continue this from durable history.');
		const messages = await harness.database.query(
			`select content from chat_message
			 where conversation_id = $1 and turn_id = $2 and role = 'assistant'
			 limit 1`,
			[admitted.conversationId, admitted.turnId]
		);
		expect(messages[0]?.content).toMatchObject({
			id: admitted.turnId,
			status: 'completed'
		});
	});

	it('does not turn a failed invocation into an implicit retry ladder', async () => {
		let attempts = 0;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Models') return { _tag: 'Success', value: modelCatalog };
				attempts += 1;
				return {
					_tag: 'Failure',
					error: {
						code: 'ai.unavailable',
						message: 'provider unavailable',
						retryable: true,
						outcome: 'known'
					}
				};
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = 'failed-is-terminal';
		await expect(
			harness.runtime.runPromise(
				agents.enqueue(
					harness.effectId('enqueue'),
					adminSubject,
					'web',
					conversationId,
					'turn-failed',
					{ kind: 'user_message', text: 'Fail once.' }
				)
			)
		).rejects.toMatchObject({ retryable: true });
		const replay = await harness.runtime.runPromise(
			agents.execute(harness.effectId('execute:again'), conversationId, 'turn-failed')
		);
		expect(replay.status).toBe('failed');
		expect(attempts).toBe(1);
	});
});
