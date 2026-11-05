// Dial: its real SDK, deliveries signed as its webhooks are, and its API faked behind `fetch`.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider } from '../../src/chat/adapter.ts';
import { dial } from '../../src/chat/dial/index.ts';
import { host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const settings = { apiKey: 'key', fromNumberId: 'n1', webhookSecret: 'hook' },
	own = '+16290000000',
	person = '+15551234567';
const answer = (call: Call) => {
	if (call.url.endsWith('/api/v1/numbers')) return json({ numbers: [{ id: 'n1', number: own }] });
	if (call.url.endsWith('/api/v1/messages')) return json({ message: { id: 'out1' } });
	if (call.url.startsWith('https://cdn.test/')) return new Response(new Uint8Array([1, 2, 3]));
	return json({});
};
const event = (data: object = {}, type = 'message.received') =>
	JSON.stringify({
		id: 'e1',
		object: 'event',
		type,
		version: 1,
		createdAt: '2026-01-02T03:04:05.000Z',
		relatedObject: null,
		data: {
			messageId: 'm1',
			channel: 'imessage',
			from: person,
			to: own,
			body: 'Hello',
			media: [],
			source: 'external',
			...data
		}
	});
/** `t=<seconds>,v1=<hex HMAC-SHA256 of "t.body">`. */
const signature = (
	body: string,
	secret = settings.webhookSecret,
	seconds = Math.floor(Date.now() / 1000)
) => ({
	'x-dial-signature': `t=${seconds},v1=${createHmac('sha256', secret).update(`${seconds}.${body}`).digest('hex')}`
});
const direct = () =>
	Effect.promise(() =>
		dial.connect(settings, {
			fetch,
			webhookUrl: 'https://hook.test/',
			receive: () => Promise.resolve()
		})
	);

describe('Dial', () => {
	it.live('stores a signed message before acknowledging it', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(dial, settings),
				body = event({ replyToId: 'm0' });
			expect(h.status).toMatchObject({ state: 'connected', account: own });
			expect((yield* h.link.webhook!(webhook(body, signature(body)))).status).toBe(200);
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				messages: [
					{
						id: 'm1',
						thread: person,
						sentAt: '2026-01-02T03:04:05.000Z',
						text: 'Hello',
						from: { handle: person, name: null },
						replyTo: 'm0',
						group: false,
						invocation: 'direct'
					}
				]
			});
		})
	);
	it.live('refuses a bad or a stale signature and stores nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(dial, settings),
				body = event();
			const stale = signature(body, 'hook', Math.floor(Date.now() / 1000) - 301);
			for (const headers of [signature(body, 'forged'), stale, {}])
				expect((yield* h.link.webhook!(webhook(body, headers))).status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a message the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(dial, settings, {
					emit: () => Promise.reject(new Error('the store refused'))
				}),
				body = event();
			expect((yield* h.link.webhook!(webhook(body, signature(body)))).status).toBe(500);
		})
	);
	it.live('stores neither a ping, a call nor a reaction', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(dial, settings);
			for (const body of [
				event({}, 'webhook.ping'),
				event({}, 'call.ended'),
				event({ body: '', reaction: '👍', replyToId: 'm0' })
			])
				expect((yield* h.link.webhook!(webhook(body, signature(body)))).status).toBe(200);
			expect(h.events).toEqual([]);
		})
	);
	it.live('fetches an inbound file', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(dial, settings);
			const body = event({
				media: [
					{ id: 'f1', url: 'https://cdn.test/f1', contentType: 'image/png', originalUrl: null }
				]
			});
			yield* h.link.webhook!(webhook(body, signature(body)));
			expect(h.events[0]).toMatchObject({
				bins: [new Uint8Array([1, 2, 3])],
				messages: [{ attachments: [{ name: 'f1', mime: 'image/png', bytes: 3, bin: 0 }] }]
			});
		})
	);
	it.live('sends from its number, within its length, and claims no dedupe', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(dial, settings);
			const sent = yield* h.link.send!({ id: 'r1', to: person, text: 'x'.repeat(2000) }, []);
			expect(sent).toMatchObject({ providerId: 'out1' });
			const call = api.calls.at(-1);
			expect(call?.url).toBe('https://api.getdial.ai/api/v1/messages');
			expect(call?.headers.get('authorization')).toBe('Bearer key');
			expect(JSON.parse(call?.body ?? '')).toEqual({
				to: person,
				fromNumberId: 'n1',
				body: 'x'.repeat(1600)
			});
			const connection = yield* direct();
			const answered = yield* Effect.promise(() => connection.send(person, 'Hello', 'r1', []));
			expect(answered).toEqual({ id: 'out1' });
		})
	);
	it.live('a refused send fails for good, an outage retries', () =>
		Effect.gen(function* () {
			let status = 400;
			yield* platformApi((call) =>
				call.url.endsWith('/api/v1/messages') ? json({ error: 'no' }, status) : answer(call)
			);
			const h = yield* connected(dial, settings);
			const refused = yield* Effect.flip(h.link.send!({ to: person, text: 'Hello' }, []));
			expect(refused).toMatchObject({ _tag: 'ProviderRefused', permanent: true });
			status = 503;
			const down = yield* Effect.flip(h.link.send!({ to: person, text: 'Hello' }, []));
			expect(down).toMatchObject({ _tag: 'ProviderUnavailable', status: 503 });
		})
	);
	it.live('starts and stops typing from its number', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const connection = yield* direct();
			yield* Effect.promise(async () => {
				await connection.typing?.(person, true);
				await connection.typing?.(person, false);
			});
			expect(
				api.calls
					.filter((call) => call.url.endsWith('/typing'))
					.map((call) => JSON.parse(call.body))
			).toEqual([
				{ toNumber: person, value: true, fromNumber: own },
				{ toNumber: person, value: false, fromNumber: own }
			]);
		})
	);
	it.live(
		'reads the number back since a time, keeps the thread, never claims the whole window',
		() =>
			Effect.gen(function* () {
				const row = (id: string, from: string, reaction: string | null = null) => ({
					id,
					from,
					to: own,
					body: id,
					direction: 'inbound',
					channel: 'sms',
					status: 'received',
					media: [],
					replyToId: null,
					reaction,
					phoneNumberId: 'n1',
					createdAt: '2026-01-03T00:00:00.000Z'
				});
				const api = yield* platformApi((call) =>
					call.url.includes('/api/v1/messages?')
						? json({
								messages: [row('m1', person), row('m2', '+15550000000'), row('m3', person, '👍')]
							})
						: answer(call)
				);
				const connection = yield* direct();
				const read = yield* Effect.promise(async () =>
					connection.history?.(person, '2026-01-01T00:00:00.000Z')
				);
				expect(read?.complete).toBe(false);
				expect(read?.messages.map((message) => message.id)).toEqual(['m1']);
				expect(read?.messages[0]).toMatchObject({
					thread: person,
					sentAt: '2026-01-03T00:00:00.000Z'
				});
				expect(Object.fromEntries(new URL(api.calls.at(-1)?.url ?? '').searchParams)).toEqual({
					numberId: 'n1',
					direction: 'inbound',
					since: '2026-01-01T00:00:00.000Z'
				});
			})
	);
	it.live('a key Dial refuses, or a number not its own, keeps nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ error: 'unauthorized' }, 401));
			const refused = yield* host(chatProvider(dial), fetch);
			yield* Effect.flip(refused.link.pair!(settings));
			expect(refused.values.size).toBe(0);
			yield* platformApi(() => json({ numbers: [{ id: 'other', number: own }] }));
			const stranger = yield* host(chatProvider(dial), fetch);
			yield* Effect.flip(stranger.link.pair!(settings));
			expect(stranger.values.size).toBe(0);
		})
	);
});
