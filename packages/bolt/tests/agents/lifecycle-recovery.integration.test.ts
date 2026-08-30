import { afterEach, describe, expect, it } from 'vitest';
import type { AIRequest, AIResponse, FacilityBinding } from '@norbital-ai/bolt-protocol';
import * as Agents from '../../src/runtime/agents/agents.js';
import { closeUnpairedToolCalls } from '../../src/runtime/agents/turn.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

/**
 * A model that answers once, plainly.
 *
 * `enqueue` runs the turn inside the admitting request, so a conversation cannot be opened at all
 * without a bound provider. What it answers is not what these tests are about — the transcript they
 * assert on is written over the top of it — so the stub says the least a turn can say.
 */
const respondsOnce = (): FacilityBinding<AIRequest, AIResponse> => ({
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
			: { _tag: 'Success', value: { output: { text: 'Acknowledged.' } } }
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('agent host lifecycle recovery', () => {
	it('adds one terminal result for every unmatched committed call without duplicating pairs', () => {
		expect(
			closeUnpairedToolCalls(
				[
					{ kind: 'tool', id: 'settled', name: 'first', input: null },
					{ kind: 'tool-result', id: 'settled', name: 'first', output: 'done' },
					{ kind: 'tool', id: 'open-a', name: 'second', input: null },
					{ kind: 'tool', id: 'open-b', name: 'third', input: null }
				],
				'interrupted'
			).filter((part) => part.kind === 'tool-result')
		).toMatchObject([
			{ id: 'settled', output: 'done' },
			{ id: 'open-a', output: { terminal: true, reason: 'interrupted' } },
			{ id: 'open-b', output: { terminal: true, reason: 'interrupted' } }
		]);
	});

	it('atomically interrupts persisted running rows at the environment-load gate', async () => {
		harness = await makeBoltTestRuntime();
		const turnId = 'persisted-running-turn';
		await harness.database.query(
			`insert into chat_session
				(conversation_id, agent_name, user_id, sandbox_key, visibility)
			 values ($1, 'web', $2, $2, 'personal')`,
			['fresh-runtime-recovery', adminSubject.userId]
		);
		await harness.database.query(
			`insert into agent_mailbox (conversation_id, status) values ($1, 'active')`,
			['fresh-runtime-recovery']
		);
		await harness.database.query(
			`insert into chat_message (conversation_id, turn_id, role, content)
			 values ($1, $2, 'assistant', $3::jsonb)`,
			[
				'fresh-runtime-recovery',
				turnId,
				JSON.stringify({
					id: turnId,
					status: 'running',
					parts: [{ kind: 'tool', id: 'open-call', name: 'describe_workspace', input: {} }],
					subject: adminSubject,
					agent_name: 'web'
				})
			]
		);
		const agents = await harness.runtime.runPromise(Agents.Service);
		await harness.runtime.runPromise(
			agents.recover(harness.effectId('environment-load-recovery'))
		);

		const messages = await harness.database.query(
			`select content from chat_message
			 where conversation_id = $1 and turn_id = $2 and role = 'assistant'`,
			['fresh-runtime-recovery', turnId]
		);
		expect(messages[0]?.content).toMatchObject({
			status: 'interrupted',
			parts: [
				{ kind: 'tool', id: 'open-call' },
				{ kind: 'tool-result', id: 'open-call', output: { terminal: true, reason: 'host-restarted' } }
			]
		});
	});

	it('closes a committed in-flight tool call before a stop can interrupt its invocation', async () => {
		harness = await makeBoltTestRuntime(undefined, { ai: respondsOnce() });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = 'stop-during-tool';
		const admitted = await harness.runtime.runPromise(
			agents.enqueue(
				harness.effectId('enqueue'),
				adminSubject,
				'web',
				conversationId,
				'stop-tool-turn',
				{ kind: 'user_message', text: 'Use a tool.' }
			)
		);
		await harness.database.query(
			`update chat_message
			 set content = jsonb_set(
				jsonb_set(content, '{status}', '"running"'::jsonb),
				'{parts}', $3::jsonb
			 )
			 where conversation_id = $1 and turn_id = $2 and role = 'assistant'`,
			[
				conversationId,
				admitted.turnId,
				JSON.stringify([
					{ kind: 'tool', id: 'completed-call', name: 'describe_workspace', input: {} },
					{
						kind: 'tool-result',
						id: 'completed-call',
						name: 'describe_workspace',
						output: { rows: ['real result committed immediately before stop'] }
					},
					{ kind: 'tool', id: 'committed-call', name: 'describe_workspace', input: {} }
				])
			]
		);

		await harness.runtime.runPromise(
			agents.stop(harness.effectId('stop'), adminSubject, conversationId)
		);
		const messages = await harness.database.query(
			`select content from chat_message
			 where conversation_id = $1 and turn_id = $2 and role = 'assistant'`,
			[conversationId, admitted.turnId]
		);
		expect(messages[0]?.content).toMatchObject({
			status: 'stopped',
			parts: [
				{ kind: 'tool', id: 'completed-call' },
				{
					kind: 'tool-result',
					id: 'completed-call',
					output: { rows: ['real result committed immediately before stop'] }
				},
				{ kind: 'tool', id: 'committed-call' },
				{ kind: 'tool-result', id: 'committed-call', output: { terminal: true, reason: 'stopped' } }
			]
		});
	});
});
