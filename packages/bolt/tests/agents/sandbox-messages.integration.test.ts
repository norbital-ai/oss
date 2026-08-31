import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import type { AIRequest, AIResponse, FacilityBinding } from '@norbital-ai/bolt-protocol';
import * as Agents from '../../src/runtime/agents/agents.js';
import {
	delegatedAgentInput,
	type DelegatedMessage
} from '../../src/runtime/agents/agent-runtime.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';
import {
	assistantText,
	assistantToolCall
} from './canonical-ai-fixture.js';

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
		 set parent_id = $1, sandbox_key = $1, title = $2
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
					: { _tag: 'Success', value: { output: assistantText('Recovered.', 'recovered') } };
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await openAdjacentAgents(harness);
		const failed = await harness.runtime.runPromise(
			agents.enqueue(harness.effectId('enqueue'), adminSubject, 'web', sender, 'turn-retry', Agents.userAgentInput('Keep trying if the model is temporarily unavailable.'))
		);
		expect(failed.status).toBe('failed');
		if (failed.runId === undefined) throw new Error('expected a failed run id');
		const retried = await harness.runtime.runPromise(
			agents.execute(harness.effectId('execute:retry'), sender, failed.runId)
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
								? assistantToolCall(
										'message_agent',
										{ agentId: recipient, message: 'Those four are already fixed.' },
										'message-recipient'
									)
								: assistantText('Told them.', 'told-them')
					}
				};
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await openAdjacentAgents(harness);
		await harness.runtime.runPromise(
			agents.enqueue(harness.effectId('enqueue'), adminSubject, 'web', sender, 'turn-send', Agents.userAgentInput('Reply to the migration agent'))
		);
		const messages = await harness.database.query(
			`select app_metadata->'delegated' as delegated from chat_message
			 where conversation_id = $1 and role = 'user'
			 order by sequence desc limit 1`,
			[recipient]
		);
			expect(messages[0]?.delegated).toEqual({
				from: {
				agentId: sender,
				agentName: 'web',
				title: 'Wrote bolt-owned auth module'
			},
			text: 'Those four are already fixed.'
		});
		const runs = await harness.database.query(
			`select status from agent_run where conversation_id = $1 order by generation desc limit 1`,
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
				return { _tag: 'Success', value: { output: assistantText('Looking.', 'looking') } };
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await openAdjacentAgents(harness);
			const stored: DelegatedMessage = {
				from: {
					agentId: recipient,
					agentName: 'web',
					title: 'Migration and performance verification'
				},
				text: 'Heads-up: four errors in auth-store.ts'
			};
		await harness.database.query(
			`insert into chat_message
			 (message_id, conversation_id, role, content_kind, content_text, search_text,
			  app_metadata, semantic_hash)
			 values ('relayed-message', $1, 'user', 'text', $2, $2, $3::jsonb, 'relayed-hash')`,
			[
				sender,
					delegatedAgentInput(stored).message.content,
				JSON.stringify({
					version: 1,
					kind: 'input',
					source: 'delegated',
					intent: 'do',
					delegated: stored
				})
			]
		);
		await harness.runtime.runPromise(
			agents.enqueue(harness.effectId('enqueue'), adminSubject, 'web', sender, 'turn-prompt', Agents.userAgentInput('Anything outstanding?'))
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
