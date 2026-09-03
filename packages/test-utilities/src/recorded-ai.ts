import { AIResponse, type AIRequest } from '@norbital-ai/bolt-protocol';
import { makeAiBinding } from '@norbital-ai/bolt-server';
import { testAiCatalog } from './catalog-ai.js';

export type RecordedGenerated = Extract<
	typeof AIResponse.Encoded,
	{ readonly _tag: 'Generated' }
>;

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
