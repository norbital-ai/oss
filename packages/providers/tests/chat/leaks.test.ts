// Channels run for months: nothing may grow with deliveries, reconnects or pairings.
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { chatProvider, nothing, recent, type ChatPlatform } from '../../src/chat/adapter.ts';
import { hmac } from '../../src/chat/verify.ts';
import { line } from '../../src/chat/line/index.ts';
import { host } from '../kit.ts';
import { connected, json, platformApi, webhook } from './kit.ts';

setFlagsFromString('--expose-gc');
const Gc = Schema.declare((value): value is () => void => typeof value === 'function');
const collect = Schema.decodeUnknownSync(Gc)(runInNewContext('gc'));
const heap = () => {
	collect();
	return process.memoryUsage().heapUsed;
};

/** A platform that counts the connections it has open. */
const counting = () => {
	let open = 0;
	const counted: ChatPlatform = {
		id: 'counted',
		name: { en: 'Counted', zh: 'Counted' },
		description: { en: 'Counts connections', zh: 'Counts connections' },
		via: { en: 'Official API', zh: '官方 API' },
		consistency: 'webhook',
		guide: 'https://example.test',
		fields: [],
		connect: async () => {
			open += 1;
			return {
				account: 'bot',
				deliver: async () => nothing(),
				send: async (_thread, _text, key) => ({ id: key }),
				close: async () => {
					open -= 1;
				}
			};
		}
	};
	return { counted, open: () => open };
};

describe('over a long life', () => {
	it.live('thousands of deliveries from different people leave the heap where it was', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ userId: 'bot', displayName: 'Bot' }));
			const h = yield* connected(line, { channelAccessToken: 'token', channelSecret: 'secret' });
			const deliver = (n: number) =>
				Effect.gen(function* () {
					const body = JSON.stringify({
						destination: 'bot',
						events: [
							{
								type: 'message',
								mode: 'active',
								timestamp: 1_790_000_000_000 + n,
								webhookEventId: `e${n}`,
								deliveryContext: { isRedelivery: false },
								source: { type: 'user', userId: `U${n}` },
								message: { id: `m${n}`, type: 'text', quoteToken: 'q', text: 'x'.repeat(500) }
							}
						]
					});
					yield* h.link.webhook!(
						webhook(body, { 'x-line-signature': hmac('secret', body, 'base64') })
					);
					h.events.length = 0;
				});
			for (let n = 0; n < 2000; n += 1) yield* deliver(n);
			const before = heap();
			for (let n = 2000; n < 12_000; n += 1) yield* deliver(n);
			expect(heap() - before).toBeLessThan(2_000_000);
		})
	, 60_000);
	it('what an adapter keeps per thread stops at its limit', () => {
		const held = recent<string>();
		for (let n = 0; n < 2000; n += 1) held.set(`t${n}`, 'x'.repeat(1000));
		const before = heap();
		for (let n = 2000; n < 50_000; n += 1) held.set(`t${n}`, 'x'.repeat(1000));
		expect(heap() - before).toBeLessThan(1_000_000);
		expect(held.get('t0')).toBeUndefined();
		expect(held.get('t49999')).toBeDefined();
	});
	it.live('pairing again and again leaves one connection open, and closing leaves none', () =>
		Effect.gen(function* () {
			const { counted, open } = counting();
			const h = yield* host(chatProvider(counted), fetch);
			for (let n = 0; n < 200; n += 1) yield* h.link.pair!({});
			expect(open()).toBe(1);
			yield* h.link.unpair!();
			expect(open()).toBe(0);
			yield* h.link.pair!({});
			yield* h.link.close!;
			expect(open()).toBe(0);
		})
	);
	it.live('a pairing whose credential cannot be kept closes what it opened', () =>
		Effect.gen(function* () {
			const { counted, open } = counting();
			const h = yield* host(chatProvider(counted), fetch, undefined, {
				write: () => Promise.reject(new Error('the store refused'))
			});
			yield* Effect.flip(h.link.pair!({}));
			expect(open()).toBe(0);
		})
	);
});
