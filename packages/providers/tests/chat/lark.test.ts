// Lark: its real SDK and normalizer, events sealed and signed the way Lark does. The SDK reaches the network through
// axios, so the seam is that one axios instance's adapter, forwarded to the `fetch` the platform is faked behind.
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider } from '../../src/chat/adapter.ts';
import { lark } from '../../src/chat/lark/index.ts';
import { host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const settings = {
	appId: 'cli_a',
	appSecret: 'secret',
	encryptKey: 'encrypt-key',
	verificationToken: 'verify'
};
const sdk = () => Effect.promise(() => import('@larksuiteoapi/node-sdk'));
/** The SDK's HTTP over `fetch`: what a test fakes. */
const overFetch = Effect.gen(function* () {
	const { defaultHttpInstance } = yield* sdk();
	return yield* Effect.acquireRelease(
		Effect.sync(() => {
			const real = defaultHttpInstance.defaults.adapter;
			defaultHttpInstance.defaults.adapter = async (config) => {
				const response = await fetch(defaultHttpInstance.getUri(config), {
					method: config.method ?? 'get',
					headers: { authorization: String(config.headers.get('authorization') ?? '') },
					...(config.data === undefined || config.method === 'get'
						? {}
						: { body: String(config.data) })
				});
				if (!response.ok)
					throw Object.assign(new Error('refused'), { response: { status: response.status } });
				return {
					data:
						config.responseType === 'stream'
							? Readable.from([Buffer.from(await response.arrayBuffer())])
							: await response.json(),
					status: response.status,
					statusText: '',
					headers: {},
					config
				};
			};
			return real;
		}),
		(real) =>
			Effect.sync(() => {
				if (real !== undefined) defaultHttpInstance.defaults.adapter = real;
			})
	);
});
const answer = ({ url }: Call) => {
	if (url.includes('/tenant_access_token/internal'))
		return json({ code: 0, tenant_access_token: 't-1', expire: 7200 });
	if (url.endsWith('/open-apis/bot/v3/info'))
		return json({ code: 0, bot: { open_id: 'ou_bot', app_name: 'Acme' } });
	if (url.endsWith('/messages/om_parent'))
		return json({ code: 0, data: { items: [{ sender: { id: 'cli_a', id_type: 'app_id' } }] } });
	if (url.includes('/resources/')) return new Response(new Uint8Array([4, 5]));
	if (url.includes('/open-apis/im/v1/messages') || url.includes('/reply'))
		return json({ code: 0, data: { message_id: 'om_out' } });
	return json({ code: 0 });
};
const seal = (plain: object) => {
	const iv = randomBytes(16);
	const cipher = createCipheriv(
		'aes-256-cbc',
		createHash('sha256').update(settings.encryptKey).digest(),
		iv
	);
	return JSON.stringify({
		encrypt: Buffer.concat([iv, cipher.update(JSON.stringify(plain)), cipher.final()]).toString(
			'base64'
		)
	});
};
const signature = (body: string, key = settings.encryptKey) => ({
	'x-lark-request-timestamp': '1790000000',
	'x-lark-request-nonce': 'n1',
	'x-lark-signature': createHash('sha256').update(`1790000000n1${key}${body}`).digest('hex')
});
const received = (message: object = {}, sender: object = {}) =>
	seal({
		schema: '2.0',
		header: { event_id: 'e1', event_type: 'im.message.receive_v1', token: 'verify' },
		event: {
			sender: { sender_id: { open_id: 'ou_ann' }, sender_type: 'user', ...sender },
			message: {
				message_id: 'om_1',
				create_time: '1790000000000',
				chat_id: 'oc_1',
				chat_type: 'p2p',
				message_type: 'text',
				content: JSON.stringify({ text: '你好' }),
				...message
			}
		}
	});

describe('Lark', () => {
	it.live('stores a signed message with exact fields', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			yield* overFetch;
			const h = yield* connected(lark, settings),
				body = received();
			expect(h.status).toMatchObject({ state: 'connected', account: 'Acme' });
			expect((yield* h.link.webhook!(webhook(body, signature(body)))).status).toBe(200);
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				messages: [
					{
						id: 'om_1',
						thread: 'oc_1',
						sentAt: new Date(1_790_000_000_000).toISOString(),
						from: { handle: 'ou_ann' },
						text: '你好',
						group: false,
						invocation: 'direct'
					}
				]
			});
		})
	);
	it.live('answers the URL challenge only with the right token', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			yield* overFetch;
			const h = yield* connected(lark, settings);
			const good = seal({ type: 'url_verification', token: 'verify', challenge: 'c1' });
			const response = yield* h.link.webhook!(webhook(good, {}));
			expect(yield* Effect.promise(() => response.json())).toEqual({ challenge: 'c1' });
			const bad = seal({ type: 'url_verification', token: 'nope', challenge: 'c1' });
			expect((yield* h.link.webhook!(webhook(bad, {}))).status).toBe(401);
		})
	);
	it.live('refuses a bad signature, a missing one and a plain body, and stores nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			yield* overFetch;
			const h = yield* connected(lark, settings),
				body = received();
			expect((yield* h.link.webhook!(webhook(body, signature(body, 'wrong')))).status).toBe(401);
			expect((yield* h.link.webhook!(webhook(body, {}))).status).toBe(401);
			const plain = JSON.stringify({ type: 'url_verification', challenge: 'c1' });
			expect((yield* h.link.webhook!(webhook(plain, signature(plain)))).status).toBe(401);
			const sealedWithAnother = JSON.stringify({ encrypt: Buffer.alloc(48, 1).toString('base64') });
			expect((yield* h.link.webhook!(webhook(sealedWithAnother, {}))).status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a message the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			yield* overFetch;
			const h = yield* connected(lark, settings, {
					emit: () => Promise.reject(new Error('the store refused'))
				}),
				body = received();
			expect((yield* h.link.webhook!(webhook(body, signature(body)))).status).toBe(500);
		})
	);
	it.live(
		'a group mention in a thread, a reply to the bot, a file, a recall, and its own message',
		() =>
			Effect.gen(function* () {
				yield* platformApi(answer);
				yield* overFetch;
				const h = yield* connected(lark, settings);
				const mention = received({
					message_id: 'om_2',
					chat_type: 'group',
					root_id: 'om_root',
					parent_id: 'om_root',
					thread_id: 'omt_1',
					content: JSON.stringify({ text: '@_user_1 hi' }),
					mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Acme' }]
				});
				const reply = received({ message_id: 'om_3', chat_type: 'group', parent_id: 'om_parent' });
				const file = received({
					message_id: 'om_4',
					message_type: 'file',
					content: JSON.stringify({ file_key: 'f1', file_name: 'a.pdf' })
				});
				const recall = seal({
					schema: '2.0',
					header: { event_id: 'e2', event_type: 'im.message.recalled_v1' },
					event: { message_id: 'om_1', chat_id: 'oc_1' }
				});
				const own = received({ message_id: 'om_5' }, { sender_type: 'app' });
				for (const body of [mention, reply, file, recall, own])
					expect((yield* h.link.webhook!(webhook(body, signature(body)))).status).toBe(200);
				expect(h.events.length).toBe(4);
				expect(h.events).toMatchObject([
					{
						messages: [
							{
								id: 'om_2',
								thread: 'oc_1:om_root:omt_1',
								text: 'hi',
								group: true,
								invocation: 'mention',
								replyTo: 'om_root'
							}
						]
					},
					{ messages: [{ id: 'om_3', invocation: 'reply', replyTo: 'om_parent' }] },
					{
						bins: [new Uint8Array([4, 5])],
						messages: [{ id: 'om_4', attachments: [{ name: 'a.pdf', bin: 0 }] }]
					},
					{ messages: [{ id: 'om_1', deleted: true, thread: '' }] }
				]);
			})
	);
	it.live('sends with a bounded uuid, into a chat, a person and a thread', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			yield* overFetch;
			const h = yield* connected(lark, settings);
			const key = 'k'.repeat(200);
			const sent = yield* h.link.send!({ id: key, to: 'oc_1', text: 'Hello' }, []);
			expect(sent).toMatchObject({ providerId: 'om_out' });
			const chat = api.calls.at(-1);
			expect(new URL(chat?.url ?? '').searchParams.get('receive_id_type')).toBe('chat_id');
			const body = JSON.parse(chat?.body ?? '') as { uuid: string };
			expect(body).toMatchObject({
				receive_id: 'oc_1',
				msg_type: 'text',
				content: JSON.stringify({ text: 'Hello' })
			});
			expect(body.uuid).toBe(createHash('sha256').update(key).digest('hex').slice(0, 50));
			expect(chat?.headers.get('authorization')).toBe('Bearer t-1');
			yield* h.link.send!({ id: 'k2', to: 'ou_ann', text: 'Hi' }, []);
			expect(new URL(api.calls.at(-1)?.url ?? '').searchParams.get('receive_id_type')).toBe(
				'open_id'
			);
			yield* h.link.send!({ id: 'k3', to: 'oc_1:om_root:omt_1', text: 'In thread' }, []);
			expect(new URL(api.calls.at(-1)?.url ?? '').pathname).toBe(
				'/open-apis/im/v1/messages/om_root/reply'
			);
			expect(JSON.parse(api.calls.at(-1)?.body ?? '')).toMatchObject({ reply_in_thread: true });
		})
	);
	it.live('a secret Lark refuses keeps nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ code: 10014, msg: 'app secret invalid' }, 400));
			yield* overFetch;
			const h = yield* host(chatProvider(lark), fetch);
			yield* Effect.flip(h.link.pair!({ ...settings, appId: 'cli_refused' }));
			expect(h.values.size).toBe(0);
		})
	);
	it.live('history reads a chat from a time, with its edits and recalls', () =>
		Effect.gen(function* () {
			const item = (extra: object) => ({
				message_id: 'om_1',
				msg_type: 'text',
				create_time: '1790000000000',
				chat_id: 'oc_1',
				sender: { id: 'ou_ann', id_type: 'open_id', sender_type: 'user' },
				body: { content: JSON.stringify({ text: 'hi' }) },
				...extra
			});
			const api = yield* platformApi((call) => {
				if (call.url.includes('/im/v1/chats/oc_1'))
					return json({ code: 0, data: { chat_mode: 'group' } });
				if (call.url.includes('/im/v1/messages?'))
					return json({
						code: 0,
						data: {
							has_more: false,
							items: [
								item({}),
								item({ message_id: 'om_2', updated: true, update_time: '1790000009000' }),
								item({ message_id: 'om_3', deleted: true }),
								item({
									message_id: 'om_4',
									sender: { id: 'cli_a', id_type: 'app_id', sender_type: 'app' }
								})
							]
						}
					});
				return answer(call);
			});
			yield* overFetch;
			const connection = yield* Effect.promise(() =>
				lark.connect(settings, {
					fetch,
					webhookUrl: 'https://hook.test/',
					receive: () => Promise.resolve()
				})
			);
			const read = yield* Effect.promise(() =>
				connection.history!('oc_1', '2026-09-20T00:00:00.000Z')
			);
			expect(read.complete).toBe(true);
			expect(read.messages).toMatchObject([
				{ id: 'om_1', group: true, text: 'hi' },
				{ id: 'om_2', version: new Date(1_790_000_009_000).toISOString() },
				{ id: 'om_3', deleted: true, text: '' }
			]);
			expect(read.messages.length).toBe(3);
			const url = new URL(api.calls.at(-1)?.url ?? '');
			expect(url.searchParams.get('container_id_type')).toBe('chat');
			expect(url.searchParams.get('container_id')).toBe('oc_1');
			expect(url.searchParams.get('start_time')).toBe(
				String(Date.parse('2026-09-20T00:00:00.000Z') / 1000)
			);
		})
	);
});
