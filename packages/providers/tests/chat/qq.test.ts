// QQ: events signed as QQ signs them (Ed25519, the key seeded by the app secret), through the real provider, with its API
// faked behind `fetch`.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { chatProvider } from '../../src/chat/adapter.ts';
import { qq } from '../../src/chat/qq/index.ts';
import { required, host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const settings = { appId: '1024', clientSecret: 'naOC0ocQE3shWLAf' };
const key = createPrivateKey({
	key: Buffer.concat([
		Buffer.from('302e020100300506032b657004220420', 'hex'),
		Buffer.from('naOC0ocQE3shWLAfnaOC0ocQE3shWLAf')
	]),
	format: 'der',
	type: 'pkcs8'
});
const answer = (call: Call) =>
	call.url.endsWith('/getAppAccessToken')
		? json({ access_token: 'tok', expires_in: '7200' })
		: call.url.endsWith('/messages')
			? json({ id: 'out1', timestamp: 1_790_000_000 })
			: call.url === 'https://multimedia.nt.qq.com/download?id=1'
				? new Response(new Uint8Array([1, 2, 3]))
				: json({});
const event = (type: string, d: object) =>
	JSON.stringify({
		op: 0,
		id: 'e1',
		s: 1,
		t: type,
		d: { id: 'm1', content: 'hello', timestamp: '2026-09-21T22:13:20+08:00', ...d }
	});
const c2c = event('C2C_MESSAGE_CREATE', { author: { user_openid: 'U1' } });
const signed = (body: string) => ({
	'x-signature-timestamp': '1790000000',
	'x-signature-ed25519': sign(null, Buffer.from(`1790000000${body}`), key).toString('hex')
});

describe('QQ', () => {
	it.live('stores a signed message before acknowledging it', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(qq, settings);
			expect(h.status).toMatchObject({ state: 'connected', account: '1024' });
			const acked = yield* required(h.link.webhook)(webhook(c2c, signed(c2c)));
			expect(acked.status).toBe(200);
			expect(yield* Effect.promise(() => acked.json())).toEqual({ op: 12, d: {} });
			expect(h.events).toEqual([
				{
					kind: 'messages',
					messages: [
						{
							id: 'm1',
							thread: 'c2c:U1',
							sent_at: '2026-09-21T14:13:20.000Z',
							from: { handle: 'U1', name: null },
							text: 'hello',
							group: false,
							reply_to: null,
							attachments: [],
							invocation: 'direct'
						}
					]
				}
			]);
		})
	);
	it.live('answers the setup challenge with a signature QQ can verify', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(qq, settings);
			const body = JSON.stringify({
				op: 13,
				d: { plain_token: 'Arq0D5A61EgUu4OxUvOp', event_ts: '1725442341' }
			});
			const signature = yield* Effect.promise(async () => {
				const answered = await Effect.runPromise(required(h.link.webhook)(webhook(body, {})));
				return Schema.decodeUnknownSync(Schema.Struct({ plain_token: Schema.String, signature: Schema.String }))(await answered.json());
			});
			expect(signature.plain_token).toBe('Arq0D5A61EgUu4OxUvOp');
			expect(
				verify(
					null,
					Buffer.from('1725442341Arq0D5A61EgUu4OxUvOp'),
					createPublicKey(key),
					Buffer.from(signature.signature, 'hex')
				)
			).toBe(true);
		})
	);
	it.live('never signs a challenge that could spell a forged event', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(qq, settings);
			const body = JSON.stringify({ op: 13, d: { plain_token: c2c, event_ts: '1790000000' } });
			expect((yield* required(h.link.webhook)(webhook(body, {}))).status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('refuses a bad or missing signature and stores nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(qq, settings);
			const tampered = event('C2C_MESSAGE_CREATE', { author: { user_openid: 'U2' } });
			expect((yield* required(h.link.webhook)(webhook(tampered, signed(c2c)))).status).toBe(401);
			expect((yield* required(h.link.webhook)(webhook(c2c, {}))).status).toBe(401);
			expect(
				(yield* required(h.link.webhook)(
					webhook(c2c, { 'x-signature-timestamp': '1', 'x-signature-ed25519': 'forged' })
				)).status
			).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a message the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(qq, settings, {
				emit: () => Promise.reject(new Error('the store refused'))
			});
			expect((yield* required(h.link.webhook)(webhook(c2c, signed(c2c)))).status).toBe(500);
		})
	);
	it.live('reads each scene, its mention, and skips a bot and an unknown event', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(qq, settings);
			for (const body of [
				event('GROUP_AT_MESSAGE_CREATE', { group_openid: 'G1', author: { member_openid: 'M1' } }),
				event('AT_MESSAGE_CREATE', {
					channel_id: 'CH1',
					guild_id: 'GU1',
					author: { id: 'A1', username: 'Wei' }
				}),
				event('MESSAGE_CREATE', { channel_id: 'CH1', guild_id: 'GU1', author: { id: 'A1' } }),
				event('DIRECT_MESSAGE_CREATE', { channel_id: 'D1', guild_id: 'GU2', author: { id: 'A1' } }),
				event('AT_MESSAGE_CREATE', { channel_id: 'CH1', author: { id: 'B1', bot: true } }),
				event('GUILD_CREATE', { author: { id: 'A1' } })
			])
				expect((yield* required(h.link.webhook)(webhook(body, signed(body)))).status).toBe(200);
			expect(h.events.map((one) => (one.kind === 'messages' ? one.messages[0] : null))).toEqual([
				expect.objectContaining({ thread: 'group:G1', group: true, invocation: 'mention' }),
				expect.objectContaining({
					thread: 'channel:CH1',
					group: true,
					invocation: 'mention',
					from: { handle: 'A1', name: 'Wei' }
				}),
				expect.objectContaining({ thread: 'channel:CH1', group: true, invocation: 'ambient' }),
				expect.objectContaining({ thread: 'direct:GU2', group: false, invocation: 'direct' })
			]);
		})
	);
	it.live('reads a file by a URL QQ gave without its host', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(qq, settings);
			const body = event('C2C_MESSAGE_CREATE', {
				content: '',
				author: { user_openid: 'U1' },
				attachments: [
					{ content_type: 'image/png', filename: 'a.png', url: '/download?id=1', size: 3 }
				]
			});
			yield* required(h.link.webhook)(webhook(body, signed(body)));
			expect(h.events[0]).toMatchObject({
				messages: [{ attachments: [{ name: 'a.png', mime: 'image/png', bytes: 3, bin: 0 }] }],
				bins: [new Uint8Array([1, 2, 3])]
			});
		})
	);
	it.live('a reply names the message it answers, each with its own sequence', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(qq, settings);
			yield* required(h.link.webhook)(webhook(c2c, signed(c2c)));
			for (const expected of [1, 2]) {
				yield* required(h.link.send)({ to: 'c2c:U1', text: 'Hello' }, []);
				expect(JSON.parse(api.calls.at(-1)?.body ?? '')).toMatchObject({
					msg_id: JSON.parse(c2c).d.id,
					msg_seq: expected
				});
			}
		})
	);
	it.live('sends to each scene’s endpoint on one cached token', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(qq, settings);
			expect(yield* required(h.link.send)({ to: 'c2c:U1', text: 'Hello' }, [])).toMatchObject({
				provider_id: 'out1'
			});
			const call = api.calls.at(-1);
			expect(call?.headers.get('authorization')).toBe('QQBot tok');
			expect(JSON.parse(call?.body ?? '')).toEqual({ content: 'Hello', msg_type: 0 });
			for (const to of ['group:G1', 'channel:CH1', 'direct:GU2'])
				yield* required(h.link.send)({ to, text: 'Hello' }, []);
			expect(api.calls.map((one) => one.url)).toEqual([
				'https://bots.qq.com/app/getAppAccessToken',
				'https://api.sgroup.qq.com/v2/users/U1/messages',
				'https://api.sgroup.qq.com/v2/groups/G1/messages',
				'https://api.sgroup.qq.com/channels/CH1/messages',
				'https://api.sgroup.qq.com/dms/GU2/messages'
			]);
		})
	);
	it.live('refuses a thread with no scene, and a code QQ answers with a 200', () =>
		Effect.gen(function* () {
			let refusing = false;
			yield* platformApi((call) =>
				refusing ? json({ code: 304082, message: 'no' }) : answer(call)
			);
			const h = yield* connected(qq, settings);
			expect(yield* Effect.flip(required(h.link.send)({ to: 'U1', text: 'Hello' }, []))).toMatchObject({
				_tag: 'ProviderRefused'
			});
			refusing = true;
			expect(yield* Effect.flip(required(h.link.send)({ to: 'c2c:U1', text: 'Hello' }, []))).toMatchObject({
				_tag: 'ProviderRefused'
			});
		})
	);
	it.live('a test message goes to the person', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(qq, settings);
			yield* required(h.link.test)({ to: 'U1' });
			expect(api.calls.at(-1)?.url).toBe('https://api.sgroup.qq.com/v2/users/U1/messages');
		})
	);
	it.live('credentials QQ refuses keep nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ code: 100016, message: 'invalid appid or secret' }));
			const h = yield* host(chatProvider(qq), fetch);
			yield* Effect.flip(required(h.link.pair)(settings));
			expect(h.values.size).toBe(0);
		})
	);
});
