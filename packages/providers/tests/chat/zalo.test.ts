// Zalo: deliveries with its secret header, through the real provider, with the Bot API faked behind `fetch`.
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider } from '../../src/chat/adapter.ts';
import { zalo } from '../../src/chat/zalo/index.ts';
import { host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const settings = { botToken: '123:abc', webhookSecret: 'secret' };
const BASE = 'https://bot-api.zaloplatforms.com/bot123:abc';
const PHOTO = 'https://f1.zdn.vn/photo.jpg';
const answer = (call: Call) =>
	call.url === `${BASE}/getMe`
		? json({ ok: true, result: { id: 'B1', account_name: 'acme_bot' } })
		: call.url === `${BASE}/sendMessage`
			? json({ ok: true, result: { message_id: 'out1', date: 1_790_000_000_000 } })
			: call.url === PHOTO
				? new Response(new Uint8Array([1, 2, 3]))
				: json({ ok: true, result: true });
const message = (extra: object = {}) => ({
	message_id: 'm1',
	date: 1_790_000_000_000,
	chat: { id: 'C1', chat_type: 'PRIVATE' },
	from: { id: 'U1', display_name: 'Lan', is_bot: false },
	text: 'xin chào',
	...extra
});
const hook = (extra: object = {}) =>
	JSON.stringify({ event_name: 'message.text.received', message: message(extra) });
const secret = { 'x-bot-api-secret-token': 'secret' };

describe('Zalo', () => {
	it.live('stores a message with the right secret', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(zalo, settings);
			expect(h.status).toMatchObject({ state: 'connected', account: 'acme_bot' });
			expect((yield* h.link.webhook!(webhook(hook(), secret))).status).toBe(200);
			expect(h.events).toEqual([
				{
					kind: 'messages',
					messages: [
						{
							id: 'm1',
							thread: 'C1',
							sentAt: '2026-09-21T14:13:20.000Z',
							from: { handle: 'U1', name: 'Lan' },
							text: 'xin chào',
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
	it.live('reads an event under `result`, a group, and a photo with its caption', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(zalo, settings);
			const group = JSON.stringify({
				ok: true,
				result: {
					event_name: 'message.image.received',
					message: message({
						text: undefined,
						photo: PHOTO,
						caption: 'look',
						chat: { id: 'G1', chat_type: 'GROUP' }
					})
				}
			});
			yield* h.link.webhook!(webhook(group, secret));
			expect(h.events[0]).toMatchObject({
				messages: [
					{
						thread: 'G1',
						text: 'look',
						group: true,
						invocation: 'ambient',
						attachments: [{ name: 'zalo-m1', mime: 'image/*', bytes: 3, bin: 0 }]
					}
				],
				bins: [new Uint8Array([1, 2, 3])]
			});
		})
	);
	it.live('refuses a wrong secret and stores nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(zalo, settings);
			const forged = yield* h.link.webhook!(
				webhook(hook(), { 'x-bot-api-secret-token': 'forged' })
			);
			expect(forged.status).toBe(401);
			expect((yield* h.link.webhook!(webhook(hook(), {}))).status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a message the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(zalo, settings, {
				emit: () => Promise.reject(new Error('the store refused'))
			});
			expect((yield* h.link.webhook!(webhook(hook(), secret))).status).toBe(500);
		})
	);
	it.live('skips its own message, a sticker and an event with no message', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(zalo, settings);
			for (const body of [
				hook({ from: { id: 'B1', display_name: 'Bot', is_bot: true } }),
				hook({ text: undefined, sticker: 'S1' }),
				JSON.stringify({ event_name: 'message.unsupported.received' })
			])
				expect((yield* h.link.webhook!(webhook(body, secret))).status).toBe(200);
			expect(h.events).toEqual([]);
		})
	);
	it.live('sends, a long text in pieces, and shows typing', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(zalo, settings);
			expect(yield* h.link.send!({ to: 'C1', text: 'Hello' }, [])).toMatchObject({
				providerId: 'out1'
			});
			const call = api.calls.at(-1);
			expect(call?.url).toBe(`${BASE}/sendMessage`);
			expect(JSON.parse(call?.body ?? '')).toEqual({ chat_id: 'C1', text: 'Hello' });
			const before = api.calls.length;
			yield* h.link.send!({ to: 'C1', text: 'a'.repeat(2001) }, []);
			expect(api.calls.slice(before).map((one) => JSON.parse(one.body).text.length)).toEqual([
				2000, 1
			]);
			yield* h.link.typing!('C1', true);
			expect(api.calls.at(-1)?.url).toBe(`${BASE}/sendChatAction`);
			expect(JSON.parse(api.calls.at(-1)?.body ?? '')).toEqual({
				chat_id: 'C1',
				action: 'typing'
			});
		})
	);
	it.live('a token Zalo refuses keeps nothing, even with a 200', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ ok: false, error_code: 401, description: 'Unauthorized' }));
			const h = yield* host(chatProvider(zalo), fetch);
			yield* Effect.flip(h.link.pair!(settings));
			expect(h.values.size).toBe(0);
		})
	);
});
