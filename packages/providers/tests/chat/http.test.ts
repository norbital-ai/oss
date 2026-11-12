import { describe, expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import { hmac, fresh, standardWebhook } from '../../src/chat/verify.ts';
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
				retry_after_ms: expected,
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

describe('shared webhook verification', () => {
	it('accepts rotated signatures and preserves each platform version rule', () => {
		const key = Buffer.alloc(32, 7);
		const at = String(Math.floor(Date.now() / 1000));
		const body = '{"event":"message"}';
		const signature = hmac(key, `delivery.${at}.${body}`, 'base64');
		const headers = new Headers({
			'webhook-id': 'delivery',
			'webhook-timestamp': at,
			'webhook-signature': `v1,old v1,${signature}`
		});
		expect(() => standardWebhook(headers, body, key, 'v1')).not.toThrow();
		headers.set('webhook-signature', `v2,${signature}`);
		expect(() => standardWebhook(headers, body, key)).not.toThrow();
		expect(() => standardWebhook(headers, body, key, 'v1')).toThrow('bad signature');
	});

	it('refuses changed payloads, missing delivery ids and stale timestamps', () => {
		const key = Buffer.alloc(32, 7);
		const body = '{"event":"message"}';
		const headers = new Headers({ 'webhook-id': 'delivery' });
		const sign = (at: string) => {
			headers.set('webhook-timestamp', at);
			headers.set('webhook-signature', `v1,${hmac(key, `delivery.${at}.${body}`, 'base64')}`);
		};
		sign(String(Math.floor(Date.now() / 1000)));
		expect(() => standardWebhook(headers, body + ' ', key, 'v1')).toThrow('bad signature');
		headers.delete('webhook-id');
		expect(() => standardWebhook(headers, body, key, 'v1')).toThrow('bad signature');
		headers.set('webhook-id', 'delivery');
		sign(String(Math.floor(Date.now() / 1000) - 301));
		expect(() => standardWebhook(headers, body, key, 'v1')).toThrow('bad signature');
		expect(fresh('bad')).toBe(false);
	});
});
