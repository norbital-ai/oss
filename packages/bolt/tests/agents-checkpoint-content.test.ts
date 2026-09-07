import { describe, expect, it } from 'vitest';
import { CHECKPOINT_WITHOUT_SUMMARY, checkpointContent } from '../src/runtime/agents/agents.js';

const assistant = (content: string | ReadonlyArray<Record<string, unknown>>) =>
	({ role: 'assistant', content, options: {} }) as unknown as Parameters<typeof checkpointContent>[0];

describe('automatic checkpoint content', () => {
	it('keeps only the prose of a summary that arrived with reasoning and a tool call', () => {
		const stored = checkpointContent(
			assistant([
				{ type: 'reasoning', text: 'Count current employments.', options: {} },
				{ type: 'text', text: 'Nihon Pigment has **59** current employees.', options: {} },
				{
					type: 'tool-call',
					id: 'call-1',
					name: 'read_collection',
					params: { collection: 'employments' },
					providerExecuted: false,
					options: {}
				}
			])
		);
		expect(stored.content).toEqual([
			{ type: 'text', text: 'Nihon Pigment has **59** current employees.', options: {} }
		]);
	});

	it('writes a sentence when the model answered with a call and no prose', () => {
		const stored = checkpointContent(
			assistant([
				{
					type: 'tool-call',
					id: 'call-1',
					name: 'read_collection',
					params: {},
					providerExecuted: false,
					options: {}
				},
				{ type: 'text', text: '   ', options: {} }
			])
		);
		expect(stored.content).toBe(CHECKPOINT_WITHOUT_SUMMARY);
		expect(checkpointContent(assistant('')).content).toBe(CHECKPOINT_WITHOUT_SUMMARY);
	});

	it('leaves a plain text summary as it is', () => {
		const text = 'Retained: the current instruction and the open decisions.';
		expect(checkpointContent(assistant(text)).content).toBe(text);
		const parts = [{ type: 'text', text, options: {} }];
		expect(checkpointContent(assistant(parts)).content).toEqual(parts);
	});
});
