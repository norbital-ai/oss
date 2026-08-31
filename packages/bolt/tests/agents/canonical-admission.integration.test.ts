import { afterEach, describe, expect, it } from 'vitest';
import type { AIRequest, AIResponse, FacilityBinding } from '@norbital-ai/bolt-protocol';
import * as Agents from '../../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';
import { assistantText } from './canonical-ai-fixture.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('canonical agent admission vertical slice', () => {
	it('atomically admits an input before executing its persisted run', async () => {
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) =>
				request._tag === 'Models'
					? {
							_tag: 'Success',
							value: {
								output: {
									defaultModel: 'test-model',
									options: [{ id: 'test-model', contextLength: 128_000 }]
								}
							}
						}
					: {
							_tag: 'Success',
							value: { output: assistantText('Hello back.', 'vertical-answer') }
						}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const admitted = await harness.runtime.runPromise(
			agents.enqueue(
				harness.effectId('vertical-enqueue'),
				adminSubject,
				'web',
				'conversation-1',
				'turn-1',
				Agents.userAgentInput('Hello')
			)
		);
		expect(admitted).toMatchObject({
			conversationId: 'conversation-1',
			taskId: expect.any(String),
			turnId: 'turn-1',
			messageId: 'input:turn-1',
			runId: expect.any(String),
			status: 'completed'
		});
		expect(
			await harness.database.query(
				`select message.role, inbox.state, inbox.claimed_by_run_id
				 from chat_message message left join agent_inbox inbox
				  on inbox.message_id = message.message_id
				 where message.conversation_id = $1 order by message.sequence`,
				['conversation-1']
			)
		).toEqual([
			expect.objectContaining({ role: 'user', state: 'claimed', claimed_by_run_id: expect.any(String) }),
			expect.objectContaining({ role: 'assistant', state: null, claimed_by_run_id: null })
		]);
	});

	it('continues an incomplete goal with a durable verdict and bills every provider call once', async () => {
		const turns: Array<Extract<AIRequest, { readonly _tag: 'Turn' }>> = [];
		let implementation = 0;
		let verification = 0;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Models') {
					return {
						_tag: 'Success',
						value: {
							output: {
								defaultModel: 'test-model',
								options: [{ id: 'test-model', contextLength: 128_000 }]
							}
						}
					};
				}
				if (request._tag !== 'Turn') throw new TypeError('Unexpected embedding request');
				turns.push(request);
				if (request.responseSchema !== undefined) {
					verification += 1;
					return {
						_tag: 'Success',
						value: {
							output: verification === 1
								? { achieved: false, summary: 'One directive remains.', gaps: ['Finish it.'] }
								: { achieved: true, summary: 'All directives are complete.', gaps: [] },
							usage: verification === 1
								? { totalTokens: 3, costUsd: 0.0002, costMicroUnits: 520, costCurrency: 'SGD' }
								: { totalTokens: 4, costUsd: 0.0003, costMicroUnits: 780, costCurrency: 'SGD' }
						}
					};
				}
				implementation += 1;
				return {
					_tag: 'Success',
					value: {
						output: assistantText(implementation === 1 ? 'First attempt.' : 'Finished.', `answer-${implementation}`),
						usage: implementation === 1
							? { totalTokens: 15, costUsd: 0.001, costMicroUnits: 2_600, costCurrency: 'SGD' }
							: { totalTokens: 20, costUsd: 0.0015, costMicroUnits: 3_900, costCurrency: 'SGD' }
					}
				};
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const result = await harness.runtime.runPromise(
			agents.enqueue(
				harness.effectId('goal-enqueue'),
				adminSubject,
				'web',
				'goal-conversation',
				'goal-turn',
				Agents.userAgentInput('Complete every directive.'),
				undefined,
				undefined,
				undefined,
				undefined,
				'do',
				'Every requested directive is implemented and verified.'
			)
		);
		expect(result).toMatchObject({
			conversationId: 'goal-conversation',
			taskId: 'goal-conversation',
			status: 'completed',
			output: { text: 'Finished.' }
		});
		expect(turns).toHaveLength(4);
		expect(turns.filter(({ responseSchema }) => responseSchema !== undefined)).toHaveLength(2);
		expect(turns[0]?.messages).toContainEqual(
			expect.objectContaining({ role: 'system', content: expect.stringContaining('Task completion contract') })
		);
		expect(turns[2]?.messages).toContainEqual(
			expect.objectContaining({ role: 'user', content: expect.stringContaining('goal_verdict') })
		);
		expect(
			await harness.database.query(
				`select role, app_metadata from chat_message
				 where conversation_id = $1 order by sequence`,
				['goal-conversation']
			)
		).toEqual([
			expect.objectContaining({ role: 'user', app_metadata: expect.objectContaining({ kind: 'input' }) }),
			expect.objectContaining({ role: 'assistant' }),
			expect.objectContaining({ role: 'user', app_metadata: expect.objectContaining({ kind: 'goal', attempt: 1, exhausted: false }) }),
			expect.objectContaining({ role: 'assistant' }),
			expect.objectContaining({ role: 'user', app_metadata: expect.objectContaining({ kind: 'goal', attempt: 2, exhausted: false }) })
		]);
		expect(
			await harness.database.query(
				`select cause, status from agent_run
				 where conversation_id = $1 order by generation`,
				['goal-conversation']
			)
		).toEqual([
			{ cause: 'input', status: 'completed' },
			{ cause: 'goal', status: 'completed' }
		]);
		expect(
			await harness.database.query(
				`select usage_cost_usd, usage_cost_micro_units, usage_cost_currency,
					usage_total_tokens, usage_turns_counted, usage_turns_unreported
				 from chat_session where conversation_id = $1`,
				['goal-conversation']
			)
		).toEqual([{
			usage_cost_usd: 0.003,
			usage_cost_micro_units: 7_800,
			usage_cost_currency: 'SGD',
			usage_total_tokens: 42,
			usage_turns_counted: 2,
			usage_turns_unreported: 0
		}]);
	});

	it('stops bounded goal continuation at needs attention', async () => {
		let calls = 0;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Models') {
					return {
						_tag: 'Success',
						value: { output: { defaultModel: 'test-model',
							options: [{ id: 'test-model', contextLength: 128_000 }] } }
					};
				}
				if (request._tag !== 'Turn') throw new TypeError('Unexpected embedding request');
				calls += 1;
				return {
					_tag: 'Success',
					value: {
						output: request.responseSchema === undefined
							? assistantText(`Attempt ${Math.ceil(calls / 2)}.`, `bounded-${calls}`)
							: { achieved: false, summary: 'Still incomplete.', gaps: ['Required proof is absent.'] },
						usage: { totalTokens: 1, costUsd: 0, costMicroUnits: 0, costCurrency: 'SGD' }
					}
				};
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const result = await harness.runtime.runPromise(
			agents.enqueue(
				harness.effectId('bounded-goal'), adminSubject, 'web', 'bounded-goal', 'turn',
				Agents.userAgentInput('Complete it.'), undefined, undefined, undefined, undefined, 'do',
				'Required proof exists in the durable transcript.'
			)
		);
		expect(result.status).toBe('needs_attention');
		expect(calls).toBe(6);
		expect(
			await harness.database.query(
				`select app_metadata->>'attempt' as attempt, app_metadata->>'exhausted' as exhausted
				 from chat_message where conversation_id = $1 and app_metadata->>'kind' = 'goal'
				 order by sequence`,
				['bounded-goal']
			)
		).toEqual([
			{ attempt: '1', exhausted: 'false' },
			{ attempt: '2', exhausted: 'false' },
			{ attempt: '3', exhausted: 'true' }
		]);
		expect(
			await harness.database.query(
				`select cause, status from agent_run where conversation_id = $1 order by generation`,
				['bounded-goal']
			)
		).toEqual([
			{ cause: 'input', status: 'completed' },
			{ cause: 'goal', status: 'completed' },
			{ cause: 'goal', status: 'completed' }
		]);
	});
});
