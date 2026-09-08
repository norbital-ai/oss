import { Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { describe, expect, it } from 'vitest';

/**
 * Reasoning needs no persistence rule, and this suite exists to say so.
 *
 * It used to cover `retainedGeneration`, a filter that stripped every reasoning part out of an
 * assistant message before it was stored, gated on a flag with one possible answer. Both are gone.
 * What is left is Effect's own type: `ReasoningPart` is a member of `AssistantMessagePart`, so a
 * reasoning part round-trips through the same encode and decode as a text part, into the same
 * column, and there is nothing to keep it out.
 *
 * These rows fail if that stops being true — if a part type is dropped by the codec, or if someone
 * reintroduces a filter between the provider and the row. Whether an empty reasoning part is
 * *rendered* is a separate question with a separate answer, asserted in the UI suites.
 */

const encode = Schema.encodeSync(Prompt.Message);
const decode = Schema.decodeUnknownSync(Prompt.Message);

const assistant = (parts: ReadonlyArray<Prompt.AssistantMessagePart>): Prompt.MessageEncoded =>
	encode(Prompt.assistantMessage({ content: [...parts] }));

const types = (message: Prompt.MessageEncoded): ReadonlyArray<string> =>
	typeof message.content === 'string' ? ['string'] : message.content.map(({ type }) => type);

describe('reasoning is an ordinary assistant part', () => {
	it('encodes beside text, in the order the provider sent them', () => {
		const message = assistant([
			Prompt.reasoningPart({ text: 'Considering the ledger.' }),
			Prompt.textPart({ text: 'The ledger reconciles.' })
		]);
		expect(types(message)).toEqual(['reasoning', 'text']);
		expect(JSON.stringify(message)).toContain('Considering the ledger.');
	});

	it('survives the round trip a stored row makes', () => {
		const message = assistant([
			Prompt.reasoningPart({ text: 'Working it out.' }),
			Prompt.toolCallPart({ id: 'call-1', name: 'read_collection', params: {}, providerExecuted: false }),
			Prompt.textPart({ text: 'Done.' })
		]);
		// What the row holds is the encoded form; what reads it back decodes that form.
		const stored: unknown = JSON.parse(JSON.stringify(message));
		expect(types(encode(decode(stored)))).toEqual(['reasoning', 'tool-call', 'text']);
	});

	/**
	 * `None.` is what GLM and DeepSeek emit when nothing was thought, and it was the original reason
	 * for the filter: it looked like noise. It is not ours to edit. A transcript that quietly
	 * rewrites what the model said is not a transcript, and a turn that reasoned about nothing is a
	 * fact worth being able to read back.
	 */
	it('keeps what the model said, including the literal the old filter existed to remove', () => {
		const message = assistant([
			Prompt.reasoningPart({ text: 'None.' }),
			Prompt.textPart({ text: 'Payroll is balanced.' })
		]);
		expect(types(message)).toEqual(['reasoning', 'text']);
		expect(JSON.stringify(message)).toContain('None.');
	});

	it('keeps an empty reasoning part, which is a live status while a part streams', () => {
		const streaming = assistant([Prompt.reasoningPart({ text: '' })]);
		expect(types(streaming)).toEqual(['reasoning']);
	});
});
