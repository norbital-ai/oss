import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AIRequest } from '@norbital-ai/bolt-protocol';
import {
	AgentId,
	DirectiveMode,
	DirectivePriority,
	ConversationId
} from '@norbital-ai/bolt-protocol';
import * as Agents from '../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { fileURLToPath } from 'node:url';
import { cassetteTranscript, readCassetteFile } from '@norbital-ai/test-utilities';
import { Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { scriptedTranscript } from './agents-canonical-ai-fixture.js';
import type { AIResponse, FacilityBinding } from '@norbital-ai/bolt-protocol';
const cassette = (name: string) =>
	readCassetteFile(fileURLToPath(new URL(`./assets/${name}.cassette.json`, import.meta.url)));

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const taskRequest = (
	conversationId: ConversationId,
	text: string,
	priority: 'normal' | 'steer' = 'normal'
) => ({
	conversationId,
	agentId: AgentId.make('web'),
	message: Agents.userAgentInput(text),
	mode: DirectiveMode.make('agent'),
	priority: DirectivePriority.make(priority)
});

const encodeMessage = Schema.encodeSync(Prompt.Message);
const assistant = (text: string) =>
	encodeMessage(Prompt.assistantMessage({ content: [Prompt.textPart({ text })] }));

describe('Task directive queue', () => {
	it('refuses removal when a pending message is claimed after the queue read', async () => {
		harness = await makeBoltTestRuntime();
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000507');
		const sent = await harness.runtime.runPromise(
			agents.submit(
				harness.effectId('race:submit'),
				adminSubject,
				taskRequest(conversationId, 'Keep the claimed message.')
			)
		);
		const original = harness.database.binding.call;
		let raced = false;
		const intercept = vi
			.spyOn(harness.database.binding, 'call')
			.mockImplementation(async (...args) => {
				const result = await original(...args);
				const request = args[1];
				if (
					!raced &&
					request._tag === 'Query' &&
					request.sql.includes('conversation_message') &&
					request.parameters.includes('queued')
				) {
					raced = true;
					await harness!.database.query(
						"update conversation_message set state = 'consumed', row_version = row_version + 1 where id = $1",
						[sent.messageId]
					);
				}
				return result;
			});
		try {
			await expect(
				harness.runtime.runPromise(
					agents.updateQueue(harness.effectId('race:remove'), adminSubject, {
						conversationId,
						change: { action: 'remove', messageId: sent.messageId }
					})
				)
			).rejects.toThrow();
			expect(raced).toBe(true);
			expect(
				await harness.database.query('select state from conversation_message where id = $1', [
					sent.messageId
				])
			).toEqual([{ state: 'consumed' }]);
		} finally {
			intercept.mockRestore();
		}
	});

	it('reorders and removes pending messages without rewriting history or executing removed work', async () => {
		const twin = scriptedTranscript([assistant('Third answered.'), assistant('First answered.')]);
		harness = await makeBoltTestRuntime(undefined, { ai: twin.ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000504');
		const sent = [];
		for (const text of ['First request.', 'Removed request.', 'Third request.']) {
			sent.push(
				await harness.runtime.runPromise(
					agents.submit(harness.effectId(text), adminSubject, taskRequest(conversationId, text))
				)
			);
		}
		await harness.runtime.runPromise(
			agents.updateQueue(harness.effectId('reorder'), adminSubject, {
				conversationId,
				change: {
					action: 'reorder',
					messageIds: [sent[2]!.messageId, sent[1]!.messageId, sent[0]!.messageId]
				}
			})
		);
		await harness.runtime.runPromise(
			agents.updateQueue(harness.effectId('remove'), adminSubject, {
				conversationId,
				change: { action: 'remove', messageId: sent[1]!.messageId }
			})
		);
		await harness.runtime.runPromise(
			agents.answerQueued(harness.effectId('answer'), adminSubject, conversationId)
		);
		expect(twin.requests).toHaveLength(2);
		expect(JSON.stringify(twin.requests[0]?.messages)).toContain('Third request.');
		expect(JSON.stringify(twin.requests[0]?.messages)).not.toContain('First request.');
		expect(JSON.stringify(twin.requests[1]?.messages)).toContain('First request.');
		const continued = JSON.stringify(twin.requests[1]?.messages);
		expect(continued.indexOf('First request.')).toBeGreaterThan(
			continued.indexOf('Third answered.')
		);
		expect(JSON.stringify(twin.requests)).not.toContain('Removed request.');
		expect(
			await harness.database.query(
				'select sequence, state from conversation_message where conversation_id = $1 and state is not null order by sequence',
				[conversationId]
			)
		).toEqual([
			{ sequence: 1, state: 'consumed' },
			{ sequence: 2, state: 'removed' },
			{ sequence: 3, state: 'consumed' }
		]);
		await expect(
			harness.runtime.runPromise(
				agents.updateQueue(harness.effectId('too-late'), adminSubject, {
					conversationId,
					change: { action: 'remove', messageId: sent[0]!.messageId }
				})
			)
		).rejects.toThrow('queue changed');
	});

	it('refuses duplicate, incomplete, and foreign queue changes', async () => {
		harness = await makeBoltTestRuntime();
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000505');
		const first = await harness.runtime.runPromise(
			agents.submit(harness.effectId('first'), adminSubject, taskRequest(conversationId, 'First.'))
		);
		const second = await harness.runtime.runPromise(
			agents.submit(
				harness.effectId('second'),
				adminSubject,
				taskRequest(conversationId, 'Second.')
			)
		);
		for (const messageIds of [[first.messageId, first.messageId], [first.messageId]]) {
			await expect(
				harness.runtime.runPromise(
					agents.updateQueue(harness.effectId(`invalid:${messageIds.length}`), adminSubject, {
						conversationId,
						change: { action: 'reorder', messageIds }
					})
				)
			).rejects.toThrow('queue changed');
		}
		const foreign = ConversationId.make('00000000-0000-4000-8000-000000000506');
		await harness.runtime.runPromise(
			agents.submit(harness.effectId('foreign'), adminSubject, taskRequest(foreign, 'Other task.'))
		);
		await expect(
			harness.runtime.runPromise(
				agents.updateQueue(harness.effectId('cross-task'), adminSubject, {
					conversationId: foreign,
					change: { action: 'remove', messageId: second.messageId }
				})
			)
		).rejects.toThrow('queue changed');
	});

	/**
	 * One `conversations.send` answers everything waiting, not only the message it carried.
	 *
	 * This is what replaced the durable work occurrence between turns, and `answerQueued` is the only
	 * place it lives — `execute` deliberately answers one message so an envoy or a schedule runs
	 * exactly the turn it came for. Every other suite in this file calls `execute`, so all of them
	 * would stay green if the drain regressed, while a follow-up admitted mid-turn sat unanswered
	 * until somebody called again.
	 */
	it('answers a follow-up admitted mid-turn without waiting to be called again', async () => {
		let releaseGeneration!: () => void;
		const generationHeld = new Promise<void>((resolve) => {
			releaseGeneration = resolve;
		});
		let announceGeneration!: () => void;
		const generationStarted = new Promise<void>((resolve) => {
			announceGeneration = resolve;
		});
		const twin = scriptedTranscript([
			assistant('Answering the first.'),
			assistant('Answering the follow-up.')
		]);
		let held = false;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: (metadata, request, signal, onProgress) => {
				if (request._tag === 'Generate' && !held) {
					held = true;
					announceGeneration();
					return generationHeld.then(() => twin.ai.call(metadata, request, signal, onProgress));
				}
				return twin.ai.call(metadata, request, signal, onProgress);
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000503');
		await harness.runtime.runPromise(
			agents.submit(
				harness.effectId('drain:first'),
				adminSubject,
				taskRequest(conversationId, 'First.')
			)
		);
		// The whole point: `answerQueued`, not `execute`.
		const answering = harness.runtime.runPromise(
			agents.answerQueued(harness.effectId('drain:answer'), adminSubject, conversationId)
		);
		await generationStarted;
		await harness.runtime.runPromise(
			agents.submit(
				harness.effectId('drain:follow-up'),
				adminSubject,
				taskRequest(conversationId, 'And also this.')
			)
		);
		releaseGeneration();
		await answering;

		// Two questions, two turns, nothing left waiting — from the one call.
		expect(twin.requests).toHaveLength(2);
		expect(
			await harness.database.query(
				`select state from conversation_message
				 where conversation_id = $1 and state is not null order by sequence`,
				[conversationId]
			)
		).toEqual([{ state: 'consumed' }, { state: 'consumed' }]);
	});

	it('durably queues a follow-up outside the active run input boundary', async () => {
		let releaseGeneration!: () => void;
		const generationHeld = new Promise<void>((resolve) => {
			releaseGeneration = resolve;
		});
		let announceGeneration!: () => void;
		const generationStarted = new Promise<void>((resolve) => {
			announceGeneration = resolve;
		});
		const twin = cassetteTranscript(cassette('agents-queue-first'));
		const generated = twin.requests;
		let held = false;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: (metadata, request, signal, onProgress) => {
				if (request._tag === 'Generate' && !held) {
					held = true;
					announceGeneration();
					return generationHeld.then(() => twin.ai.call(metadata, request, signal, onProgress));
				}
				return twin.ai.call(metadata, request, signal, onProgress);
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000501');
		await harness.runtime.runPromise(
			agents.submit(
				harness.effectId('queue:first-submit'),
				adminSubject,
				taskRequest(conversationId, 'Start the work.')
			)
		);
		const execution = harness.runtime.runPromise(
			agents.execute(harness.effectId('queue:first-execute'), adminSubject, conversationId)
		);
		await generationStarted;
		const followUp = await harness.runtime.runPromise(
			agents.submit(
				harness.effectId('queue:follow-up-submit'),
				adminSubject,
				taskRequest(conversationId, 'Include the newly queued detail.')
			)
		);
		expect(followUp.messageId).toEqual(expect.any(String));
		releaseGeneration();
		expect((await execution).status).toBe('idle');

		expect(generated).toHaveLength(1);
		expect(JSON.stringify(generated[0]?.messages)).not.toContain('newly queued detail');
		expect(
			await harness.database.query(
				`select sequence, state, priority, turn_id is not null as claimed
				 from conversation_message where conversation_id = $1 and state is not null order by sequence`,
				[conversationId]
			)
		).toEqual([
			{ sequence: 1, state: 'consumed', priority: 'normal', claimed: true },
			{ sequence: 2, state: 'queued', priority: 'normal', claimed: false }
		]);
		expect(
			await harness.database.query(
				`select input_through_sequence, status from turn where conversation_id = $1`,
				[conversationId]
			)
		).toEqual([{ input_through_sequence: 1, status: 'succeeded' }]);
		expect(
			(
				await harness.runtime.runPromise(
					agents.execute(harness.effectId('queue:follow-up-execute'), adminSubject, conversationId)
				)
			).status
		).toBe('done');
		expect(generated).toHaveLength(2);
		expect(JSON.stringify(generated[1]?.messages)).toContain('newly queued detail');
	});

	it('claims a steering directive ahead of an older normal directive', async () => {
		const twin = cassetteTranscript(cassette('agents-queue-steer'));
		const generated = twin.requests;
		harness = await makeBoltTestRuntime(undefined, { ai: twin.ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000502');
		await harness.runtime.runPromise(
			agents.submit(
				harness.effectId('priority:normal'),
				adminSubject,
				taskRequest(conversationId, 'Normal work.')
			)
		);
		const steering = await harness.runtime.runPromise(
			agents.submit(
				harness.effectId('priority:steer'),
				adminSubject,
				taskRequest(conversationId, 'Do this first.', 'steer')
			)
		);
		await harness.runtime.runPromise(
			agents.execute(harness.effectId('priority:execute'), adminSubject, conversationId)
		);

		expect(generated).toHaveLength(1);
		expect(JSON.stringify(generated[0]?.messages)).toContain('Do this first.');
		expect(
			await harness.database.query(
				`select id, sequence, priority, state
				 from conversation_message where conversation_id = $1 and state is not null order by sequence`,
				[conversationId]
			)
		).toEqual([
			expect.objectContaining({ sequence: 1, priority: 'normal', state: 'queued' }),
			{ id: steering.messageId, sequence: 2, priority: 'steer', state: 'consumed' }
		]);
	});
});
