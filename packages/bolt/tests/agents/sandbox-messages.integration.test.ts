import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import type { AIRequest, AIResponse, FacilityBinding } from '@norbital-ai/bolt-protocol';
import * as Agents from '../../src/runtime/agents/agents.js';
import {
	encodeAgentMessage,
	parseAgentMessage
} from '../../src/runtime/agents/agent-message.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

const sender = 'conversation-auth';
const recipient = 'conversation-migrations';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const openAdjacentAgents = async (runtime: BoltTestRuntime): Promise<Agents.Interface> => {
	const agents = await runtime.runtime.runPromise(Agents.Service);
	await runtime.runtime.runPromise(
		Effect.all([
			agents.open(runtime.effectId('open:sender'), adminSubject, 'web', sender),
			agents.open(runtime.effectId('open:recipient'), adminSubject, 'web', recipient)
		])
	);
	await runtime.database.query(
		`update chat_session
		 set parent_id = $1, title = $2
		 where conversation_id = $3`,
		[sender, 'Migration and performance verification', recipient]
	);
	await runtime.database.query(
		`update chat_session set title = $1 where conversation_id = $2`,
		['Wrote bolt-owned auth module', sender]
	);
	return agents;
};

describe('messages between adjacent agents', () => {
	it('keeps a failed persisted turn terminal instead of retrying it across invocations', async () => {
		let attempts = 0;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Models') {
					return {
						_tag: 'Success',
						value: { output: { defaultModel: 'test-model', options: [{ id: 'test-model', contextLength: 128_000 }] } }
					};
				}
				attempts += 1;
				return attempts === 1
					? {
							_tag: 'Failure',
							error: {
								code: 'ai.unavailable',
								message: 'provider unavailable',
								retryable: true,
								outcome: 'known'
							}
						}
					: { _tag: 'Success', value: { output: { text: 'Recovered.' } } };
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await openAdjacentAgents(harness);
		await expect(
			harness.runtime.runPromise(
				agents.enqueue(harness.effectId('enqueue'), adminSubject, 'web', sender, 'turn-retry', {
					kind: 'user_message',
					text: 'Keep trying if the model is temporarily unavailable.'
				})
			)
		).rejects.toMatchObject({ retryable: true });
		const retried = await harness.runtime.runPromise(
			agents.execute(harness.effectId('execute:retry'), sender, 'turn-retry')
		);
		expect(retried).toMatchObject({ status: 'failed', output: null });
		expect(attempts).toBe(1);
	});

	it('stores the sender and durably queues the receiving agent', async () => {
		let round = 0;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Models') {
					return {
						_tag: 'Success',
						value: { output: { defaultModel: 'test-model', options: [{ id: 'test-model', contextLength: 128_000 }] } }
					};
				}
				round += 1;
				return {
					_tag: 'Success',
					value: {
						output:
							round === 1
								? {
									toolCalls: [
										{
											name: 'message_agent',
											input: {
												agentId: recipient,
												message: 'Those four are already fixed.'
											}
										}
									]
								}
								: { text: 'Told them.' }
					}
				};
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await openAdjacentAgents(harness);
		await harness.runtime.runPromise(
			agents.enqueue(harness.effectId('enqueue'), adminSubject, 'web', sender, 'turn-send', {
				kind: 'user_message',
				text: 'Reply to the migration agent'
			})
		);
		const messages = await harness.database.query(
			`select content from chat_message
			 where conversation_id = $1 and role = 'user'
			 order by sequence desc limit 1`,
			[recipient]
		);
		expect(parseAgentMessage(messages[0]?.content)).toEqual({
			kind: 'agent_message',
			from: {
				agentId: sender,
				agentName: 'web',
				title: 'Wrote bolt-owned auth module'
			},
			text: 'Those four are already fixed.'
		});
		const runs = await harness.database.query(
			`select content->>'status' as status from chat_message
			 where conversation_id = $1 and role = 'assistant'
			 order by created_at desc limit 1`,
			[recipient]
		);
		expect(runs[0]).toMatchObject({ status: 'running' });
	});

	it('attributes a received agent message when replaying the model prompt', async () => {
		let prompt: ReadonlyArray<Readonly<Record<string, unknown>>> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Models') {
					return {
						_tag: 'Success',
						value: { output: { defaultModel: 'test-model', options: [{ id: 'test-model', contextLength: 128_000 }] } }
					};
				}
				if (request._tag === 'Turn') {
					prompt = request.messages as ReadonlyArray<Readonly<Record<string, unknown>>>;
				}
				return { _tag: 'Success', value: { output: { text: 'Looking.' } } };
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await openAdjacentAgents(harness);
		const stored = encodeAgentMessage(
			{
				agentId: recipient,
				agentName: 'web',
				title: 'Migration and performance verification'
			},
			'Heads-up: four errors in auth-store.ts'
		);
		await harness.database.query(
			`insert into chat_message (conversation_id, role, content)
			 values ($1, 'user', $2::jsonb)`,
			[sender, JSON.stringify(stored)]
		);
		await harness.runtime.runPromise(
			agents.enqueue(harness.effectId('enqueue'), adminSubject, 'web', sender, 'turn-prompt', {
				kind: 'user_message',
				text: 'Anything outstanding?'
			})
		);
		const relayed = prompt.find(
			(message) =>
				typeof message.content === 'string' && message.content.includes(stored.text)
		);
		expect(relayed, 'the relayed message never reached the prompt').toBeDefined();
		expect(String(relayed?.content)).toContain('Migration and performance verification');
		expect(String(relayed?.content)).toContain(recipient);
		expect(typeof relayed?.content).toBe('string');
	});
});
