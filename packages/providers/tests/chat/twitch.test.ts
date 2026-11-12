// Twitch: EventSub's signed notifications, its verification handshake, and Helix behind `fetch`.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider } from '../../src/chat/adapter.ts';
import { twitch } from '../../src/chat/twitch/index.ts';
import { required, host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const settings = {
	clientId: 'client',
	clientSecret: 'secret',
	webhookSecret: 'webhook-secret',
	botUsername: 'norbot',
	userAccessToken: 'user-token'
};
const answer = (call: Call) =>
	call.url.endsWith('/oauth2/token')
		? json({ access_token: 'app-token', expires_in: 3600 })
		: call.url.includes('/helix/users')
			? json({ data: [{ id: '9', login: 'norbot' }] })
			: call.url.includes('/helix/chat/messages')
				? json({ data: [{ message_id: 'out1', is_sent: true }] })
				: call.url.includes('/helix/whispers')
					? new Response(null, { status: 204 })
					: json({});
// Twitch stamps nanoseconds
const now = () => new Date().toISOString().replace('Z', '123456Z');
const headers = (body: string, type = 'notification', timestamp = now()) => ({
	'twitch-eventsub-message-id': 'delivery1',
	'twitch-eventsub-message-timestamp': timestamp,
	'twitch-eventsub-message-type': type,
	'twitch-eventsub-message-signature': `sha256=${createHmac('sha256', 'webhook-secret').update(`delivery1${timestamp}${body}`).digest('hex')}`
});
const chat = (extra: object = {}) =>
	JSON.stringify({
		subscription: { type: 'channel.chat.message' },
		event: {
			message_id: 'm1',
			broadcaster_user_id: '42',
			broadcaster_user_name: 'Streamer',
			chatter_user_id: '7',
			chatter_user_login: 'mei',
			chatter_user_name: 'Mei',
			message: { text: 'hello', fragments: [{ type: 'text', text: 'hello' }] },
			reply: null,
			...extra
		}
	});
const whisper = JSON.stringify({
	subscription: { type: 'user.whisper.message' },
	event: {
		whisper_id: 'w1',
		from_user_id: '7',
		from_user_login: 'mei',
		from_user_name: 'Mei',
		to_user_id: '9',
		whisper: { text: 'psst' }
	}
});

describe('Twitch', () => {
	it.live('stores a signed chat message before acknowledging it', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(twitch, settings),
				body = chat(),
				sent = headers(body);
			expect(h.status).toMatchObject({ state: 'connected', account: 'norbot' });
			expect((yield* required(h.link.webhook)(webhook(body, sent))).status).toBe(200);
			const at = sent['twitch-eventsub-message-timestamp'].replace('123456Z', 'Z');
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				messages: [
					{
						id: 'm1',
						thread: '42',
						text: 'hello',
						sent_at: at,
						from: { handle: '7', name: 'Mei' },
						title: 'Streamer',
						group: true,
						invocation: 'ambient'
					}
				]
			});
		})
	);
	it.live('reads a mention, a reply to the bot, and a whisper', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(twitch, settings);
			const mentioned = chat({
					message_id: 'm2',
					message: {
						text: '@norbot hi',
						fragments: [{ type: 'mention', mention: { user_id: '9' } }]
					}
				}),
				replied = chat({
					message_id: 'm3',
					reply: { parent_message_id: 'out1', parent_user_id: '9' }
				});
			yield* required(h.link.webhook)(webhook(mentioned, headers(mentioned)));
			yield* required(h.link.webhook)(webhook(replied, headers(replied)));
			yield* required(h.link.webhook)(webhook(whisper, headers(whisper)));
			expect(h.events[0]).toMatchObject({ messages: [{ invocation: 'mention' }] });
			expect(h.events[1]).toMatchObject({ messages: [{ invocation: 'reply', reply_to: 'out1' }] });
			expect(h.events[2]).toMatchObject({
				messages: [{ id: 'w1', thread: 'whisper:7', text: 'psst', invocation: 'direct' }]
			});
		})
	);
	it.live('ignores the bot own messages and a shared chat copy', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(twitch, settings),
				own = chat({ chatter_user_id: '9' }),
				copy = chat({ source_broadcaster_user_id: '43' });
			yield* required(h.link.webhook)(webhook(own, headers(own)));
			yield* required(h.link.webhook)(webhook(copy, headers(copy)));
			expect(h.events).toEqual([]);
		})
	);
	it.live('answers the verification handshake with the raw challenge', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(twitch, settings),
				body = JSON.stringify({ challenge: 'pogchamp', subscription: { type: 'channel.chat.message' } });
			const answered = yield* required(h.link.webhook)(
				webhook(body, headers(body, 'webhook_callback_verification'))
			);
			expect(yield* Effect.promise(() => answered.text())).toBe('pogchamp');
			expect(answered.headers.get('content-type')).toContain('text/plain');
		})
	);
	it.live('a revocation carries nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(twitch, settings),
				body = JSON.stringify({ subscription: { type: 'channel.chat.message', status: 'revoked' } });
			expect((yield* required(h.link.webhook)(webhook(body, headers(body, 'revocation')))).status).toBe(200);
			expect(h.events).toEqual([]);
		})
	);
	it.live('refuses a bad signature and a stale message', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(twitch, settings),
				body = chat();
			const forged = yield* required(h.link.webhook)(
				webhook(body, {
					...headers(body),
					'twitch-eventsub-message-signature': 'sha256=forged'
				})
			);
			expect(forged.status).toBe(401);
			const stale = new Date(Date.now() - 11 * 60 * 1000).toISOString();
			expect(
				(yield* required(h.link.webhook)(webhook(body, headers(body, 'notification', stale)))).status
			).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a message the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(twitch, settings, {
					emit: () => Promise.reject(new Error('the store refused'))
				}),
				body = chat();
			expect((yield* required(h.link.webhook)(webhook(body, headers(body)))).status).toBe(500);
		})
	);
	it.live('sends one clipped line to chat as the bot, on the app token', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(twitch, settings);
			expect(
				yield* required(h.link.send)({ to: '42', text: `line one\nline two ${'x'.repeat(600)}` }, [])
			).toMatchObject({ provider_id: 'out1' });
			const call = api.calls.at(-1),
				sent = JSON.parse(call?.body ?? '');
			expect(call?.url).toBe('https://api.twitch.tv/helix/chat/messages');
			expect(call?.headers.get('authorization')).toBe('Bearer app-token');
			expect(call?.headers.get('client-id')).toBe('client');
			expect(sent).toMatchObject({ broadcaster_id: '42', sender_id: '9' });
			expect(sent.message.startsWith('line one line two')).toBe(true);
			expect(sent.message).toHaveLength(500);
		})
	);
	it.live('a message Twitch dropped is a refusal', () =>
		Effect.gen(function* () {
			yield* platformApi((call) =>
				call.url.includes('/helix/chat/messages')
					? json({
							data: [
								{ message_id: '', is_sent: false, drop_reason: { message: 'followers only' } }
							]
						})
					: answer(call)
			);
			const h = yield* connected(twitch, settings);
			const failure = yield* Effect.flip(required(h.link.send)({ to: '42', text: 'hi' }, []));
			expect(failure.message).toContain('followers only');
		})
	);
	it.live('whispers on the user token', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(twitch, settings);
			expect(yield* required(h.link.send)({ id: 'k1', to: 'whisper:7', text: 'hi' }, [])).toMatchObject({
				provider_id: 'k1'
			});
			const call = api.calls.at(-1);
			expect(call?.url).toBe('https://api.twitch.tv/helix/whispers?from_user_id=9&to_user_id=7');
			expect(call?.headers.get('authorization')).toBe('Bearer user-token');
			expect(JSON.parse(call?.body ?? '')).toEqual({ message: 'hi' });
		})
	);
	it.live('a whisper without the user token is refused', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const { userAccessToken: _dropped, ...rest } = settings;
			const h = yield* connected(twitch, rest);
			const failure = yield* Effect.flip(required(h.link.send)({ to: 'whisper:7', text: 'hi' }, []));
			expect(failure.message).toContain('user token');
		})
	);
	it.live('mints a new app token when Twitch refuses the one it holds', () =>
		Effect.gen(function* () {
			let minted = 0,
				refused = false;
			const api = yield* platformApi((call) => {
				if (call.url.endsWith('/oauth2/token')) {
					minted += 1;
					return json({ access_token: `app-${minted}`, expires_in: 3600 });
				}
				if (call.url.includes('/helix/chat/messages') && !refused) {
					refused = true;
					return json({ message: 'expired' }, 401);
				}
				return answer(call);
			});
			const h = yield* connected(twitch, settings);
			yield* required(h.link.send)({ to: '42', text: 'hi' }, []);
			expect(minted).toBe(2);
			expect(api.calls.at(-1)?.headers.get('authorization')).toBe('Bearer app-2');
		})
	);
	it.live('a client Twitch refuses keeps nothing, and neither does an unknown bot', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ message: 'invalid client secret' }, 403));
			const h = yield* host(chatProvider(twitch), fetch);
			yield* Effect.flip(required(h.link.pair)(settings));
			expect(h.values.size).toBe(0);
		})
	);
	it.live('an EventSub secret out of Twitch range fails pairing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* host(chatProvider(twitch), fetch);
			yield* Effect.flip(required(h.link.pair)({ ...settings, webhookSecret: 'short' }));
			expect(h.values.size).toBe(0);
		})
	);
});
