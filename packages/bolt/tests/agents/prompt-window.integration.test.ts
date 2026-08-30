import { afterEach, describe, expect, it } from 'vitest';
import type { AIRequest, AIResponse, FacilityBinding } from '@norbital-ai/bolt-protocol';
import * as Agents from '../../src/runtime/agents/agents.js';
import {
	estimatedPromptTokens,
	promptReplayFraction,
	truncatePromptWindow
} from '../../src/runtime/agents/turn.js';
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

describe('agent prompt window', () => {
	it('hard-caps replay by whole turns after soft pruning and protects the recent floor', async () => {
		const requests: Array<AIRequest> = [];
		const contextLength = 32_000;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Models') {
					return {
						_tag: 'Success',
						value: {
							output: {
								defaultModel: 'default-model',
								options: [
									{ id: 'default-model', contextLength: 128_000 },
									{ id: 'selected-model', contextLength }
								]
							}
						}
					};
				}
				if (request._tag === 'Turn') requests.push(request);
				return { _tag: 'Success', value: { output: { text: 'done' } } };
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		await harness.runtime.runPromise(
			agents.open(harness.effectId('open'), adminSubject, 'web', 'prompt-window')
		);
		const hugeOld = `OLD:${'a'.repeat(50_100)}`;
		const hugeRecent = `RECENT:${'z'.repeat(50_100)}`;
		for (let index = 0; index < 70; index += 1) {
			const output = index === 6 ? hugeOld : index === 69 ? hugeRecent : `tool-output-${index}`;
			await harness.database.query(
				`insert into chat_message (conversation_id, turn_id, role, content)
				 values ($1, $2, 'user', $3::jsonb)`,
				[
					'prompt-window',
					`turn-${index}`,
					JSON.stringify({ kind: 'user_message', text: `ASK-${index}:${'q'.repeat(200)}` })
				]
			);
			await harness.database.query(
				`insert into chat_message (conversation_id, turn_id, role, content)
				 values ($1, $2, 'assistant', $3::jsonb)`,
				[
					'prompt-window',
					`turn-${index}`,
					JSON.stringify({
						id: `turn-${index}`,
						status: 'completed',
						parts:
							index === 6 || index === 69
								? [
										{
											kind: 'tool',
											id: `call-${index}`,
											name: 'read_collection',
											input: { collection: 'records' }
										},
										{
											kind: 'tool-result',
											id: `call-${index}`,
											name: 'read_collection',
											output
										}
									]
								: [
										{
											kind: 'text',
											text: `TURN-${index}:${'x'.repeat(6_000)}`
										}
									],
						subject: adminSubject
					})
				]
			);
		}
		await harness.runtime.runPromise(
			agents.enqueue(
				harness.effectId('enqueue'),
				adminSubject,
				'web',
				'prompt-window',
				'turn-latest',
				{
					kind: 'user_message',
					text: 'continue'
				},
				'selected-model'
			)
		);
		const request = requests[0];
		if (request?._tag !== 'Turn') throw new Error('expected a turn');
		expect(request.model).toBe('selected-model');
		const encoded = JSON.stringify(request.messages);
		expect(estimatedPromptTokens(request.messages.slice(1))).toBeLessThanOrEqual(
			contextLength * promptReplayFraction
		);
		expect(encoded).not.toContain('TURN-0:');
		expect(encoded).not.toContain('ASK-0:');
		// Soft old-output pruning remains the first stage of the hard window.
		expect(encoded).not.toContain(hugeOld);
		// The latest assistant turn is one of the protected three and remains exact.
		expect(encoded).toContain(hugeRecent);
		expect(encoded).toContain('ASK-69:');
		expect(encoded).toContain('continue');
		for (let index = 0; index < request.messages.length; index += 1) {
			const message = request.messages[index];
			if (
				typeof message !== 'object' ||
				message === null ||
				Reflect.get(message, 'role') !== 'tool'
			)
				continue;
			const previous = request.messages[index - 1];
			if (typeof previous !== 'object' || previous === null) continue;
			expect(Reflect.get(previous, 'role')).toBe('assistant');
		}
	});

	it('uses recorded prompt usage to correct the bytes-per-four estimate', () => {
		const replay = truncatePromptWindow(
			[
				{
					messages: [{ role: 'user', content: `old:${'a'.repeat(120)}` }],
					protected: false
				},
				{
					messages: [{ role: 'assistant', content: { text: `middle:${'b'.repeat(120)}` } }],
					protected: false,
					usage: { inputTokens: 900 }
				},
				{
					messages: [{ role: 'user', content: 'newest request' }],
					protected: true
				}
			],
			1_000,
			[{ role: 'system', content: 'system' }]
		);
		const encoded = JSON.stringify(replay);
		expect(encoded).not.toContain('old:');
		expect(encoded).toContain('newest request');
	});

	it('refuses a selected model whose catalog entry has no context length', async () => {
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) =>
				request._tag === 'Models'
					? {
							_tag: 'Success',
							value: {
								output: {
									defaultModel: 'known-model',
									options: [{ id: 'known-model' }]
								}
							}
						}
					: { _tag: 'Success', value: { output: { text: 'must not run' } } }
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		await expect(
			harness.runtime.runPromise(
				agents.enqueue(
					harness.effectId('missing-context'),
					adminSubject,
					'web',
					'missing-context',
					'missing-context-turn',
					{ kind: 'user_message', text: 'Do not guess.' },
					'known-model'
				)
			)
		).rejects.toBeInstanceOf(Agents.AgentModelUnavailable);
	});
});
