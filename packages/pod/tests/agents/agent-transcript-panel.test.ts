import { describe, expect, it } from 'vitest';
import { toPanelMessage, withPendingEcho } from '$lib/runtime/agent/transcript.js';

describe('agent panel transcript', () => {
	it('projects a stored message without a second model of it', () => {
		expect(
			toPanelMessage({
				norbital_id: 'm1',
				parts: [{ role: 'assistant', content: 'The workspace is ready.' }]
			})
		).toEqual([{ key: 'm1', role: 'assistant', content: 'The workspace is ready.' }]);
	});

	it('names the tool call an empty assistant turn actually made', () => {
		// Content is empty by construction when the model chose a tool. A raw render leaves a blank
		// bubble where the conversation visibly did something.
		expect(
			toPanelMessage({
				norbital_id: 'm2',
				parts: [
					{
						role: 'assistant',
						content: '',
						toolCalls: [{ id: 't1', name: 'describe_workspace', input: {} }]
					}
				]
			})
		).toEqual([{ key: 'm2', role: 'assistant', content: 'Using describe_workspace…' }]);
	});

	it('drops a row it cannot render', () => {
		expect(toPanelMessage({ norbital_id: 'm3', parts: null })).toEqual([]);
		expect(toPanelMessage({ norbital_id: 'm4', parts: [] })).toEqual([]);
		expect(toPanelMessage({ parts: [{ role: 'user', content: 'orphan' }] })).toEqual([]);
	});

	it('echoes a prompt until its stored row arrives, then stops', () => {
		const stored = [{ key: 'm1', role: 'assistant', content: 'Hello.' }];
		expect(withPendingEcho(stored, 'What is on site?')).toEqual([
			...stored,
			{ key: 'pending', role: 'user', content: 'What is on site?' }
		]);

		// The moment the loop's own row replicates, the echo is gone — no timer, and never both.
		const landed = [...stored, { key: 'm2', role: 'user', content: 'What is on site?' }];
		expect(withPendingEcho(landed, 'What is on site?')).toEqual(landed);
		expect(withPendingEcho(landed, null)).toEqual(landed);
	});
});
