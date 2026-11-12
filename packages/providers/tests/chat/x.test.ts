// X: mentions and direct messages over its Activity webhooks, with OAuth 1.0a checked the way X checks it.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider } from '../../src/chat/adapter.ts';
import { x } from '../../src/chat/x/index.ts';
import { required, host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const settings = {
	apiKey: 'consumer',
	apiSecret: 'consumer-secret',
	accessToken: 'token',
	accessTokenSecret: 'token-secret'
};
const sign = (body: string) => ({
	'x-twitter-webhooks-signature': `sha256=${createHmac('sha256', 'consumer-secret').update(body).digest('base64')}`
});
const answer = (call: Call) =>
	call.url.includes('/2/users/me')
		? json({ data: { id: '1', username: 'norbot' } })
		: call.url.endsWith('/2/tweets')
			? json({ data: { id: 'out1' } }, 201)
			: call.url.includes('pagination_token=p2')
				? json({
						data: [
							{ id: 'd2', text: 'in the window', sender_id: '2', created_at: '2026-10-01T10:00:00.000Z' },
							{ id: 'd1', text: 'too old', sender_id: '2', created_at: '2026-09-01T10:00:00.000Z' }
						]
					})
				: call.url.includes('/dm_events')
					? json({
							data: [
								{ id: 'd4', text: 'newest', sender_id: '2', created_at: '2026-10-03T10:00:00.000Z' },
								{ id: 'd3', text: 'mine', sender_id: '1', created_at: '2026-10-02T10:00:00.000Z' }
							],
							meta: { next_token: 'p2' }
						})
					: call.url.endsWith('/messages')
						? json({ data: { dm_event_id: 'out2', dm_conversation_id: '1-2' } }, 201)
						: json({});
const mention = JSON.stringify({
	data: {
		event_type: 'post.mention.create',
		payload: { id: 'p1', text: '@norbot hi', author_id: '2', created_at: '2026-10-01T10:00:00.000Z' },
		includes: { users: [{ id: '2', name: 'Mei', username: 'mei' }] }
	}
});
const dm = (sender: string, type = 'dm.received') =>
	JSON.stringify({
		data: [
			{
				event_type: type,
				payload: {
					direct_message_events: [
						{
							id: 'dm1',
							created_timestamp: '1790000000000',
							message_create: {
								sender_id: sender,
								target: { recipient_id: '1' },
								message_data: { text: 'hello' }
							}
						}
					],
					users: { '2': { data: { id: '2', name: 'Mei' } } }
				}
			}
		]
	});
/** Recomputes the OAuth 1.0a signature as X does: JSON bodies are outside it, query parameters inside. */
const oauthHolds = (call: Call, method: string) => {
	const fields = Object.fromEntries(
		[...(call.headers.get('authorization') ?? '').matchAll(/(\w+)="([^"]*)"/g)].map(
			([, name = '', value = '']) => [name, decodeURIComponent(value)]
		)
	);
	const { oauth_signature: signature, ...signed } = fields;
	const encode = (text: string) =>
		encodeURIComponent(text).replace(
			/[!'()*]/g,
			(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
		);
	const url = new URL(call.url);
	const params = [...Object.entries(signed), ...url.searchParams]
		.map(([name, value]) => `${encode(name)}=${encode(value)}`)
		.sort()
		.join('&');
	const base = `${method}&${encode(url.origin + url.pathname)}&${encode(params)}`;
	return createHmac('sha1', 'consumer-secret&token-secret').update(base).digest('base64') === signature;
};

describe('X', () => {
	it.live('stores a signed mention as its own thread before acknowledging it', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(x, settings);
			expect(h.status).toMatchObject({ state: 'connected', account: 'norbot' });
			expect((yield* required(h.link.webhook)(webhook(mention, sign(mention)))).status).toBe(200);
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				messages: [
					{
						id: 'p1',
						thread: 'post:p1',
						text: '@norbot hi',
						sent_at: '2026-10-01T10:00:00.000Z',
						from: { handle: '2', name: 'Mei' },
						group: true,
						invocation: 'mention'
					}
				]
			});
		})
	);
	it.live('stores a direct message and ignores the bot own', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(x, settings),
				own = dm('1', 'dm.sent'),
				theirs = dm('2');
			yield* required(h.link.webhook)(webhook(own, sign(own)));
			expect(h.events).toEqual([]);
			yield* required(h.link.webhook)(webhook(theirs, sign(theirs)));
			expect(h.events[0]).toMatchObject({
				messages: [
					{
						id: 'dm1',
						thread: 'dm:2',
						text: 'hello',
						sent_at: new Date(1_790_000_000_000).toISOString(),
						from: { handle: '2', name: 'Mei' },
						invocation: 'direct'
					}
				]
			});
		})
	);
	it.live('refuses a bad signature and stores nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(x, settings);
			const refused = yield* required(h.link.webhook)(
				webhook(mention, { 'x-twitter-webhooks-signature': 'sha256=forged' })
			);
			expect(refused.status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a message the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(x, settings, {
				emit: () => Promise.reject(new Error('the store refused'))
			});
			expect((yield* required(h.link.webhook)(webhook(mention, sign(mention)))).status).toBe(500);
		})
	);
	it.live('answers the CRC challenge, and signs nothing that is not a token', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(x, settings),
				token = 'abcdefghijklmnop1234';
			const answered = yield* required(h.link.webhook)(
				new Request(`https://hook.test/?crc_token=${token}`)
			);
			expect(yield* Effect.promise(() => answered.json())).toEqual({
				response_token: `sha256=${createHmac('sha256', 'consumer-secret').update(token).digest('base64')}`
			});
			const oracle = yield* required(h.link.webhook)(
				new Request(`https://hook.test/?crc_token=${encodeURIComponent(mention)}`)
			);
			expect(oracle.status).toBe(401);
		})
	);
	it.live('replies to a mention and writes a direct message, signed for X', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(x, settings);
			expect(oauthHolds(required(api.calls[0]), 'GET')).toBe(true);
			expect(yield* required(h.link.send)({ to: 'post:p1', text: 'Hello' }, [])).toMatchObject({
				provider_id: 'out1'
			});
			const post = api.calls.at(-1);
			expect(post?.url).toBe('https://api.x.com/2/tweets');
			expect(JSON.parse(post?.body ?? '')).toEqual({
				text: 'Hello',
				reply: { in_reply_to_tweet_id: 'p1' }
			});
			expect(oauthHolds(required(post), 'POST')).toBe(true);
			expect(yield* required(h.link.send)({ to: 'dm:2', text: 'Hi' }, [])).toMatchObject({
				provider_id: 'out2'
			});
			const direct = api.calls.at(-1);
			expect(direct?.url).toBe('https://api.x.com/2/dm_conversations/with/2/messages');
			expect(JSON.parse(direct?.body ?? '')).toEqual({ text: 'Hi' });
		})
	);
	it.live('a test message goes to a direct thread', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(x, settings);
			yield* required(h.link.test)({ to: '2' });
			expect(api.calls.at(-1)?.url).toBe('https://api.x.com/2/dm_conversations/with/2/messages');
		})
	);
	it.live('refusal status reaches a send, so a bad request does not retry', () =>
		Effect.gen(function* () {
			yield* platformApi((call) =>
				call.url.endsWith('/2/tweets') ? json({ title: 'Forbidden' }, 403) : answer(call)
			);
			const h = yield* connected(x, settings);
			const failure = yield* Effect.flip(required(h.link.send)({ to: 'post:p1', text: 'Hello' }, []));
			expect(failure.message).toContain('403');
		})
	);
	it.live('a key X refuses keeps nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ title: 'Unauthorized' }, 401));
			const h = yield* host(chatProvider(x), fetch);
			yield* Effect.flip(required(h.link.pair)(settings));
			expect(h.values.size).toBe(0);
		})
	);
	it.live('reads a direct thread back to the window, and says a post thread cannot be read', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const connection = yield* Effect.promise(() =>
				x.connect(settings, { fetch, webhook_url: 'https://hook.test/', receive: async () => {} })
			);
			const read = yield* Effect.promise(() =>
				required(connection.history)('dm:2', '2026-09-15T00:00:00.000Z')
			);
			expect(read.complete).toBe(true);
			expect(read.messages.map((message) => message.id)).toEqual(['d4', 'd2']);
			expect(read.messages[1]).toMatchObject({
				thread: 'dm:2',
				text: 'in the window',
				sent_at: '2026-10-01T10:00:00.000Z',
				from: { handle: '2' }
			});
			expect(oauthHolds(required(api.calls.at(-1)), 'GET')).toBe(true);
			expect(
				yield* Effect.promise(() => required(connection.history)('post:p1', '2026-09-15T00:00:00.000Z'))
			).toEqual({ messages: [], complete: false });
		})
	);
});
