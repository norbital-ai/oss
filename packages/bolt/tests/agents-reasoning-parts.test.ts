import { Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { describe, expect, it } from 'vitest';
import { retainedGeneration } from '../src/runtime/agents/agents.js';

/**
 * RFC bolt.md B2 / AGENT-UI2, the persistence rule. A run that did not request reasoning keeps no
 * reasoning part; a run that did keeps only the parts with text, plus an active part still
 * streaming so its index is stable. Dropped parts leave `activeParts` and the surviving indexes
 * shift with the content.
 */
const encode = Schema.encodeSync(Prompt.Message);
const assistant = (parts: ReadonlyArray<Prompt.AssistantMessagePart>): Prompt.MessageEncoded =>
	encode(Prompt.assistantMessage({ content: [...parts] }));
const types = (message: Prompt.MessageEncoded): ReadonlyArray<string> =>
	typeof message.content === 'string' ? ['string'] : message.content.map(({ type }) => type);

const notRequested = { reasoning_requested: false };
const requested = { reasoning_requested: true };

describe('reasoning parts a run persists (RFC bolt.md B2)', () => {
	it('drops the provider literal `None.` when reasoning was not requested', () => {
		const message = assistant([
			Prompt.reasoningPart({ text: 'None.' }),
			Prompt.textPart({ text: 'Payroll is balanced.' })
		]);
		const retained = retainedGeneration(notRequested, message, [0, 1]);
		expect(types(retained.message)).toEqual(['text']);
		expect(retained.activeParts).toEqual([0]);
		expect(JSON.stringify(retained.message)).not.toContain('None.');
	});

	it('drops every reasoning part when reasoning was not requested, even one with text', () => {
		const message = assistant([
			Prompt.reasoningPart({ text: 'Considering the ledger.' }),
			Prompt.textPart({ text: 'Done.' }),
			Prompt.reasoningPart({ text: '' })
		]);
		const retained = retainedGeneration(notRequested, message, [2]);
		expect(types(retained.message)).toEqual(['text']);
		expect(retained.activeParts).toEqual([]);
	});

	it('keeps requested reasoning with text and drops empty or whitespace parts once complete', () => {
		const message = assistant([
			Prompt.reasoningPart({ text: 'Considering the ledger.' }),
			Prompt.reasoningPart({ text: '   \n' }),
			Prompt.reasoningPart({ text: 'None.' }),
			Prompt.textPart({ text: 'Done.' })
		]);
		const retained = retainedGeneration(requested, message, [3]);
		expect(types(retained.message)).toEqual(['reasoning', 'reasoning', 'text']);
		expect(retained.activeParts).toEqual([2]);
	});

	it('keeps an active, still empty reasoning part while requested so its index holds', () => {
		const streaming = assistant([Prompt.reasoningPart({ text: '' })]);
		const retained = retainedGeneration(requested, streaming, [0]);
		expect(types(retained.message)).toEqual(['reasoning']);
		expect(retained.activeParts).toEqual([0]);
		const complete = retainedGeneration(requested, streaming, []);
		expect(types(complete.message)).toEqual([]);
	});

	it('returns the same message when nothing is dropped, and leaves non-assistant content alone', () => {
		const text = assistant([Prompt.textPart({ text: 'Only text.' })]);
		expect(retainedGeneration(notRequested, text, [0]).message).toBe(text);
		const plain: Prompt.MessageEncoded = {
			role: 'assistant',
			content: 'A string body.',
			options: {}
		};
		expect(retainedGeneration(notRequested, plain, []).message).toBe(plain);
		const user = encode(Prompt.userMessage({ content: [Prompt.textPart({ text: 'Hello' })] }));
		expect(retainedGeneration(notRequested, user, []).message).toBe(user);
	});
});
