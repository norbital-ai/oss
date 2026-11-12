// Instagram: deliveries signed as Meta signs them, through the real provider, with its API faked behind `fetch`.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider } from '../../src/chat/adapter.ts';
import { instagram } from '../../src/chat/instagram/index.ts';
import { required, host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const settings = {
	accessToken: 'token',
	appSecret: 'secret',
	verifyToken: 'verify',
	accountId: 'A1'
};
const answer = (call: Call) =>
	call.url.endsWith('/A1/messages')
		? json({ recipient_id: 'U1', message_id: 'out1' })
		: call.url.includes('/v26.0/A1?')
			? json({ id: 'A1', username: 'acme' })
			: json({});
const hook = (message: object) =>
	JSON.stringify({
		object: 'instagram',
		entry: [
			{
				id: 'A1',
				time: 1_790_000_000_000,
				messaging: [
					{
						sender: { id: 'U1' },
						recipient: { id: 'A1' },
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

describe('Instagram', () => {
	it.live('stores a signed message with what it replies to', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(instagram, settings),
				body = hook({ mid: 'm1', text: 'hello', reply_to: { mid: 'm0' } });
			expect(h.status).toMatchObject({ state: 'connected', account: 'acme' });
			expect(api.calls[0]?.headers.get('authorization')).toBe('Bearer token');
			expect((yield* required(h.link.webhook)(webhook(body, signature(body)))).status).toBe(200);
			expect(h.events).toEqual([
				{
					kind: 'messages',
					messages: [
						{
							id: 'm1',
							thread: 'U1',
							sent_at: '2026-09-21T14:13:20.000Z',
							from: { handle: 'U1', name: null },
							text: 'hello',
							group: false,
							reply_to: 'm0',
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
			const h = yield* connected(instagram, settings);
			const query = (token: string) =>
				new Request(
					`https://hook.test/?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=42`
				);
			const good = yield* required(h.link.webhook)(query('verify'));
			expect(yield* Effect.promise(() => good.text())).toBe('42');
			expect((yield* required(h.link.webhook)(query('wrong'))).status).toBe(401);
		})
	);
	it.live('refuses a bad signature and stores nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(instagram, settings),
				body = hook({ mid: 'm1', text: 'hello' });
			const forged = yield* required(h.link.webhook)(
				webhook(body, { 'x-hub-signature-256': 'sha256=forged' })
			);
			expect(forged.status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a message the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(instagram, settings, {
					emit: () => Promise.reject(new Error('the store refused'))
				}),
				body = hook({ mid: 'm1', text: 'hello' });
			expect((yield* required(h.link.webhook)(webhook(body, signature(body)))).status).toBe(500);
		})
	);
	it.live('a deleted message is a delete, an echo and an unsupported one are nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(instagram, settings);
			for (const body of [
				hook({ mid: 'm1', is_deleted: true }),
				hook({ mid: 'm2', text: 'mine', is_echo: true }),
				hook({ mid: 'm3', is_unsupported: true })
			])
				yield* required(h.link.webhook)(webhook(body, signature(body)));
			expect(h.events).toEqual([
				{
					kind: 'messages',
					messages: [expect.objectContaining({ id: 'm1', text: '', deleted: true })]
				}
			]);
		})
	);
	it.live('sends from the account, a long text in pieces by bytes', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(instagram, settings);
			expect(yield* required(h.link.send)({ to: 'U1', text: 'Hello' }, [])).toMatchObject({
				provider_id: 'out1'
			});
			const call = api.calls.at(-1);
			expect(call?.url).toBe('https://graph.instagram.com/v26.0/A1/messages');
			expect(JSON.parse(call?.body ?? '')).toEqual({
				recipient: { id: 'U1' },
				message: { text: 'Hello' },
				messaging_type: 'RESPONSE'
			});
			const before = api.calls.length;
			yield* required(h.link.send)({ to: 'U1', text: '你'.repeat(334) }, []);
			expect(
				api.calls.slice(before).map((one) => JSON.parse(one.body).message.text.length)
			).toEqual([333, 1]);
		})
	);
	it.live('a token Instagram refuses keeps nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ error: { message: 'Invalid token', code: 190 } }, 400));
			const h = yield* host(chatProvider(instagram), fetch);
			yield* Effect.flip(required(h.link.pair)(settings));
			expect(h.values.size).toBe(0);
		})
	);
});
