// WeCom: callbacks sealed and signed the way WeCom seals them, with its API faked behind `fetch`.
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider } from '../../src/chat/adapter.ts';
import { wecom } from '../../src/chat/wecom/index.ts';
import { required, host } from '../kit.ts';
import { connected, json, platformApi, type Call } from './kit.ts';

const encodingAESKey = Buffer.alloc(32, 7).toString('base64').slice(0, 43);
const settings = {
	corpId: 'corp1',
	corpSecret: 'secret',
	agentId: '1000002',
	token: 'callback',
	encodingAESKey
};
const seal = (plain: string, receiver = 'corp1') => {
	const key = Buffer.from(`${encodingAESKey}=`, 'base64'),
		message = Buffer.from(plain),
		length = Buffer.alloc(4);
	length.writeUInt32BE(message.length);
	const clear = Buffer.concat([randomBytes(16), length, message, Buffer.from(receiver)]);
	const pad = 32 - (clear.length % 32);
	const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16)).setAutoPadding(false);
	return Buffer.concat([
		cipher.update(Buffer.concat([clear, Buffer.alloc(pad, pad)])),
		cipher.final()
	]).toString('base64');
};
const query = (encrypted: string, extra: object = {}) => {
	const timestamp = '1790000000',
		nonce = 'n1';
	return new URLSearchParams({
		msg_signature: createHash('sha1')
			.update(['callback', timestamp, nonce, encrypted].sort().join(''))
			.digest('hex'),
		timestamp,
		nonce,
		...extra
	});
};
const delivery = (xml: string, receiver?: string, tamper = false) => {
	const encrypted = seal(xml, receiver),
		params = query(encrypted);
	if (tamper) params.set('msg_signature', 'forged');
	return new Request(`https://hook.test/?${params}`, {
		method: 'POST',
		body: `<xml><ToUserName><![CDATA[corp1]]></ToUserName><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`
	});
};
const text = `<xml><ToUserName><![CDATA[corp1]]></ToUserName><FromUserName><![CDATA[zhang]]></FromUserName><CreateTime>1790000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好]]></Content><MsgId>m1</MsgId><AgentID>1000002</AgentID></xml>`;
const answer = ({ url }: Call) => {
	if (url.includes('/cgi-bin/gettoken'))
		return json({ errcode: 0, errmsg: 'ok', access_token: 'app-token', expires_in: 7200 });
	if (url.includes('/cgi-bin/message/send'))
		return json({ errcode: 0, errmsg: 'ok', msgid: 'out1' });
	if (url.includes('/cgi-bin/media/get')) return new Response(new Uint8Array([1, 2]));
	return json({ errcode: 0 });
};

describe('WeCom', () => {
	it.live('stores a sealed message before acknowledging it', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(wecom, settings);
			expect(h.status).toMatchObject({ state: 'connected', account: 'corp1' });
			expect((yield* required(h.link.webhook)(delivery(text))).status).toBe(200);
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				messages: [
					{
						id: 'm1',
						thread: 'zhang',
						sent_at: new Date(1_790_000_000_000).toISOString(),
						from: { handle: 'zhang' },
						text: '你好',
						group: false,
						invocation: 'direct'
					}
				]
			});
		})
	);
	it.live('answers the URL check with the decrypted echo', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(wecom, settings),
				echostr = seal('echo-123');
			const response = yield* required(h.link.webhook)(
				new Request(`https://hook.test/?${query(echostr, { echostr })}`)
			);
			expect(response.status).toBe(200);
			expect(yield* Effect.promise(() => response.text())).toBe('echo-123');
			expect(h.events).toEqual([]);
		})
	);
	it.live('refuses a bad signature, and a message sealed for another corp', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(wecom, settings);
			expect((yield* required(h.link.webhook)(delivery(text, undefined, true))).status).toBe(401);
			expect((yield* required(h.link.webhook)(delivery(text, 'corp2'))).status).toBe(401);
			const forgedEcho = seal('echo');
			const params = query(forgedEcho, { echostr: forgedEcho });
			params.set('msg_signature', 'forged');
			expect((yield* required(h.link.webhook)(new Request(`https://hook.test/?${params}`))).status).toBe(
				401
			);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a message the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(wecom, settings, {
				emit: () => Promise.reject(new Error('the store refused'))
			});
			expect((yield* required(h.link.webhook)(delivery(text))).status).toBe(500);
		})
	);
	it.live('reads an image by its media id, and an event is nothing', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(wecom, settings);
			const image = `<xml><FromUserName><![CDATA[zhang]]></FromUserName><CreateTime>1790000000</CreateTime><MsgType><![CDATA[image]]></MsgType><PicUrl><![CDATA[https://p.test/1]]></PicUrl><MediaId><![CDATA[media1]]></MediaId><MsgId>m2</MsgId></xml>`;
			const event = `<xml><FromUserName><![CDATA[zhang]]></FromUserName><CreateTime>1790000000</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[enter_agent]]></Event></xml>`;
			yield* required(h.link.webhook)(delivery(image));
			yield* required(h.link.webhook)(delivery(event));
			expect(h.events.length).toBe(1);
			expect(h.events[0]).toMatchObject({
				bins: [new Uint8Array([1, 2])],
				messages: [{ id: 'm2', attachments: [{ name: 'wecom-m2', mime: 'image/*', bin: 0 }] }]
			});
			const url = new URL(api.calls.at(-1)?.url ?? '');
			expect(url.pathname).toBe('/cgi-bin/media/get');
			expect(url.searchParams.get('media_id')).toBe('media1');
		})
	);
	it.live('sends with one cached token, which a refusal drops', () =>
		Effect.gen(function* () {
			let refuse = false;
			const api = yield* platformApi((call) =>
				call.url.includes('/message/send') && refuse
					? json({ errcode: 42001, errmsg: 'access_token expired' })
					: answer(call)
			);
			const h = yield* connected(wecom, settings);
			const sent = yield* required(h.link.send)({ id: 'r1', to: 'zhang', text: 'Hello' }, []);
			expect(sent).toMatchObject({ provider_id: 'out1' });
			const call = api.calls.at(-1);
			expect(new URL(call?.url ?? '').searchParams.get('access_token')).toBe('app-token');
			expect(JSON.parse(call?.body ?? '')).toEqual({
				touser: 'zhang',
				agentid: 1000002,
				msgtype: 'text',
				text: { content: 'Hello' }
			});
			yield* required(h.link.send)({ id: 'r2', to: 'zhang', text: 'Again' }, []);
			const tokens = () => api.calls.filter(({ url }) => url.includes('/gettoken')).length;
			expect(tokens()).toBe(1);
			refuse = true;
			yield* Effect.flip(required(h.link.send)({ id: 'r3', to: 'zhang', text: 'No' }, []));
			refuse = false;
			yield* required(h.link.send)({ id: 'r4', to: 'zhang', text: 'Yes' }, []);
			expect(tokens()).toBe(2);
		})
	);
	it.live('a secret WeCom refuses, or a short key, keeps nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ errcode: 40001, errmsg: 'invalid credential' }));
			const h = yield* host(chatProvider(wecom), fetch);
			yield* Effect.flip(required(h.link.pair)(settings));
			yield* Effect.flip(required(h.link.pair)({ ...settings, encodingAESKey: 'short' }));
			expect(h.values.size).toBe(0);
		})
	);
});
