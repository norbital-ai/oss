import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { EffectId, type ConnectorRequest } from '@norbital-ai/bolt-protocol';
import { webReader } from '../src/runtime/automations/web.js';

it('marshals each automation page read through a distinct connector effect', async () => {
	const requests: Array<{ id: string; request: ConnectorRequest }> = [];
	const read = webReader(EffectId.make('read-source'), {
		execute: (id, request) => {
			requests.push({ id, request });
			return Effect.succeed({ output: { url: 'https://example.test/final', contentType: 'text/html', body: 'Source text' } });
		}
	});
	const page = await Effect.runPromise(read('https://example.test/start'));
	await Effect.runPromise(read('https://example.test/next'));
	expect(page.body).toBe('Source text');
	expect(requests[0]?.request).toEqual({ connector: 'web', operation: 'web.read', input: { url: 'https://example.test/start' } });
	expect(new Set(requests.map((request) => request.id)).size).toBe(2);
});

it('refuses malformed page responses instead of extracting invented content', async () => {
	const read = webReader(EffectId.make('bad-source'), { execute: () => Effect.succeed({ output: { unrelated: true } }) });
	await expect(Effect.runPromise(read('https://example.test'))).rejects.toThrow('invalid page');
});
