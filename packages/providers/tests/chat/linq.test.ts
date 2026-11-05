// Linq: its real SDK, deliveries signed as Standard Webhooks signs them, and its API faked behind `fetch`.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider } from '../../src/chat/adapter.ts';
import { linq } from '../../src/chat/linq/index.ts';
import { host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const key = Buffer.from('a linq signing secret').toString('base64'),
	settings = { apiKey: 'key', signingSecret: `whsec_${key}` },
	own = '+16290000000',
	person = '+15551234567',
	handle = { id: 'h1', handle: person, joined_at: '2026-01-01T00:00:00Z', service: 'iMessage' };
const answer = (call: Call) => {
	if (call.url.endsWith('/v3/phone_numbers'))
		return json({ phone_numbers: [{ id: 'n1', phone_number: own }] });
	if (call.url.endsWith('/v3/chats/c1') || call.url.endsWith('/v3/chats/g1'))
		return json({ id: 'c1', is_group: call.url.endsWith('g1') });
	if (call.url.endsWith('/v3/messages/m0')) return json({ id: 'm0', is_from_me: true });
	if (call.url.endsWith('/v3/messages') && call.body !== '')
		return json({ chat_id: 'c9', message: { id: 'out9' } });
	if (call.url.endsWith('/v3/chats/c1/messages') && call.body !== '')
		return json({ chat_id: 'c1', message: { id: 'out1' } });
	if (call.url.endsWith('/typing')) return new Response(null, { status: 204 });
	if (call.url.startsWith('https://cdn.test/')) return new Response(new Uint8Array([1, 2, 3]));
	return json({});
};
const event = (data: object, type = 'message.received') =>
	JSON.stringify({
		api_version: 'v3',
		created_at: '2026-01-02T03:04:06.000Z',
		event_id: 'e1',
		event_type: type,
		partner_id: 'p1',
		trace_id: 't1',
		webhook_version: '2026-02-03',
		data
	});
const message = (extra: object = {}) => ({
	id: 'm1',
	chat: { id: 'c1', is_group: false, owner_handle: { ...handle, handle: own, is_me: true } },
	direction: 'inbound',
	parts: [{ type: 'text', value: 'Hello' }],
	sender_handle: handle,
	service: 'iMessage',
	sent_at: '2026-01-02T03:04:05.000Z',
	...extra
});
/** The Standard Webhooks signature: HMAC-SHA256, under the decoded secret, of `id.timestamp.body`. */
const signature = (body: string, secret = key) => {
	const id = 'msg_1',
		at = String(Math.floor(Date.now() / 1000)),
		mac = createHmac('sha256', Buffer.from(secret, 'base64')).update(`${id}.${at}.${body}`);
	return {
		'webhook-id': id,
		'webhook-timestamp': at,
		'webhook-signature': `v1,${mac.digest('base64')}`
	};
};
const direct = (seen?: string[]) =>
	Effect.promise(() =>
		linq.connect(settings, {
			fetch: (input, init) => {
				seen?.push(init?.method ?? 'GET');
				return fetch(input, init);
			},
			webhookUrl: 'https://hook.test/',
			receive: () => Promise.resolve()
		})
	);

describe('Linq', () => {
	it.live('stores a signed message before acknowledging it', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(linq, settings),
				body = event(message());
			expect(h.status).toMatchObject({ state: 'connected', account: own });
			expect((yield* h.link.webhook!(webhook(body, signature(body)))).status).toBe(200);
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				messages: [
					{
						id: 'm1',
						thread: 'c1',
						sentAt: '2026-01-02T03:04:05.000Z',
						text: 'Hello',
						from: { handle: person, name: null },
						replyTo: null,
						group: false,
						invocation: 'direct'
					}
				]
			});
		})
	);
	it.live('refuses a bad signature and stores nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(linq, settings),
				body = event(message());
			const forged = signature(body, Buffer.from('another').toString('base64'));
			expect((yield* h.link.webhook!(webhook(body, forged))).status).toBe(401);
			expect((yield* h.link.webhook!(webhook(body, {}))).status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a message the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(linq, settings, {
					emit: () => Promise.reject(new Error('the store refused'))
				}),
				body = event(message());
			expect((yield* h.link.webhook!(webhook(body, signature(body)))).status).toBe(500);
		})
	);
	it.live('stores neither its own sends nor other events', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(linq, settings);
			for (const body of [
				event(message({ direction: 'outbound' })),
				event(message(), 'message.delivered'),
				event({ chat_id: 'c1' }, 'reaction.added')
			])
				expect((yield* h.link.webhook!(webhook(body, signature(body)))).status).toBe(200);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a group reads its mention, a reply to us, and asks when the event omits the kind', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(linq, settings);
			const chat = { id: 'g1', is_group: true, owner_handle: { ...handle, handle: own } };
			const mention = event(
				message({ chat, parts: [{ type: 'text', value: '@bot hi', mention: own }] })
			);
			const reply = event(message({ chat, id: 'm2', reply_to: { message_id: 'm0' } }));
			const ambient = event(message({ chat, id: 'm3' }));
			const unknown = event(message({ chat: { id: 'g1' }, id: 'm4' }));
			for (const body of [mention, reply, ambient, unknown])
				yield* h.link.webhook!(webhook(body, signature(body)));
			expect(h.events[0]).toMatchObject({ messages: [{ group: true, invocation: 'mention' }] });
			expect(h.events[1]).toMatchObject({ messages: [{ replyTo: 'm0', invocation: 'reply' }] });
			expect(h.events[2]).toMatchObject({ messages: [{ invocation: 'ambient' }] });
			expect(h.events[3]).toMatchObject({ messages: [{ group: true, invocation: 'ambient' }] });
		})
	);
	it.live('an edit carries its own instant', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(linq, settings);
			const body = event(
				{
					id: 'm1',
					chat: { id: 'c1', is_group: false },
					direction: 'inbound',
					edited_at: '2026-01-02T04:00:00.000Z',
					part: { index: 0, text: 'Hello again' },
					sender_handle: handle
				},
				'message.edited'
			);
			yield* h.link.webhook!(webhook(body, signature(body)));
			expect(h.events[0]).toMatchObject({
				messages: [
					{ id: 'm1', thread: 'c1', text: 'Hello again', version: '2026-01-02T04:00:00.000Z' }
				]
			});
		})
	);
	it.live('fetches an inbound file', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(linq, settings);
			const body = event(
				message({
					parts: [
						{ type: 'text', value: 'Look' },
						{
							type: 'media',
							id: 'f1',
							filename: 'a.png',
							mime_type: 'image/png',
							size_bytes: 3,
							url: 'https://cdn.test/a.png'
						}
					]
				})
			);
			yield* h.link.webhook!(webhook(body, signature(body)));
			expect(h.events[0]).toMatchObject({
				bins: [new Uint8Array([1, 2, 3])],
				messages: [
					{ text: 'Look', attachments: [{ name: 'a.png', mime: 'image/png', bytes: 3, bin: 0 }] }
				]
			});
		})
	);
	it.live('sends with an idempotency key, so a resend cannot duplicate', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(linq, settings);
			const sent = yield* h.link.send!({ id: 'r1', to: 'c1', text: 'Hello' }, []);
			expect(sent).toMatchObject({ providerId: 'out1' });
			const call = api.calls.at(-1);
			expect(call?.url).toMatch(/\/v3\/chats\/c1\/messages$/);
			expect(call?.headers.get('authorization')).toBe('Bearer key');
			expect(JSON.parse(call?.body ?? '')).toEqual({
				message: { parts: [{ type: 'text', value: 'Hello' }], idempotency_key: 'r1' }
			});
			const connection = yield* direct();
			const answered = yield* Effect.promise(() => connection.send('c1', 'Hello', 'r1', []));
			expect(answered).toEqual({ id: 'out1' });
			expect(linq.idempotent).toBe(true);
		})
	);
	it.live('a test message to a person creates their chat', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(linq, settings);
			yield* h.link.test!({ to: person });
			const call = api.calls.at(-1);
			expect(call?.url).toMatch(/\/v3\/messages$/);
			expect(JSON.parse(call?.body ?? '')).toMatchObject({
				to: [person],
				message: { parts: [{ type: 'text', value: 'Norbital test message' }] }
			});
		})
	);
	it.live('a refused send fails for good', () =>
		Effect.gen(function* () {
			yield* platformApi((call) =>
				call.url.endsWith('/v3/chats/c1/messages') ? json({ message: 'no' }, 403) : answer(call)
			);
			const h = yield* connected(linq, settings);
			const refused = yield* Effect.flip(h.link.send!({ to: 'c1', text: 'Hello' }, []));
			expect(refused).toMatchObject({ _tag: 'ProviderRefused', permanent: true });
		})
	);
	it.live('starts and stops typing', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer),
				methods: string[] = [];
			const connection = yield* direct(methods);
			yield* Effect.promise(async () => {
				await connection.typing?.('c1', true);
				await connection.typing?.('c1', false);
			});
			expect(methods.slice(-2)).toEqual(['POST', 'DELETE']);
			expect(api.calls.at(-1)?.url).toMatch(/\/v3\/chats\/c1\/typing$/);
		})
	);
	it.live('walks a thread back, keeping the window and leaving out its own', () =>
		Effect.gen(function* () {
			const row = (id: string, sentAt: string, mine = false) => ({
				id,
				chat_id: 'g1',
				created_at: sentAt,
				sent_at: sentAt,
				is_from_me: mine,
				from_handle: handle,
				parts: [{ type: 'text', value: id }]
			});
			yield* platformApi((call) => {
				if (!call.url.includes('/v3/chats/g1/messages')) return answer(call);
				return call.url.includes('cursor=next')
					? json({ messages: [row('old', '2025-01-01T00:00:00.000Z')], next_cursor: '' })
					: json({
							messages: [
								row('new', '2026-01-03T00:00:00.000Z'),
								row('mine', '2026-01-03T00:00:00.000Z', true)
							],
							next_cursor: 'next'
						});
			});
			const connection = yield* direct();
			const read = yield* Effect.promise(async () =>
				connection.history?.('g1', '2026-01-01T00:00:00.000Z')
			);
			expect(read).toMatchObject({
				complete: true,
				messages: [{ id: 'new', thread: 'g1', group: true, text: 'new', from: { handle: person } }]
			});
			expect(read?.messages).toHaveLength(1);
		})
	);
	it.live('a thread too long to walk is not the whole window', () =>
		Effect.gen(function* () {
			yield* platformApi((call) =>
				call.url.includes('/v3/chats/c1/messages')
					? json({
							messages: Array.from({ length: 100 }, (_, index) => ({
								id: `m${index}`,
								created_at: '2026-01-03T00:00:00.000Z',
								is_from_me: false
							})),
							next_cursor: 'more'
						})
					: answer(call)
			);
			const connection = yield* direct();
			const read = yield* Effect.promise(async () =>
				connection.history?.('c1', '2026-01-01T00:00:00.000Z')
			);
			expect(read?.complete).toBe(false);
		})
	);
	it.live('a key Linq refuses keeps nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ message: 'Unauthorized' }, 401));
			const h = yield* host(chatProvider(linq), fetch);
			yield* Effect.flip(h.link.pair!(settings));
			expect(h.values.size).toBe(0);
		})
	);
});
