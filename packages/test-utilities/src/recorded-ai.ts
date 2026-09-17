import { AIResponse, type AIRequest } from '@norbital-ai/bolt-protocol';
import { makeAiBinding } from '@norbital-ai/bolt-server';
import { Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { testAiCatalog } from './catalog-ai.js';

export type RecordedGenerated = Extract<typeof AIResponse.Encoded, { readonly _tag: 'Generated' }>;

/**
 * A recorded structured answer in the shape the agentic loop submits: a `return_result` tool call.
 *
 * `api.infer` answers only from that submission, so a recorded script speaks the loop or it does
 * not speak at all. There is no object-shaped shortcut.
 */
export const recordedSubmission = (
	value: unknown,
	observation: RecordedGenerated['observation']
): RecordedGenerated => ({
	_tag: 'Generated',
	result: {
		_tag: 'Message',
		message: Schema.encodeSync(Prompt.Message)(
			Prompt.assistantMessage({
				content: [
					Prompt.toolCallPart({
						id: 'recorded-submission',
						name: 'return_result',
						params: value as never,
						providerExecuted: false
					})
				]
			})
		)
	},
	observation
});

/**
 * In-process AI test double: Catalog matches `catalogAi`, Generate plays the next recorded
 * payload. Embed is not recorded. The host may pass any other `makeAiBinding` provider instead.
 */
export const recordedAi = (script: ReadonlyArray<RecordedGenerated>) => {
	let next = 0;
	return makeAiBinding({
		call: async (_metadata, request: AIRequest) => {
			switch (request._tag) {
				case 'Catalog':
					return testAiCatalog;
				case 'Generate': {
					const recorded = script[next];
					if (recorded === undefined) {
						throw new Error(`recordedAi: no Generated payload remains (consumed ${next})`);
					}
					next += 1;
					return recorded;
				}
				case 'Embed':
					throw new Error('recordedAi: Embed was not recorded');
				default: {
					const _exhaustive: never = request;
					throw new Error(`recordedAi: unhandled AI request: ${JSON.stringify(_exhaustive)}`);
				}
			}
		}
	});
};
