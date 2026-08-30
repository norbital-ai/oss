import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import type { AIRequest, AIResponse, FacilityBinding } from '@norbital-ai/bolt-protocol';
import * as Agents from '../../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

/**
 * A model that answers one turn with plain text.
 *
 * Admission runs the turn inside the invoking request, so the assistant row this test counts only
 * exists once a provider is bound. One text answer is the smallest complete turn there is.
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
			: { _tag: 'Success', value: { output: { text: 'Payroll started.' } } }
});

describe('agent conversation admission', () => {
	it('commits one conversation, mailbox, and completed turn in the invoking request', async () => {
		harness = await makeBoltTestRuntime(testWorkspace(), { ai: respondsOnce() });
		const runtime = harness;
		const admitted = await runtime.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Agents.Service).enqueue(
					runtime.effectId('atomic-admission'),
					adminSubject,
					'web',
					'atomic-conversation',
					'atomic-turn',
					{ kind: 'user_message', text: 'Run payroll' }
				);
			})
		);
		expect(admitted).toMatchObject({
			conversationId: 'atomic-conversation',
			status: 'completed'
		});

		const counts = await runtime.database.query(
			`select
				(select count(*)::int from chat_session where conversation_id = $1) as sessions,
				(select count(*)::int from chat_message where conversation_id = $1) as messages,
				(select count(*)::int from agent_mailbox where conversation_id = $1) as mailboxes`,
			['atomic-conversation']
		);
		expect(counts[0]).toEqual({ sessions: 1, messages: 2, mailboxes: 1 });
		expect(
			await runtime.database.query(
				`select distinct collection_name
				 from bolt_sync_outbox
				 where collection_name in ('chat_session', 'chat_message', 'agent_mailbox')
				 order by collection_name`
			)
		).toEqual([
			{ collection_name: 'agent_mailbox' },
			{ collection_name: 'chat_message' },
			{ collection_name: 'chat_session' }
		]);

		// A lost HTTP response is retried under the caller-owned turn id. Every insert is idempotent,
		// including the two transcript rows, so the retry is the same admission rather than a second turn.
		await runtime.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Agents.Service).enqueue(
					runtime.effectId('atomic-admission-retry'),
					adminSubject,
					'web',
					'atomic-conversation',
					'atomic-turn',
					{ kind: 'user_message', text: 'Run payroll' }
				);
			})
		);
		const afterRetry = await runtime.database.query(
			`select
				(select count(*)::int from chat_session where conversation_id = $1) as sessions,
				(select count(*)::int from chat_message where conversation_id = $1) as messages,
				(select count(*)::int from agent_mailbox where conversation_id = $1) as mailboxes`,
			['atomic-conversation']
		);
		expect(afterRetry[0]).toEqual({ sessions: 1, messages: 2, mailboxes: 1 });
		// A fresh query has no admission response or component state to lean on. It sees the same
		// persisted transcript and queue projection a remounted sync client will reconstruct.
		expect(
			await runtime.database.query(
				`select
					(select title from chat_session where conversation_id = $1) as title,
					(select content->>'text' from chat_message
					 where conversation_id = $1 and turn_id = $2 and role = 'user') as message,
					(select status from agent_mailbox where conversation_id = $1) as mailbox_status,
					(select content->>'status' from chat_message
					 where conversation_id = $1 and turn_id = $2 and role = 'assistant') as turn_status`,
				['atomic-conversation', 'atomic-turn']
			)
		).toEqual([
			{
				title: 'Run payroll',
				message: 'Run payroll',
				mailbox_status: 'active',
				turn_status: 'completed'
			}
		]);

		// The same id carrying different work is the conflict the guard exists for. A turn is
		// identified by its conversation and its id — that is the transcript's own unique key — so
		// the reuse under test is a second admission of `atomic-turn` in the conversation that
		// already holds it. The immutable transcript rows must describe this exact admission, so the
		// whole transaction rolls back rather than answering with a receipt for work it did not do.
		await expect(
			runtime.runtime.runPromise(
				Effect.gen(function* () {
					return yield* (yield* Agents.Service).enqueue(
						runtime.effectId('atomic-admission-conflict'),
						adminSubject,
						'web',
						'atomic-conversation',
						'atomic-turn',
						{ kind: 'user_message', text: 'Different work' }
					);
				})
			)
		).rejects.toBeDefined();
		const unchanged = await runtime.database.query(
			`select
				(select count(*)::int from chat_session where conversation_id = $1) as sessions,
				(select count(*)::int from chat_message where conversation_id = $1) as messages,
				(select count(*)::int from agent_mailbox where conversation_id = $1) as mailboxes,
				(select content->>'text' from chat_message
				 where conversation_id = $1 and turn_id = $2 and role = 'user') as message`,
			['atomic-conversation', 'atomic-turn']
		);
		expect(unchanged[0]).toEqual({
			sessions: 1,
			messages: 2,
			mailboxes: 1,
			message: 'Run payroll'
		});
	});
});
