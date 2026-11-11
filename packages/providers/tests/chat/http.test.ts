import { describe, expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import { download, fileOf, json, parse, request } from '../../src/chat/http.ts';

describe('chat wire boundaries', () => {
	it('decodes webhook JSON and HTTP answers against their own schema', async () => {
		const Message = Schema.Struct({ id: Schema.String });
		expect(await parse(Message, '{"id":"one","extra":true}')).toEqual({ id: 'one' });
		await expect(parse(Message, '{"id":7}')).rejects.toThrow();
		await expect(json(Message, Response.json({ id: null }))).rejects.toThrow();
	});
	it('preserves the refusal status and finite positive retry delay', async () => {
		for (const [header, expected] of [
			['2', 2000],
			['bad', undefined],
			['-1', undefined]
		] as const) {
			await expect(
				request(
					async () =>
						new Response('limited', {
							status: 429,
							headers: { 'retry-after': header }
						}),
					'https://api.test'
				)
			).rejects.toMatchObject({
				status: 429,
				retryAfterMs: expected,
				message: '429: limited'
			});
		}
	});
	it('downloads through the supplied fetch with its authorization headers', async () => {
		const calls: Request[] = [];
		expect(
			await download(
				async (url, init) => {
					calls.push(new Request(url, init));
					return new Response(new Uint8Array([1, 2]));
				},
				'https://media.test/image',
				{ authorization: 'Bearer token' }
			)
		).toEqual(new Uint8Array([1, 2]));
		expect(calls[0]?.headers.get('authorization')).toBe('Bearer token');
		expect(calls[0]?.url).toBe('https://media.test/image');
	});
	it('describes URL images and reads inline media without a network call', async () => {
		const fetch = async () => {
			throw new Error('unexpected network call');
		};
		expect(fileOf('https://media.test/PHOTO.JPG?token=secret', fetch)).toMatchObject({
			name: 'PHOTO.JPG',
			mime: 'image/jpeg'
		});
		const inline = fileOf('data:image/png;base64,AQI=', fetch);
		expect(inline.mime).toBe('image/png');
		expect(await inline.fetch?.()).toEqual(new Uint8Array([1, 2]));
	});
});
