// Novu: its signed bridge calls and its event ingest behind `fetch`.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider } from '../../src/chat/adapter.ts';
import { novu } from '../../src/chat/novu/index.ts';
import { host } from '../kit.ts';
import { connected, json, platformApi, webhook } from './kit.ts';

const settings = { apiKey: 'nv-key', agentIdentifier: 'agent1' };
const answer = () => json({ accepted: 1 }, 202);
const sign = (body: string, secret = 'nv-key', at = Date.now()) => ({
	'novu-signature': `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`
});
const message = (extra: object = {}) => ({
	text: 'hello',
	platformMessageId: 'm1',
	author: { userId: 'U1', fullName: 'Mei', userName: 'mei', isBot: false },
	timestamp: '2026-10-01T10:00:00.000Z',
	...extra
});
const bridge = (event: string, extra: object = {}) =>
	JSON.stringify({
		version: 1,
		timestamp: '2026-10-01T10:00:00.000Z',
		deliveryId: 'd1',
		event,
		agentId: 'agent1',
		conversationId: 'conv1',
		integrationIdentifier: 'slack-1',
		message: message(),
		subscriber: { subscriberId: 'sub1' },
		platform: 'slack',
		platformContext: { threadId: 't', channelId: 'c', isDM: false },
		...extra
	});

describe('Novu', () => {
	it.live('stores a signed message as a mention, with its subscriber', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(novu, settings),
				body = bridge('onMessage');
			expect(h.status).toMatchObject({ state: 'connected', account: 'agent1' });
			expect((yield* h.link.webhook!(webhook(body, sign(body)))).status).toBe(200);
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				messages: [
					{
						id: 'm1',
						thread: 'conv1',
						text: 'hello',
						sentAt: '2026-10-01T10:00:00.000Z',
						from: { handle: 'sub1', name: 'Mei' },
						group: true,
						invocation: 'mention'
					}
				]
			});
		})
	);
	it.live('a direct conversation, a reply and a file', () =>
		Effect.gen(function* () {
			yield* platformApi((call) =>
				call.url.includes('files.test') ? new Response('file-bytes') : answer()
			);
			const h = yield* connected(novu, settings),
				body = bridge('onMessage', {
					platformContext: { threadId: 't', channelId: 'c', isDM: true },
					message: message({
						replyTo: { messageId: 'm0' },
						attachments: [
							{
								type: 'image',
								url: 'https://files.test/a.png',
								name: 'a.png',
								mimeType: 'image/png',
								size: 10
							},
							{ type: 'file' }
						]
					})
				});
			yield* h.link.webhook!(webhook(body, sign(body)));
			const event = h.events[0];
			expect(event).toMatchObject({
				messages: [
					{
						invocation: 'direct',
						replyTo: 'm0',
						attachments: [{ name: 'a.png', mime: 'image/png', bin: 0 }]
					}
				]
			});
			expect(event?.kind === 'messages' ? new TextDecoder().decode(event.bins?.[0]) : '').toBe(
				'file-bytes'
			);
		})
	);
	it.live('an edit is the same id at a new version, and a delete names it', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(novu, settings),
				edit = bridge('onMessageUpdated', {
					message: message({ text: 'edited', timestamp: '2026-10-01T11:00:00.000Z' })
				}),
				gone = bridge('onMessageDeleted', { message: null, previousMessage: message() });
			yield* h.link.webhook!(webhook(edit, sign(edit)));
			yield* h.link.webhook!(webhook(gone, sign(gone)));
			expect(h.events[0]).toMatchObject({
				messages: [{ id: 'm1', text: 'edited', version: '2026-10-01T11:00:00.000Z' }]
			});
			expect(h.events[1]).toMatchObject({ messages: [{ id: 'm1', text: '', deleted: true }] });
		})
	);
	it.live('ignores a bot message and events that carry no message', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(novu, settings),
				own = bridge('onMessage', {
					message: message({ author: { userId: 'B', fullName: 'Bot', userName: 'b', isBot: true } })
				}),
				action = bridge('onAction', { message: null });
			yield* h.link.webhook!(webhook(own, sign(own)));
			yield* h.link.webhook!(webhook(action, sign(action)));
			expect(h.events).toEqual([]);
		})
	);
	it.live('answers the bridge probes without a signature', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(novu, settings);
			const health = yield* h.link.webhook!(
				new Request('https://hook.test/?action=health-check')
			);
			expect(yield* Effect.promise(() => health.json())).toEqual({ status: 'ok' });
			const discover = yield* h.link.webhook!(new Request('https://hook.test/?action=discover'));
			expect(yield* Effect.promise(() => discover.json())).toEqual({
				workflows: [],
				agents: [{ agentId: 'agent1' }]
			});
		})
	);
	it.live('refuses a bad signature, a stale one and a future one', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(novu, settings),
				body = bridge('onMessage');
			for (const headers of [
				{ 'novu-signature': 't=1,v1=forged' },
				sign(body, 'wrong-secret'),
				sign(body, 'nv-key', Date.now() - 6 * 60 * 1000),
				sign(body, 'nv-key', Date.now() + 60 * 1000),
				{}
			])
				expect((yield* h.link.webhook!(webhook(body, headers))).status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a separate bridge secret signs in place of the key', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(novu, { ...settings, bridgeSecret: 'bridge' }),
				body = bridge('onMessage');
			expect((yield* h.link.webhook!(webhook(body, sign(body, 'bridge')))).status).toBe(200);
			expect((yield* h.link.webhook!(webhook(body, sign(body)))).status).toBe(401);
		})
	);
	it.live('a message the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(novu, settings, {
					emit: () => Promise.reject(new Error('the store refused'))
				}),
				body = bridge('onMessage');
			expect((yield* h.link.webhook!(webhook(body, sign(body)))).status).toBe(500);
		})
	);
	it.live('sends an assistant message into the conversation', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(novu, settings);
			const sent = yield* h.link.send!({ to: 'conv1', text: 'Hello **there**' }, []);
			const call = api.calls.at(-1);
			expect(call?.url).toBe('https://api.novu.co/v1/agents/events/ingest');
			expect(call?.headers.get('authorization')).toBe('ApiKey nv-key');
			expect(JSON.parse(call?.body ?? '')).toMatchObject({
				events: [
					{
						version: 1,
						conversationId: 'conv1',
						agentId: 'agent1',
						sequence: 1,
						event: {
							type: 'message',
							role: 'assistant',
							messageId: sent.providerId,
							content: { markdown: 'Hello **there**' }
						}
					}
				]
			});
		})
	);
	it.live('a refused send carries its status', () =>
		Effect.gen(function* () {
			let refusing = false;
			yield* platformApi(() => (refusing ? json({}, 422) : answer()));
			const h = yield* connected(novu, settings);
			refusing = true;
			const failure = yield* Effect.flip(h.link.send!({ to: 'conv1', text: 'hi' }, []));
			expect(failure.message).toContain('422');
		})
	);
	it.live('a key Novu refuses keeps nothing', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(() => json({ message: 'Unauthorized' }, 401));
			const h = yield* host(chatProvider(novu), fetch);
			yield* Effect.flip(h.link.pair!(settings));
			expect(JSON.parse(api.calls[0]?.body ?? '')).toEqual({ events: [] });
			expect(h.values.size).toBe(0);
		})
	);
});
