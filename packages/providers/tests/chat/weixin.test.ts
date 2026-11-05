// Weixin: the real adapter's long poll through the real provider. iLink is faked behind `fetch` here rather than through
// the kit's `platformApi`, because a long poll has to hold until it is answered or aborted.
import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider } from '../../src/chat/adapter.ts';
import { weixin } from '../../src/chat/weixin/index.ts';
import { host, until } from '../kit.ts';
import { connected, json, webhook, type Call } from './kit.ts';

const settings = { accountId: 'bot@im', token: 'token' };
const BASE = 'https://ilinkai.weixin.qq.com/ilink/bot';
const idle = () => json({ ret: 0, msgs: [] });
/** iLink: each poll takes the next answer, then holds; `other` answers everything else. */
const ilink = (polls: (() => Response)[], other: (call: Call) => Response = () => json({ ret: 0 })) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const real = globalThis.fetch,
				calls: Call[] = [];
			globalThis.fetch = async (input, init) => {
				const request = new Request(input, init);
				const call = { url: request.url, headers: request.headers, body: await request.text() };
				calls.push(call);
				if (!request.url.endsWith('/getupdates')) return other(call);
				const next = polls.shift();
				if (next !== undefined) return next();
				return new Promise<Response>((_, reject) => {
					const signal = init?.signal;
					if (signal?.aborted === true) reject(signal.reason);
					signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
				});
			};
			return {
				real,
				calls,
				cursors: () =>
					calls
						.filter((call) => call.url.endsWith('/getupdates'))
						.map((call) => JSON.parse(call.body).get_updates_buf)
			};
		}),
		({ real }) =>
			Effect.sync(() => {
				globalThis.fetch = real;
			})
	);
const message = (id: number, extra: object = {}) => ({
	message_id: id,
	from_user_id: 'wx-user',
	to_user_id: 'bot@im',
	create_time_ms: 1_790_000_000_000,
	message_type: 1,
	item_list: [{ type: 1, text_item: { text: '你好' } }],
	...extra
});
const batch = (cursor: string, ...msgs: object[]) => () =>
	json({ ret: 0, msgs, get_updates_buf: cursor });

