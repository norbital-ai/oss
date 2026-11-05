// Blooio: deliveries signed as its webhooks are, and its REST API faked behind `fetch`.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider } from '../../src/chat/adapter.ts';
import { blooio } from '../../src/chat/blooio/index.ts';
import { host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const settings = { apiKey: 'key', webhookSecret: 'whsec_hook' },
	person = '+15551234567',
	at = 1_790_000_000_000;
const answer = (call: Call) => {
	if (call.url.endsWith('/v2/api/me'))
		return json({ valid: true, devices: [{ phone_number: '+16290000000' }] });
	if (call.url.endsWith('/messages') && call.body !== '')
		return json({ message_id: 'out1', status: 'queued' });
	if (call.url.endsWith('/typing')) return new Response(null, { status: 204 });
	if (call.url.startsWith('https://cdn.test/')) return new Response(new Uint8Array([1, 2, 3]));
	return json({});
};
const message = (extra: object = {}) =>
	JSON.stringify({
		event: 'message.received',
		message_id: 'm1',
		external_id: person,
		text: 'Hello',
		attachments: [],
		protocol: 'imessage',
		timestamp: at - 5,
		internal_id: '+16290000000',
		received_at: at,
		sender: person,
		is_group: false,
		group_id: null,
		group_name: null,
		participants: null,
		...extra
	});
/** `t=<seconds>,v1=<hex HMAC-SHA256 of "t.body">`. */
const signature = (
	body: string,
	secret = settings.webhookSecret,
	seconds = Math.floor(Date.now() / 1000)
) => ({
	'x-blooio-signature': `t=${seconds},v1=${createHmac('sha256', secret).update(`${seconds}.${body}`).digest('hex')}`
});
const direct = (seen?: string[]) =>
	Effect.promise(() =>
		blooio.connect(settings, {
			fetch: (input, init) => {
				seen?.push(init?.method ?? 'GET');
				return fetch(input, init);
			},
			webhookUrl: 'https://hook.test/',
			receive: () => Promise.resolve()
		})
	);

describe('Blooio', () => {
	it.live('stores a signed message before acknowledging it', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(blooio, settings),
				body = message();
			expect(h.status).toMatchObject({ state: 'connected', account: '+16290000000' });
			expect((yield* h.link.webhook!(webhook(body, signature(body)))).status).toBe(200);
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				messages: [
					{
						id: 'm1',
						thread: person,
						sentAt: new Date(at).toISOString(),
						text: 'Hello',
						from: { handle: person, name: null },
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
			const h = yield* connected(blooio, settings),
				body = message();
			const stale = signature(body, settings.webhookSecret, Math.floor(Date.now() / 1000) - 301);
			for (const headers of [
				signature(body, 'forged'),
				stale,
				{},
				{ 'x-blooio-signature': 'nonsense' }
			])
				expect((yield* h.link.webhook!(webhook(body, headers))).status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a message the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(blooio, settings, {
					emit: () => Promise.reject(new Error('the store refused'))
				}),
				body = message();
			expect((yield* h.link.webhook!(webhook(body, signature(body)))).status).toBe(500);
		})
	);
	it.live('stores only received messages, the header naming the event first', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(blooio, settings);
			const sent = message({ event: 'message.sent' }),
				reaction = message({ event: 'message.reaction' }),
				named = message();
			yield* h.link.webhook!(webhook(sent, signature(sent)));
			yield* h.link.webhook!(webhook(reaction, signature(reaction)));
			yield* h.link.webhook!(
				webhook(named, { ...signature(named), 'x-blooio-event': 'message.delivered' })
			);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a group is its own thread, and a sender takes the name it is listed under', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(blooio, settings);
			const body = message({
				is_group: true,
				group_id: 'grp_1',
				group_name: 'Crew',
				participants: [{ contact_id: 'c1', identifier: person, name: 'Ann' }]
			});
			yield* h.link.webhook!(webhook(body, signature(body)));
			expect(h.events[0]).toMatchObject({
				messages: [
					{
						thread: 'group:grp_1',
						group: true,
						title: 'Crew',
						from: { name: 'Ann' },
						invocation: 'ambient'
					}
				]
			});
			yield* h.link.send!({ to: 'group:grp_1', text: 'Hi all' }, []);
			expect(api.calls.at(-1)?.url).toMatch(/\/chats\/grp_1\/messages$/);
		})
	);
	it.live('fetches an inbound file', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(blooio, settings),
				body = message({ attachments: ['https://cdn.test/photo.png?sig=1'] });
			yield* h.link.webhook!(webhook(body, signature(body)));
			expect(h.events[0]).toMatchObject({
				bins: [new Uint8Array([1, 2, 3])],
				messages: [{ attachments: [{ name: 'photo.png', mime: 'image/png', bytes: 3, bin: 0 }] }]
			});
		})
	);
	it.live('sends to the chat, with its number when it names one', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(blooio, { ...settings, fromNumber: '+16291111111' });
			const sent = yield* h.link.send!({ id: 'r1', to: person, text: 'Hello' }, []);
			expect(sent).toMatchObject({ providerId: 'out1' });
			const call = api.calls.at(-1);
			expect(call?.url).toBe(
				`https://backend.blooio.com/v2/api/chats/${encodeURIComponent(person)}/messages`
			);
			expect(call?.headers.get('authorization')).toBe('Bearer key');
			expect(JSON.parse(call?.body ?? '')).toEqual({ text: 'Hello', from_number: '+16291111111' });
			const connection = yield* direct();
			const answered = yield* Effect.promise(() => connection.send(person, 'Hello', 'r1', []));
			expect(answered).toEqual({ id: 'out1' });
		})
	);
	it.live('a refused send fails for good, a 429 retries when it says', () =>
		Effect.gen(function* () {
			let status = 400;
			yield* platformApi((call) =>
				call.url.endsWith('/messages')
					? new Response('{}', { status, headers: { 'retry-after': '2' } })
					: answer(call)
			);
			const h = yield* connected(blooio, settings);
			const refused = yield* Effect.flip(h.link.send!({ to: person, text: 'Hello' }, []));
			expect(refused).toMatchObject({ _tag: 'ProviderRefused', permanent: true });
			status = 429;
			const later = yield* Effect.flip(h.link.send!({ to: person, text: 'Hello' }, []));
			expect(later).toMatchObject({ _tag: 'ProviderUnavailable', retryAfterMs: 2000 });
		})
	);
	it.live('starts and stops typing', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer),
				methods: string[] = [];
			const connection = yield* direct(methods);
			yield* Effect.promise(async () => {
				await connection.typing?.('group:grp_1', true);
				await connection.typing?.('group:grp_1', false);
			});
			expect(methods.slice(-2)).toEqual(['POST', 'DELETE']);
			expect(api.calls.at(-1)?.url).toMatch(/\/chats\/grp_1\/typing$/);
		})
	);
	it.live('reads a thread back until a message is older than the window', () =>
		Effect.gen(function* () {
			const since = new Date(at).toISOString();
			const row = (id: string, time: number, attachments: unknown[] = []) => ({
				message_id: id,
				sender: person,
				text: id,
				attachments,
				time_sent: time
			});
			const api = yield* platformApi((call) => {
				if (!call.url.includes('/messages?')) return answer(call);
				return call.url.includes('offset=0')
					? json({
							messages: [
								row('new', at + 2, ['https://cdn.test/a.png', { url: 'https://cdn.test/b.pdf' }]),
								row('next', at + 1)
							],
							pagination: { total: 3 }
						})
					: json({ messages: [row('old', at - 1)], pagination: { total: 3 } });
			});
			const connection = yield* direct();
			const read = yield* Effect.promise(async () => connection.history?.(person, since));
			expect(read?.complete).toBe(true);
			expect(read?.messages.map((message) => message.id)).toEqual(['new', 'next']);
			expect(read?.messages[0]?.files?.map((file) => file.name)).toEqual(['a.png', 'b.pdf']);
			expect(new URL(api.calls.at(-1)?.url ?? '').searchParams.get('direction')).toBe('inbound');
		})
	);
	it.live('runs out of pages before the window ends, and says so', () =>
		Effect.gen(function* () {
			yield* platformApi((call) =>
				call.url.includes('/messages?')
					? json({
							messages: [
								{
									message_id: 'm',
									sender: person,
									text: 'm',
									attachments: [],
									time_sent: at + 1
								}
							],
							pagination: { total: 1000 }
						})
					: answer(call)
			);
			const connection = yield* direct();
			const read = yield* Effect.promise(async () =>
				connection.history?.(person, new Date(at).toISOString())
			);
			expect(read?.complete).toBe(false);
		})
	);
	it.live('a key Blooio refuses keeps nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ error: 'unauthorized' }, 401));
			const h = yield* host(chatProvider(blooio), fetch);
			yield* Effect.flip(h.link.pair!(settings));
			expect(h.values.size).toBe(0);
		})
	);
});
