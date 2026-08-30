import { Effect } from 'effect';
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

describe('agent conversation queue', () => {
	it('admits a follow-up immediately and folds it in before the next tool-loop round', async () => {
		let releaseFirstRound!: () => void;
		const firstRoundHeld = new Promise<void>((resolve) => {
			releaseFirstRound = resolve;
		});
		let announceFirstRound!: () => void;
		const firstRoundStarted = new Promise<void>((resolve) => {
			announceFirstRound = resolve;
		});
		const turns: Array<Extract<AIRequest, { readonly _tag: 'Turn' }>> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Models') return { _tag: 'Success', value: modelCatalog };
				if (request._tag !== 'Turn') throw new Error('expected an AI turn');
				turns.push(request);
				if (turns.length === 1) {
					announceFirstRound();
					await firstRoundHeld;
					return {
						_tag: 'Success',
						value: {
							output: {
								toolCalls: [{ name: 'describe_workspace', input: {} }]
							}
						}
					};
				}
				return { _tag: 'Success', value: { output: { text: 'Handled both messages.' } } };
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = 'queued-follow-up';
		const first = harness.runtime.runPromise(
			agents.enqueue(
				harness.effectId('enqueue:first'),
				adminSubject,
				'web',
				conversationId,
				'turn-first',
				{ kind: 'user_message', text: 'Start the work.' }
			)
		);
		await firstRoundStarted;

		const followUp = await harness.runtime.runPromise(
			agents.enqueue(
				harness.effectId('enqueue:follow-up'),
				adminSubject,
				'web',
				conversationId,
				'turn-follow-up',
				{ kind: 'user_message', text: 'Include the newly queued detail.' }
			)
		);
		expect(followUp.status).toBe('queued');
		releaseFirstRound();
		expect((await first).status).toBe('completed');

		expect(turns).toHaveLength(2);
		expect(JSON.stringify(turns[1]?.messages)).toContain('Include the newly queued detail.');
		expect(
			await harness.database.query(
				`select turn_id, content->>'status' as status, content->'parts' as parts
				 from chat_message where conversation_id = $1 and role = 'assistant'
				 order by sequence`,
				[conversationId]
			)
		).toEqual([
			{ turn_id: 'turn-first', status: 'completed', parts: expect.any(Array) },
			{ turn_id: 'turn-follow-up', status: 'completed', parts: [] }
		]);
	});

	it('promotes a follow-up that arrives during the final model round as the next turn', async () => {
		let releaseFirstRound!: () => void;
		const firstRoundHeld = new Promise<void>((resolve) => {
			releaseFirstRound = resolve;
		});
		let announceFirstRound!: () => void;
		const firstRoundStarted = new Promise<void>((resolve) => {
			announceFirstRound = resolve;
		});
		const turns: Array<Extract<AIRequest, { readonly _tag: 'Turn' }>> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Models') return { _tag: 'Success', value: modelCatalog };
				if (request._tag !== 'Turn') throw new Error('expected an AI turn');
				turns.push(request);
				if (turns.length === 1) {
					announceFirstRound();
					await firstRoundHeld;
				}
				return { _tag: 'Success', value: { output: { text: `answer-${turns.length}` } } };
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = 'queued-after-final-check';
		const first = harness.runtime.runPromise(
			agents.enqueue(
				harness.effectId('enqueue:first'),
				adminSubject,
				'web',
				conversationId,
				'turn-first',
				{ kind: 'user_message', text: 'First.' }
			)
		);
		await firstRoundStarted;
		expect(
			(
				await harness.runtime.runPromise(
					agents.enqueue(
						harness.effectId('enqueue:second'),
						adminSubject,
						'web',
						conversationId,
						'turn-second',
						{ kind: 'user_message', text: 'Second.' }
					)
				)
			).status
		).toBe('queued');
		releaseFirstRound();
		await first;

		expect(turns).toHaveLength(2);
		expect(JSON.stringify(turns[1]?.messages)).toContain('Second.');
		expect(
			await harness.database.query(
				`select content->>'status' as status from chat_message
				 where conversation_id = $1 and role = 'assistant' order by sequence`,
				[conversationId]
			)
		).toEqual([{ status: 'completed' }, { status: 'completed' }]);
	});
});
