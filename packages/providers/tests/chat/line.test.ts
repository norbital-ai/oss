// LINE: its real SDK, signed deliveries, and its API faked behind `fetch`.
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { line } from '../../src/chat/line/index.ts';
import { hmac } from '../../src/chat/verify.ts';
import { connected, json, platformApi, webhook } from './kit.ts';

const settings = { channelAccessToken: 'token', channelSecret: 'secret' };
const answer = (call: { url: string }) =>
	call.url.endsWith('/v2/bot/info')
		? json({ basicId: '@acme', userId: 'U0', displayName: 'Acme', chatMode: 'bot' })
		: call.url.endsWith('/message/push')
			? json({ sentMessages: [{ id: 'out1', quoteToken: 'q' }] })
			: json({});
const text = (extra: object = {}) =>
	JSON.stringify({
		destination: 'U0',
		events: [
			{
				type: 'message',
				mode: 'active',
				timestamp: 1_790_000_000_000,
				webhookEventId: 'e1',
				deliveryContext: { isRedelivery: false },
				source: { type: 'user', userId: 'U1' },
				message: { id: 'm1', type: 'text', quoteToken: 'q', text: 'こんにちは' },
				...extra
			}
		]
	});
const signature = (body: string) => ({ 'x-line-signature': hmac('secret', body, 'base64') });

describe('LINE', () => {
	it.live('stores a signed message before acknowledging it', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(line, settings),
				body = text();
			expect(h.status).toMatchObject({ state: 'connected', account: '@acme' });
			expect((yield* h.link.webhook!(webhook(body, signature(body)))).status).toBe(200);
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				messages: [
					{ id: 'm1', thread: 'U1', text: 'こんにちは', from: { handle: 'U1' }, invocation: 'direct' }
				]
			});
		})
	);
	it.live('refuses a bad signature and stores nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(line, settings),
				body = text();
			const refused = yield* h.link.webhook!(webhook(body, { 'x-line-signature': 'forged' }));
			expect(refused.status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a message the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(line, settings, {
					emit: () => Promise.reject(new Error('the store refused'))
				}),
				body = text();
			expect((yield* h.link.webhook!(webhook(body, signature(body)))).status).toBe(500);
		})
	);
	it.live('an unsend is a delete, and a group message reads its mention', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(line, settings);
			const unsend = text({ type: 'unsend', unsend: { messageId: 'm1' }, message: undefined }),
				group = text({
					source: { type: 'group', groupId: 'G1', userId: 'U1' },
					message: {
						id: 'm2',
						type: 'text',
						quoteToken: 'q',
						text: '@bot hi',
						mention: { mentionees: [{ type: 'user', index: 0, length: 4, isSelf: true }] }
					}
				});
			yield* h.link.webhook!(webhook(unsend, signature(unsend)));
			yield* h.link.webhook!(webhook(group, signature(group)));
			expect(h.events[0]).toMatchObject({ messages: [{ id: 'm1', deleted: true }] });
			expect(h.events[1]).toMatchObject({
				messages: [{ id: 'm2', thread: 'G1', group: true, invocation: 'mention' }]
			});
		})
	);
	it.live('sends with a retry key, so a resend cannot duplicate', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(line, settings);
			const sent = yield* h.link.send!({ id: 'r1', to: 'U1', text: 'Hello' }, []);
			expect(sent).toMatchObject({ providerId: 'out1' });
			const call = api.calls.at(-1);
			expect(call?.headers.get('x-line-retry-key')).toBe('r1');
			expect(JSON.parse(call?.body ?? '')).toMatchObject({
				to: 'U1',
				messages: [{ type: 'text', text: 'Hello' }]
			});
		})
	);
	it.live('a token LINE refuses keeps nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ message: 'Invalid token' }, 401));
			const { chatProvider } = yield* Effect.promise(() => import('../../src/chat/adapter.ts'));
			const { host } = yield* Effect.promise(() => import('../kit.ts'));
			const h = yield* host(chatProvider(line), fetch);
			yield* Effect.flip(h.link.pair!(settings));
			expect(h.values.size).toBe(0);
		})
	);
});
