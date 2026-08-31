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

describe('canonical agent prompt window', () => {
	it('keeps durable history whole while middleware bounds the provider view', async () => {
		const requests: Array<Extract<AIRequest, { readonly _tag: 'Turn' }>> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Models') {
					return {
						_tag: 'Success',
						value: {
							output: {
								defaultModel: 'selected-model',
								options: [{ id: 'selected-model', contextLength: 8_000 }]
							}
						}
					};
				}
				if (request._tag === 'Turn') requests.push(request);
				return {
					_tag: 'Success',
					value: { output: { role: 'assistant', content: 'done' } }
				};
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = 'prompt-window';
		await harness.runtime.runPromise(
			agents.open(harness.effectId('open'), adminSubject, 'web', conversationId)
		);
		for (let index = 0; index < 30; index += 1) {
			await harness.database.query(
				`insert into chat_message
					(message_id, conversation_id, role, content_kind, content_text, search_text, semantic_hash)
				 values ($1, $2, $3, 'text', $4, $4, $5)`,
				[
					`history-${index}`,
					conversationId,
					index % 2 === 0 ? 'user' : 'assistant',
					`HISTORY-${index}:${'x'.repeat(1_200)}`,
					`hash-${index}`
				]
			);
		}

		await harness.runtime.runPromise(
			agents.enqueue(
				harness.effectId('enqueue'),
				adminSubject,
				'web',
				conversationId,
				'latest',
				Agents.userAgentInput('continue from the recent context'),
				'selected-model'
			)
		);
		const request = requests[0];
		if (request === undefined) throw new Error('expected one provider request');
		const encoded = JSON.stringify(request.messages);
		expect(encoded).not.toContain('HISTORY-0:');
		expect(encoded).toContain('HISTORY-29:');
		expect(encoded).toContain('continue from the recent context');
		expect(
			await harness.database.query(
				'select count(*)::int as count from chat_message where conversation_id = $1',
				[conversationId]
			)
		).toEqual([{ count: 32 }]);
	});

	it('refuses a selected model whose catalog entry has no context length', async () => {
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) =>
				request._tag === 'Models'
					? {
							_tag: 'Success',
							value: {
								output: {
									defaultModel: 'unknown-window',
									options: [{ id: 'unknown-window' }]
								}
							}
						}
					: { _tag: 'Success', value: { output: { role: 'assistant', content: 'must not run' } } }
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		await expect(
			harness.runtime.runPromise(
				agents.enqueue(
					harness.effectId('enqueue'),
					adminSubject,
					'web',
					'unknown-context',
					'turn',
					Agents.userAgentInput('Do not guess the context window.'),
					'unknown-window'
				)
			)
		).rejects.toMatchObject({ _tag: 'Bolt.Agents.AgentModelUnavailable' });
	});
});
