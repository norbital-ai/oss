import { describe, expect, it, vi } from '@effect/vitest';
import type { HostToolContext, Json } from '@norbital-ai/bolt/engine';
import { webSearch } from '../src/search.ts';

const context: HostToolContext = {
	actor: { kind: 'system', run: 'r', by: { platform: 'test' } },
	conversation: 'c',
	turn: 't',
	callId: 'k',
	attach: () => {}
};
const call = (input: Json) =>
	webSearch({ endpoint: 'https://search.test/v1', credential: 'key' }).call(
		input,
		context,
		new AbortController().signal
	);

describe('web_search', () => {
	it('sends the bounds as operators and answers unique, trimmed results', async () => {
		const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
			Response.json({
				results: [
					{ url: 'https://bpjs.go.id/a', title: 'A', snippet: 'x'.repeat(700) },
					{ url: 'https://bpjs.go.id/a', title: 'A again' }
				]
			})
		);
		vi.stubGlobal('fetch', fetchMock);
		const answer = await call({ query: 'iuran', sites: ['go.id'], after: '2026-01-01' });
		expect(JSON.parse(String(fetchMock.mock.lastCall?.[1].body)).query).toBe(
			'iuran site:go.id after:2026-01-01'
		);
		expect(answer).toEqual({
			results: [{ title: 'A', url: 'https://bpjs.go.id/a', excerpt: 'x'.repeat(600) }]
		});
		vi.unstubAllGlobals();
	});

	it('answers a refusal the model can repair', async () => {
		expect(await call({ query: '' })).toEqual({
			error: 'web_search: query is 1 to 128 characters.'
		});
		vi.stubGlobal('fetch', async () => new Response('', { status: 429 }));
		expect(await call({ query: 'iuran' })).toEqual({ error: 'search 429' });
		vi.unstubAllGlobals();
	});
});
