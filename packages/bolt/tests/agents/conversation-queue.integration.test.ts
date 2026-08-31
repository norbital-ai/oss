import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import type { AIRequest, AIResponse, FacilityBinding } from '@norbital-ai/bolt-protocol';
import * as Agents from '../../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';
import { assistantText, assistantToolCall } from './canonical-ai-fixture.js';

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
	it('admits a follow-up immediately but keeps it outside the active run boundary', async () => {
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
							output: assistantToolCall('describe_workspace', {}, 'queue-describe')
						}
					};
				}
				return {
					_tag: 'Success',
					value: { output: assistantText(`answer-${turns.length}`, `queue-answer-${turns.length}`) }
				};
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
				Agents.userAgentInput('Start the work.')
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
				Agents.userAgentInput('Include the newly queued detail.')
			)
		);
		expect(followUp.status).toBe('pending');
		releaseFirstRound();
		expect((await first).status).toBe('completed');

		expect(turns).toHaveLength(3);
		expect(JSON.stringify(turns[1]?.messages)).not.toContain('Include the newly queued detail.');
		expect(JSON.stringify(turns[2]?.messages)).toContain('Include the newly queued detail.');
		expect(
			await harness.database.query(
				`select run.status, count(message.id)::int as assistant_messages
				 from agent_run run left join chat_message message
				  on message.run_id = run.run_id and message.role = 'assistant'
				 where run.conversation_id = $1 group by run.id order by run.generation`,
				[conversationId]
			)
		).toEqual([
			{ status: 'completed', assistant_messages: 2 },
			{ status: 'completed', assistant_messages: 1 }
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
				return {
					_tag: 'Success',
					value: {
						output: assistantText(`answer-${turns.length}`, `final-answer-${turns.length}`)
					}
				};
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
				Agents.userAgentInput('First.')
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
						Agents.userAgentInput('Second.')
					)
				)
			).status
		).toBe('pending');
		releaseFirstRound();
		await first;

		expect(turns).toHaveLength(2);
		expect(JSON.stringify(turns[1]?.messages)).toContain('Second.');
		expect(
			await harness.database.query(
				`select status from agent_run where conversation_id = $1 order by generation`,
				[conversationId]
			)
		).toEqual([{ status: 'completed' }, { status: 'completed' }]);
	});
});
