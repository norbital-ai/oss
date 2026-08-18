import { describe, expect, it } from 'vitest';
import { addAIUsage, readAIUsage } from '../src/index.js';

/**
 * A response body shaped the way an OpenAI-compatible endpoint answers, because that is the shape
 * this normaliser exists for. A fixture describing an invented `{ cost }` at the top level would
 * have kept passing while the host it feeds rejected every real turn as unmetered.
 */
const openRouterResponse = {
	id: 'gen-1',
	model: 'anthropic/claude-sonnet-4.5',
	choices: [{ message: { role: 'assistant', content: 'hello' } }],
	usage: {
		prompt_tokens: 1_200,
		completion_tokens: 300,
		total_tokens: 1_500,
		cost: 0.0042,
		prompt_tokens_details: { cached_tokens: 900 },
		completion_tokens_details: { reasoning_tokens: 120 }
	}
};

describe('AI usage', () => {
	it('reads the charge and the token counts a provider nests under usage', () => {
		expect(readAIUsage(openRouterResponse)).toEqual({
			model: 'anthropic/claude-sonnet-4.5',
			inputTokens: 1_200,
			cachedInputTokens: 900,
			outputTokens: 300,
			reasoningTokens: 120,
			totalTokens: 1_500,
			costUsd: 0.0042
		});
	});

	it('reads a gateway that hoists the same fields to the top level', () => {
		expect(readAIUsage({ prompt_tokens: 10, completion_tokens: 5, cost: 0.001 })).toEqual({
			inputTokens: 10,
			outputTokens: 5,
			totalTokens: 15,
			costUsd: 0.001
		});
	});

	it('distinguishes a turn nobody reported from a turn that was free', () => {
		expect(readAIUsage({ choices: [] })).toBeUndefined();
		expect(readAIUsage({ usage: { cost: 0, total_tokens: 0 } })).toEqual({
			totalTokens: 0,
			costUsd: 0
		});
	});

	it('adds usage across calls without inventing a model for the sum', () => {
		const total = addAIUsage(
			readAIUsage(openRouterResponse),
			readAIUsage({ usage: { prompt_tokens: 800, completion_tokens: 200, cost: 0.0018 } })
		);
		expect(total).toEqual({
			inputTokens: 2_000,
			cachedInputTokens: 900,
			outputTokens: 500,
			reasoningTokens: 120,
			totalTokens: 2_500,
			costUsd: 0.006
		});
	});

	it('keeps a running total when one call reported nothing', () => {
		const first = readAIUsage(openRouterResponse);
		expect(addAIUsage(first, undefined)).toEqual(first);
		expect(addAIUsage(undefined, first)).toEqual(first);
	});
});
