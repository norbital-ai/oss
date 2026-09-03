import { afterEach, describe, expect, it } from 'vitest';

const live = Boolean(process.env['OPENROUTER_API_KEY']);

describe.skipIf(!live)('live OpenRouter agent capabilities (P13)', () => {
	afterEach(() => {
		// Reserved for a future harness that provisions a runtime per test.
	});

	it('accepts the configured OpenRouter API key', async () => {
		const apiKey = process.env['OPENROUTER_API_KEY'];
		if (apiKey === undefined) throw new Error('OPENROUTER_API_KEY is required for this lane');

		const response = await fetch('https://openrouter.ai/api/v1/models', {
			headers: { authorization: `Bearer ${apiKey}` }
		});
		expect(response.status).toBe(200);
		const body: unknown = await response.json();
		expect(body !== null && typeof body === 'object').toBe(true);
		if (body === null || typeof body !== 'object') {
			throw new Error('models response is not an object');
		}
		const data = Reflect.get(body, 'data');
		expect(Array.isArray(data)).toBe(true);
		expect((data as ReadonlyArray<unknown>).length).toBeGreaterThan(0);
	});
});