describe('Weixin', () => {
	it.live('stores a batch, skips the bot’s own, and polls on from the new cursor', () =>
		Effect.gen(function* () {
			const api = yield* ilink([
				idle,
				batch('c1', message(1), message(2, { message_type: 2 }))
			]);
			const h = yield* connected(weixin, settings);
			expect(h.status).toMatchObject({ state: 'connected', account: 'bot@im' });
			yield* until(() => api.cursors().length === 3);
			expect(api.cursors()).toEqual(['', '', 'c1']);
			expect(h.events).toEqual([
				{
					kind: 'messages',
					messages: [
						{
							id: '1',
							thread: 'wx-user',
							sentAt: '2026-09-21T14:13:20.000Z',
							from: { handle: 'wx-user', name: null },
							text: '你好',
							group: false,
							replyTo: null,
							attachments: [],
							invocation: 'direct'
						}
					]
				}
			]);
			const poll = api.calls[1];
			expect(poll?.url).toBe(`${BASE}/getupdates`);
			expect(poll?.headers.get('authorization')).toBe('Bearer token');
			expect(poll?.headers.get('authorizationtype')).toBe('ilink_bot_token');
			yield* h.link.close!;
		})
	);
	it.live('stores what the proving poll brought', () =>
		Effect.gen(function* () {
			const api = yield* ilink([batch('c1', message(1))]);
			const h = yield* connected(weixin, settings);
			yield* until(() => api.cursors().length === 2);
			expect(api.cursors()).toEqual(['', 'c1']);
			expect(h.events).toMatchObject([{ messages: [{ id: '1' }] }]);
			yield* h.link.close!;
		})
	);
	it.live('a batch the engine refused moves no cursor, and comes again', () =>
		Effect.gen(function* () {
			const api = yield* ilink([idle, batch('c1', message(1)), batch('c1', message(1))]);
			let refused = 0;
			const h = yield* connected(weixin, settings, {
				emit: () => (++refused === 1 ? Promise.reject(new Error('refused')) : Promise.resolve())
			});
			yield* until(() => api.cursors().length === 4);
			expect(api.cursors()).toEqual(['', '', '', 'c1']);
			expect(h.events).toMatchObject([{ messages: [{ id: '1' }] }]);
			yield* h.link.close!;
		})
	);
	it.live('backs off a failed poll and carries on', () =>
		Effect.gen(function* () {
			const api = yield* ilink([
				idle,
				() => json({ ret: -1, errmsg: 'busy' }),
				batch('c1', message(1))
			]);
			const h = yield* connected(weixin, settings);
			yield* until(() => api.cursors().length === 4);
			expect(h.events).toMatchObject([{ messages: [{ id: '1' }] }]);
			yield* h.link.close!;
		})
	);
	it.live('a poll that holds proves the token, and close ends it at once', () =>
		Effect.gen(function* () {
			const api = yield* ilink([]);
			const h = yield* connected(weixin, settings);
			expect(h.status).toMatchObject({ state: 'connected' });
			yield* until(() => api.cursors().length === 2);
			yield* h.link.close!;
			const polled = api.calls.length;
			yield* Effect.promise(() => new Promise((done) => setTimeout(done, 0)));
			expect(api.calls.length).toBe(polled);
		})
	);
	it.live('decrypts a file and takes a voice transcript as text', () =>
		Effect.gen(function* () {
			const aes = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
			const cipher = createCipheriv('aes-128-ecb', aes, null);
			const sealed = Buffer.concat([cipher.update('bytes'), cipher.final()]);
			const url = 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=q%2B1';
			const api = yield* ilink(
				[
					idle,
					batch(
						'c1',
						message(1, {
							item_list: [
								{
									type: 4,
									file_item: {
										media: { encrypt_query_param: 'q+1', aes_key: aes.toString('base64') },
										file_name: 'a.pdf',
										len: '5'
									}
								}
							]
						}),
						message(2, {
							item_list: [{ type: 3, voice_item: { media: {}, text: '说的话' } }]
						})
					)
				],
				(call) => (call.url === url ? new Response(sealed) : json({ ret: 0 }))
			);
			const h = yield* connected(weixin, settings);
			yield* until(() => api.cursors().length === 3);
			expect(h.events[0]).toMatchObject({
				messages: [
					{
						attachments: [{ name: 'a.pdf', mime: 'application/octet-stream', bytes: 5, bin: 0 }]
					}
				],
				bins: [new Uint8Array(Buffer.from('bytes'))]
			});
			expect(h.events[1]).toMatchObject({ messages: [{ id: '2', text: '说的话', attachments: [] }] });
			yield* h.link.close!;
		})
	);
	it.live('sends a finished bot message', () =>
		Effect.gen(function* () {
			const api = yield* ilink([idle]);
			const h = yield* connected(weixin, settings);
			const sent = yield* h.link.send!({ to: 'wx-user', text: 'Hello' }, []);
			const call = api.calls.at(-1);
			expect(call?.url).toBe(`${BASE}/sendmessage`);
			const { msg } = JSON.parse(call?.body ?? '');
			expect(msg).toEqual({
				from_user_id: '',
				to_user_id: 'wx-user',
				client_id: sent.providerId,
				message_type: 2,
				message_state: 2,
				item_list: [{ type: 1, text_item: { text: 'Hello' } }]
			});
			yield* h.link.close!;
		})
	);
	it.live('a reply carries the context of the person it answers', () =>
		Effect.gen(function* () {
			const api = yield* ilink([batch('c1', message(1, { context_token: 'ctx-1' })), idle]);
			const h = yield* connected(weixin, settings);
			yield* until(() => h.events.length > 0);
			yield* h.link.send!({ id: 'm1', to: 'wx-user', text: 'Hello' }, []);
			const sent = api.calls.findLast((call) => call.url.endsWith('/sendmessage'));
			const { msg } = JSON.parse(sent?.body ?? '');
			expect(msg).toMatchObject({ context_token: 'ctx-1', client_id: 'm1' });
			yield* h.link.close!;
		})
	);
	it.live('a send iLink refuses with a 200 fails', () =>
		Effect.gen(function* () {
			yield* ilink([idle], () => json({ ret: -2, errmsg: 'no' }));
			const h = yield* connected(weixin, settings);
			yield* Effect.flip(h.link.send!({ to: 'wx-user', text: 'Hello' }, []));
			yield* h.link.close!;
		})
	);
	it.live('refuses a webhook: everything arrives over the poll', () =>
		Effect.gen(function* () {
			yield* ilink([idle]);
			const h = yield* connected(weixin, settings);
			expect((yield* h.link.webhook!(webhook('{}', {}))).status).toBe(401);
			yield* h.link.close!;
		})
	);
	it.live('a token iLink refuses keeps nothing and leaves no poll behind', () =>
		Effect.gen(function* () {
			const api = yield* ilink([() => json({ ret: -14, errmsg: 'session expired' })]);
			const h = yield* host(chatProvider(weixin), fetch);
			yield* Effect.flip(h.link.pair!(settings));
			expect(h.values.size).toBe(0);
			expect(api.calls.length).toBe(1);
		})
	);
});
