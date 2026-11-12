// AgentPhone: deliveries signed as its webhooks are, and its REST API faked behind `fetch`.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider } from '../../src/chat/adapter.ts';
import { agentphone } from '../../src/chat/agentphone/index.ts';
import { required, host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const settings = { apiKey: 'key', agentId: 'agent1', webhookSecret: 'hook' },
	person = '+15551234567';
/** An empty recipient is a validation error, as the send a connection proves itself with is. */
const answer = (call: Call) => {
	if (call.url.startsWith('https://cdn.test/')) return new Response(new Uint8Array([1, 2, 3]));
	return JSON.parse(call.body).to_number === ''
		? json({ detail: [{ msg: 'to_number is required' }] }, 422)
		: json({ id: 'out1', status: 'queued' });
};
const event = (data: object = {}, name = 'agent.message') =>
	JSON.stringify({
		event: name,
		channel: 'imessage',
		timestamp: '2026-01-02T03:04:05.000Z',
		agentId: 'agent1',
		data: {
			messageId: 'm1',
			conversationId: 'c1',
			numberId: 'n1',
			from: person,
			to: '+16290000000',
			contact: { id: 'p1', name: 'Ann', email: null, phoneNumber: person },
			message: 'Hello',
			mediaUrl: null,
			mediaUrls: [],
			direction: 'inbound',
			receivedAt: '2026-01-02T03:04:05.000Z',
			...data
		},
		conversationState: null,
		recentHistory: []
	});
/** `sha256=<hex HMAC-SHA256 of "timestamp.body">`, the timestamp in its own header. */
const signature = (
	body: string,
	secret = settings.webhookSecret,
	seconds = Math.floor(Date.now() / 1000)
) => ({
	'x-webhook-timestamp': String(seconds),
	'x-webhook-signature': `sha256=${createHmac('sha256', secret).update(`${seconds}.${body}`).digest('hex')}`
});

describe('AgentPhone', () => {
	it.live('stores a signed message before acknowledging it', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(agentphone, settings),
				body = event();
			expect(h.status).toMatchObject({ state: 'connected', account: 'agent1' });
			expect((yield* required(h.link.webhook)(webhook(body, signature(body)))).status).toBe(200);
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				messages: [
					{
						id: 'm1',
						thread: person,
						sent_at: '2026-01-02T03:04:05.000Z',
						text: 'Hello',
						from: { handle: person, name: 'Ann' },
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
			const h = yield* connected(agentphone, settings),
				body = event();
			const stale = signature(body, 'hook', Math.floor(Date.now() / 1000) - 301);
			for (const headers of [signature(body, 'forged'), stale, {}])
				expect((yield* required(h.link.webhook)(webhook(body, headers))).status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live(
		'refuses malformed signed message fields before storing and accepts the next delivery',
		() =>
			Effect.gen(function* () {
				yield* platformApi(answer);
				const h = yield* connected(agentphone, settings);
				for (const fields of [
					{ messageId: 3 },
					{ from: [] },
					{ message: {} },
					{ mediaUrls: [7] }
				]) {
					const body = event(fields);
					expect(yield* Effect.flip(required(h.link.webhook)(webhook(body, signature(body))))).toMatchObject(
						{
							_tag: 'ProviderUnavailable'
						}
					);
				}
				expect(h.events).toEqual([]);
				const ignored = JSON.stringify({ event: 'call.ended' });
				expect((yield* required(h.link.webhook)(webhook(ignored, signature(ignored)))).status).toBe(200);
				const body = event();
				expect((yield* required(h.link.webhook)(webhook(body, signature(body)))).status).toBe(200);
				expect(h.events).toHaveLength(1);
			})
	);
	it.live('refuses an invalid send acknowledgement', () =>
		Effect.gen(function* () {
			yield* platformApi((call) =>
				JSON.parse(call.body).to_number === '' ? json({}, 422) : json({ id: 19 })
			);
			const h = yield* connected(agentphone, settings);
			expect(yield* Effect.flip(required(h.link.send)({ to: person, text: 'hello' }, []))).toMatchObject({
				_tag: 'ProviderUnavailable'
			});
		})
	);
	it.live('a message the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(agentphone, settings, {
					emit: () => Promise.reject(new Error('the store refused'))
				}),
				body = event();
			expect((yield* required(h.link.webhook)(webhook(body, signature(body)))).status).toBe(500);
		})
	);
	it.live('stores neither its own sends, calls nor reactions', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(agentphone, settings);
			for (const body of [
				event({ direction: 'outbound' }),
				event({}, 'agent.call_ended'),
				event({}, 'agent.reaction')
			])
				expect((yield* required(h.link.webhook)(webhook(body, signature(body)))).status).toBe(200);
			expect(h.events).toEqual([]);
		})
	);
	it.live('fetches an inbound file', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(agentphone, settings),
				body = event({ mediaUrls: ['https://cdn.test/photo.jpeg'] });
			yield* required(h.link.webhook)(webhook(body, signature(body)));
			expect(h.events[0]).toMatchObject({
				bins: [new Uint8Array([1, 2, 3])],
				messages: [{ attachments: [{ name: 'photo.jpeg', mime: 'image/jpeg', bytes: 3, bin: 0 }] }]
			});
		})
	);
	it.live('sends as its agent, within its length, and claims no dedupe', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(agentphone, settings);
			const sent = yield* required(h.link.send)({ id: 'r1', to: person, text: 'x'.repeat(2000) }, []);
			expect(sent).toMatchObject({ provider_id: 'out1' });
			const call = api.calls.at(-1);
			expect(call?.url).toBe('https://api.agentphone.ai/v1/messages');
			expect(call?.headers.get('authorization')).toBe('Bearer key');
			expect(JSON.parse(call?.body ?? '')).toEqual({
				agent_id: 'agent1',
				to_number: person,
				body: 'x'.repeat(1600)
			});
			const connection = yield* Effect.promise(() =>
				agentphone.connect(settings, {
					fetch,
					webhook_url: 'https://hook.test/',
					receive: () => Promise.resolve()
				})
			);
			const answered = yield* Effect.promise(() => connection.send(person, 'Hello', 'r1', []));
			expect(answered).toEqual({ id: 'out1' });
			expect(connection.history).toBeUndefined();
		})
	);
	it.live('a refused send fails for good, an outage retries', () =>
		Effect.gen(function* () {
			let status = 400;
			yield* platformApi((call) =>
				JSON.parse(call.body).to_number === '' ? answer(call) : json({ error: 'no' }, status)
			);
			const h = yield* connected(agentphone, settings);
			const refused = yield* Effect.flip(required(h.link.send)({ to: person, text: 'Hello' }, []));
			expect(refused).toMatchObject({ _tag: 'ProviderRefused', permanent: true });
			status = 503;
			const down = yield* Effect.flip(required(h.link.send)({ to: person, text: 'Hello' }, []));
			expect(down).toMatchObject({ _tag: 'ProviderUnavailable', status: 503 });
		})
	);
	it.live('proving a connection delivers nothing', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			yield* connected(agentphone, settings);
			expect(api.calls.map((call) => JSON.parse(call.body).to_number)).toEqual(['']);
		})
	);
	it.live('a key or an agent AgentPhone refuses keeps nothing', () =>
		Effect.gen(function* () {
			for (const status of [401, 403, 404]) {
				yield* platformApi(() => json({ detail: 'no' }, status));
				const h = yield* host(chatProvider(agentphone), fetch);
				yield* Effect.flip(required(h.link.pair)(settings));
				expect(h.values.size).toBe(0);
			}
		})
	);
});
