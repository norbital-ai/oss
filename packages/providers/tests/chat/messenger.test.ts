// Messenger: deliveries signed as Meta signs them, through the real provider, with the Graph API faked behind `fetch`.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider } from '../../src/chat/adapter.ts';
import { messenger } from '../../src/chat/messenger/index.ts';
import { host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const settings = { pageAccessToken: 'token', appSecret: 'secret', verifyToken: 'verify' };
const PHOTO = 'https://scontent.xx.fbcdn.net/v/t1/photo.jpg?sig=x';
const answer = (call: Call) =>
	call.url.includes('/me/messages')
		? json({ recipient_id: 'U1', message_id: 'out1' })
		: call.url.includes('/v21.0/me?')
			? json({ id: 'P1', name: 'Acme' })
			: call.url === PHOTO
				? new Response(new Uint8Array([1, 2, 3]))
				: json({});
const hook = (message: object) =>
	JSON.stringify({
		object: 'page',
		entry: [
			{
				id: 'P1',
				time: 1_790_000_000_000,
				messaging: [
					{
						sender: { id: 'U1' },
						recipient: { id: 'P1' },
						timestamp: 1_790_000_000_000,
						message
					}
				]
			}
		]
	});
const signature = (body: string) => ({
	'x-hub-signature-256': `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`
});
const handshake = (token: string) =>
	new Request(
		`https://hook.test/?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=1158201444`
	);

describe('Messenger', () => {
	it.live('stores a signed message before acknowledging it', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(messenger, settings),
				body = hook({ mid: 'm1', text: 'hello' });
			expect(h.status).toMatchObject({ state: 'connected', account: 'Acme' });
			expect((yield* h.link.webhook!(webhook(body, signature(body)))).status).toBe(200);
			expect(h.events).toEqual([
				{
					kind: 'messages',
					messages: [
						{
							id: 'm1',
							thread: 'U1',
							sentAt: '2026-09-21T14:13:20.000Z',
							from: { handle: 'U1', name: null },
							text: 'hello',
							group: false,
							replyTo: null,
							attachments: [],
							invocation: 'direct'
						}
					]
				}
			]);
		})
	);
	it.live('answers Meta’s handshake only with the verify token', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(messenger, settings);
			const good = yield* h.link.webhook!(handshake('verify'));
			expect(good.status).toBe(200);
			expect(yield* Effect.promise(() => good.text())).toBe('1158201444');
			expect((yield* h.link.webhook!(handshake('wrong'))).status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('refuses a bad signature and stores nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(messenger, settings),
				body = hook({ mid: 'm1', text: 'hello' });
			const forged = yield* h.link.webhook!(
				webhook(body, { 'x-hub-signature-256': 'sha256=forged' })
			);
			expect(forged.status).toBe(401);
			expect((yield* h.link.webhook!(webhook(body, {}))).status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a message the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(messenger, settings, {
					emit: () => Promise.reject(new Error('the store refused'))
				}),
				body = hook({ mid: 'm1', text: 'hello' });
			expect((yield* h.link.webhook!(webhook(body, signature(body)))).status).toBe(500);
		})
	);
	it.live('skips the page’s own echoes and reads a message’s file', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(messenger, settings);
			const echo = hook({ mid: 'm0', text: 'mine', is_echo: true }),
				photo = hook({ mid: 'm2', attachments: [{ type: 'image', payload: { url: PHOTO } }] });
			yield* h.link.webhook!(webhook(echo, signature(echo)));
			yield* h.link.webhook!(webhook(photo, signature(photo)));
			expect(h.events).toEqual([
				expect.objectContaining({
					messages: [
						expect.objectContaining({
							id: 'm2',
							attachments: [{ name: 'photo.jpg', mime: 'image/*', bytes: 3, bin: 0 }]
						})
					],
					bins: [new Uint8Array([1, 2, 3])]
				})
			]);
		})
	);
	it.live('sends through the Send API, a long text in pieces', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(messenger, settings);
			const sent = yield* h.link.send!({ to: 'U1', text: 'Hello' }, []);
			expect(sent).toMatchObject({ providerId: 'out1' });
			const call = api.calls.at(-1);
			expect(call?.url).toBe('https://graph.facebook.com/v21.0/me/messages?access_token=token');
			expect(JSON.parse(call?.body ?? '')).toEqual({
				recipient: { id: 'U1' },
				message: { text: 'Hello' },
				messaging_type: 'RESPONSE'
			});
			const before = api.calls.length;
			yield* h.link.send!({ to: 'U1', text: 'a'.repeat(2001) }, []);
			expect(
				api.calls.slice(before).map((one) => JSON.parse(one.body).message.text.length)
			).toEqual([2000, 1]);
		})
	);
	it.live('shows typing, and keeps a rate limit retryable under any status', () =>
		Effect.gen(function* () {
			let limited = false;
			const api = yield* platformApi((call) =>
				limited ? json({ error: { message: 'limit', code: 613 } }, 400) : answer(call)
			);
			const h = yield* connected(messenger, settings);
			yield* h.link.typing!('U1', true);
			expect(JSON.parse(api.calls.at(-1)?.body ?? '')).toEqual({
				recipient: { id: 'U1' },
				sender_action: 'typing_on'
			});
			limited = true;
			const failed = yield* Effect.flip(h.link.send!({ to: 'U1', text: 'Hello' }, []));
			expect(failed).toMatchObject({ _tag: 'ProviderUnavailable', status: 429 });
		})
	);
	it.live('a token Meta refuses keeps nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ error: { message: 'Invalid token', code: 190 } }, 400));
			const h = yield* host(chatProvider(messenger), fetch);
			yield* Effect.flip(h.link.pair!(settings));
			expect(h.values.size).toBe(0);
		})
	);
});
