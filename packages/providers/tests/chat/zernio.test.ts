// Zernio: its HMAC-signed webhooks and its inbox API behind `fetch`.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider } from '../../src/chat/adapter.ts';
import { zernio } from '../../src/chat/zernio/index.ts';
import { required, host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const settings = { apiKey: 'key', webhookSecret: 'hook-secret' };
const sign = (body: string) => ({
	'x-zernio-signature': createHmac('sha256', 'hook-secret').update(body).digest('hex')
});
const answer = (call: Call) =>
	call.url.includes('cursor=c2')
		? json({
				messages: [
					{
						id: 'r2',
						platformMessageId: 'p2',
						direction: 'incoming',
						message: 'in the window',
						senderId: 'u1',
						senderName: 'Mei',
						createdAt: '2026-10-01T10:00:00.000Z'
					},
					{
						id: 'r1',
						direction: 'incoming',
						message: 'too old',
						senderId: 'u1',
						createdAt: '2026-09-01T10:00:00.000Z'
					}
				],
				pagination: { hasMore: false, nextCursor: null },
				sortOrderApplied: 'desc'
			})
		: call.url.includes('/messages?')
			? json({
					messages: [
						{
							id: 'r4',
							platformMessageId: 'p4',
							direction: 'incoming',
							text: 'newest',
							senderId: 'u1',
							sentAt: '2026-10-03T10:00:00.000Z'
						},
						{
							id: 'r3',
							direction: 'outgoing',
							message: 'mine',
							createdAt: '2026-10-02T10:00:00.000Z'
						}
					],
					pagination: { hasMore: true, nextCursor: 'c2' },
					sortOrderApplied: 'desc'
				})
			: call.url.endsWith('/messages')
				? json({ data: { messageId: 'out1' } })
				: call.url.endsWith('/typing')
					? json({ success: true })
					: call.url.includes('cdn.test')
						? new Response('image-bytes')
						: json({ data: [], pagination: { hasMore: false, nextCursor: null } });
const received = (extra: object = {}) =>
	JSON.stringify({
		id: 'e1',
		event: 'message.received',
		timestamp: '2026-10-01T10:00:00.000Z',
		message: {
			id: 'internal1',
			conversationId: 'conv1',
			platform: 'instagram',
			platformMessageId: 'ig1',
			direction: 'incoming',
			text: 'hello',
			attachments: [],
			sender: { id: 'u1', name: 'Mei', username: 'mei' },
			sentAt: '2026-10-01T10:00:00.000Z',
			isRead: false,
			...extra
		},
		conversation: { id: 'conv1', platformConversationId: 'x', status: 'active' },
		account: { id: 'acct1', platform: 'instagram', username: 'acme' },
		metadata: { quotedMessageId: 'ig0' }
	});

describe('Zernio', () => {
	it.live('stores a signed message under its platform id', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(zernio, settings),
				body = received();
			expect(h.status).toMatchObject({ state: 'connected', account: 'Zernio' });
			expect((yield* required(h.link.webhook)(webhook(body, sign(body)))).status).toBe(200);
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				messages: [
					{
						id: 'ig1',
						thread: 'acct1:conv1',
						text: 'hello',
						sent_at: '2026-10-01T10:00:00.000Z',
						from: { handle: 'u1', name: 'Mei' },
						reply_to: 'ig0',
						invocation: 'direct'
					}
				]
			});
		})
	);
	it.live('fetches an inbound file, and takes the older signature header', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(zernio, settings),
				body = received({
					attachments: [
						{ type: 'image', url: 'https://cdn.test/a.jpg' },
						{ type: 'location', url: '' }
					]
				});
			yield* required(h.link.webhook)(
				webhook(body, { 'x-late-signature': sign(body)['x-zernio-signature'] })
			);
			const event = h.events[0];
			expect(event).toMatchObject({
				messages: [{ attachments: [{ name: 'zernio-ig1-0', mime: 'image/*', bin: 0 }] }]
			});
			expect(event?.kind === 'messages' ? new TextDecoder().decode(event.bins?.[0]) : '').toBe(
				'image-bytes'
			);
		})
	);
	it.live('ignores the account own messages and other events', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(zernio, settings),
				own = received({ direction: 'outgoing' }),
				comment = JSON.stringify({ event: 'comment.received' });
			yield* required(h.link.webhook)(webhook(own, sign(own)));
			yield* required(h.link.webhook)(webhook(comment, sign(comment)));
			expect(h.events).toEqual([]);
		})
	);
	it.live('refuses a bad signature and stores nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(zernio, settings),
				body = received();
			const refused = yield* required(h.link.webhook)(webhook(body, { 'x-zernio-signature': 'forged' }));
			expect(refused.status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a message the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(zernio, settings, {
					emit: () => Promise.reject(new Error('the store refused'))
				}),
				body = received();
			expect((yield* required(h.link.webhook)(webhook(body, sign(body)))).status).toBe(500);
		})
	);
	it.live('sends into a conversation in its account, and shows typing', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(zernio, settings);
			expect(yield* required(h.link.send)({ to: 'acct1:conv1', text: 'Hello' }, [])).toMatchObject({
				provider_id: 'out1'
			});
			const call = api.calls.at(-1);
			expect(call?.url).toBe('https://zernio.com/api/v1/inbox/conversations/conv1/messages');
			expect(call?.headers.get('authorization')).toBe('Bearer key');
			expect(JSON.parse(call?.body ?? '')).toEqual({ accountId: 'acct1', message: 'Hello' });
			yield* required(h.link.typing)('acct1:conv1', true);
			expect(api.calls.at(-1)?.url).toBe(
				'https://zernio.com/api/v1/inbox/conversations/conv1/typing'
			);
			const before = api.calls.length;
			yield* required(h.link.typing)('acct1:conv1', false);
			expect(api.calls).toHaveLength(before);
		})
	);
	it.live('a key Zernio refuses keeps nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ error: 'Unauthorized' }, 401));
			const h = yield* host(chatProvider(zernio), fetch);
			yield* Effect.flip(required(h.link.pair)(settings));
			expect(h.values.size).toBe(0);
		})
	);
	it.live('reads a thread back across pages to the window', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const connection = yield* Effect.promise(() =>
				zernio.connect(settings, {
					fetch,
					webhook_url: 'https://hook.test/',
					receive: async () => {}
				})
			);
			const read = yield* Effect.promise(() =>
				required(connection.history)('acct1:conv1', '2026-09-15T00:00:00.000Z')
			);
			expect(read.complete).toBe(true);
			expect(read.messages).toEqual([
				{
					id: 'p4',
					thread: 'acct1:conv1',
					sent_at: '2026-10-03T10:00:00.000Z',
					from: { handle: 'u1', name: null },
					text: 'newest'
				},
				{
					id: 'p2',
					thread: 'acct1:conv1',
					sent_at: '2026-10-01T10:00:00.000Z',
					from: { handle: 'u1', name: 'Mei' },
					text: 'in the window'
				}
			]);
		})
	);
	it.live('a platform that ignored the order is read to its last page', () =>
		Effect.gen(function* () {
			const api = yield* platformApi((call) =>
				call.url.includes('cursor=c2')
					? json({
							messages: [
								{
									id: 'r9',
									direction: 'incoming',
									message: 'newer',
									senderId: 'u1',
									createdAt: '2026-10-05T10:00:00.000Z'
								}
							],
							pagination: { nextCursor: null },
							sortOrderApplied: 'asc'
						})
					: call.url.includes('/messages?')
						? json({
								messages: [
									{
										id: 'r8',
										direction: 'incoming',
										message: 'old',
										senderId: 'u1',
										createdAt: '2026-09-01T10:00:00.000Z'
									}
								],
								pagination: { nextCursor: 'c2' },
								sortOrderApplied: 'asc'
							})
						: answer(call)
			);
			const connection = yield* Effect.promise(() =>
				zernio.connect(settings, {
					fetch,
					webhook_url: 'https://hook.test/',
					receive: async () => {}
				})
			);
			const read = yield* Effect.promise(() =>
				required(connection.history)('acct1:conv1', '2026-09-15T00:00:00.000Z')
			);
			expect(read.messages.map((message) => message.id)).toEqual(['r9']);
			expect(api.calls.at(-1)?.url).toContain('cursor=c2');
		})
	);
});
