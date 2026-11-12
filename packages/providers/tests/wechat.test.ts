import { Effect } from 'effect';
// WeChat Official Account: setup validation with an access token, the URL check, msg_signature refusal, safe-mode AES
// decryption (and refusal of another account's message), and the customer-service send with a token refreshed once.
import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { wechat, wechatDecrypt, wechatSignature } from '../src/wechat/index.ts';
import { required, fakeFetch, file, host, json, signal } from './kit.ts';

const KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
	APP = 'wx0123456789abcdef',
	TOKEN = 'tok123';
const CRED = { appId: APP, appSecret: 's3cret', token: TOKEN, encodingAesKey: KEY };
/** The platform's side: random(16) · len · msg · appId, PKCS#7 to 32 bytes, AES-256-CBC. */
const encrypt = (msg: string, appId = APP) => {
	const key = Buffer.from(`${KEY}=`, 'base64'),
		body = Buffer.from(msg),
		len = Buffer.alloc(4);
	len.writeUInt32BE(body.length);
	const plain = Buffer.concat([randomBytes(16), len, body, Buffer.from(appId)]),
		pad = 32 - (plain.length % 32);
	const c = createCipheriv('aes-256-cbc', key, key.subarray(0, 16)).setAutoPadding(false);
	return Buffer.concat([
		c.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])),
		c.final()
	]).toString('base64');
};
const text =
	'<xml><ToUserName><![CDATA[gh_1]]></ToUserName><FromUserName><![CDATA[openid-1]]></FromUserName><CreateTime>1790000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好]]></Content><MsgId>2001</MsgId></xml>';
const post = (enc: string, sig = wechatSignature(TOKEN, '1790000000', 'n1', enc)) =>
	new Request(
		`https://internal/hook?timestamp=1790000000&nonce=n1&encrypt_type=aes&msg_signature=${sig}`,
		{
			method: 'POST',
			body: `<xml><ToUserName><![CDATA[gh_1]]></ToUserName><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`
		}
	);
let tokens = 0;
const api = (errcodes: number[] = []) =>
	fakeFetch([
		(c) =>
			c.url.includes('/cgi-bin/token')
				? c.url.includes('secret=s3cret')
					? json({ access_token: `AT${++tokens}`, expires_in: 7200 })
					: json({ errcode: 40125, errmsg: 'invalid appsecret' })
				: undefined,
		(c) =>
			c.url.includes('/message/custom/')
				? json({ errcode: errcodes.shift() ?? 0, errmsg: 'x' })
				: undefined,
		(c) =>
			c.url.includes('/media/upload')
				? json({ type: 'image', media_id: 'MEDIA1', created_at: 1 })
				: undefined
	]);

describe('WeChat', () => {
	it.effect('validates the four fields, then the AppSecret with an access token', () =>
		Effect.gen(function* () {
			const h = yield* host(wechat(), api());
			expect(
				(yield* Effect.flip(required(h.link.pair)({ ...CRED, encodingAesKey: 'short' }))).message
			).toMatch(/EncodingAESKey does not look right/);
			expect((yield* Effect.flip(required(h.link.pair)({ ...CRED, appId: 'nope' }))).message).toMatch(
				/AppID/
			);
			expect((yield* Effect.flip(required(h.link.pair)({ ...CRED, appSecret: 'wrong' }))).message).toMatch(
				/invalid appsecret/
			);
			expect(h.writes).toEqual([]);
			yield* required(h.link.pair)(CRED);
			expect(Object.fromEntries(h.values)).toEqual({ credential: CRED });
			expect(h.status).toMatchObject({ state: 'connected', account: APP, about: { account: APP } });
		})
	);
	it.effect('answers the URL check only with a right signature', () =>
		Effect.gen(function* () {
			const h = yield* host(wechat(), api(), { credential: CRED });
			const check = (sig: string) =>
				required(h.link.webhook)(
					new Request(`https://internal/hook?signature=${sig}&timestamp=1&nonce=n&echostr=echo-9`)
				);
			expect(
				yield* check(wechatSignature(TOKEN, '1', 'n')).pipe(
					Effect.flatMap((response) => Effect.tryPromise(() => response.text()))
				)
			).toBe('echo-9');
			expect((yield* check('deadbeef')).status).toBe(401);
		})
	);
	it.effect(
		"refuses a bad msg_signature or another account's message; decrypts and decodes a text message",
		() =>
			Effect.gen(function* () {
				const h = yield* host(wechat(), api(), { credential: CRED });
				expect((yield* required(h.link.webhook)(post(encrypt(text), 'bad'))).status).toBe(401);
				expect((yield* required(h.link.webhook)(post(encrypt(text, 'wxffffffffffffffff')))).status).toBe(
					401
				);
				expect(h.events).toEqual([]);
				const r = yield* required(h.link.webhook)(post(encrypt(text)));
				expect(yield* Effect.tryPromise(() => r.text())).toBe('success');
				expect(h.events).toEqual([
					{
						kind: 'messages',
						messages: [
							{
								id: '2001',
								thread: 'openid-1',
								sent_at: '2026-09-21T14:13:20.000Z',
								from: { handle: 'openid-1', name: null },
								text: '你好',
								group: false,
								invocation: 'direct',
								reply_to: null,
								attachments: []
							}
						]
					}
				]);
				expect(wechatDecrypt(encrypt('abc'), KEY, APP)).toBe('abc');
			})
	);
	const xml = (type: string, body: string, id: string | null = '3001') =>
		`<xml><ToUserName><![CDATA[gh_1]]></ToUserName><FromUserName><![CDATA[openid-1]]></FromUserName><CreateTime>1790000000</CreateTime><MsgType><![CDATA[${type}]]></MsgType>${body}${id === null ? '' : `<MsgId>${id}</MsgId>`}</xml>`;
	const media = (answer: Response) =>
		fakeFetch([
			(c) =>
				c.url.includes('/cgi-bin/token')
					? json({ access_token: 'AT', expires_in: 7200 })
					: undefined,
			(c) => (c.url.includes('/media/get') ? answer.clone() : undefined),
			(c) =>
				c.url.startsWith('https://cdn.example/')
					? new Response(new Uint8Array([4, 5]), { headers: { 'content-type': 'video/mp4' } })
					: undefined
		]);
	it.effect('an image lands with its bytes, fetched by MediaId under the access token', () =>
		Effect.gen(function* () {
			const f = media(
				new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
			);
			const h = yield* host(wechat(), f, { credential: CRED });
			yield* required(h.link.webhook)(
				post(
					encrypt(
						xml(
							'image',
							'<PicUrl><![CDATA[https://pic.example/1]]></PicUrl><MediaId><![CDATA[M1]]></MediaId>'
						)
					)
				)
			);
			expect(new URL(required(f.calls.at(-1)).url).searchParams.get('media_id')).toBe('M1');
			expect(h.events).toMatchObject([
				{
					messages: [
						{
							id: '3001',
							text: '',
							attachments: [{ name: 'wechat-3001.jpg', mime: 'image/png', bytes: 3, bin: 0 }]
						}
					],
					bins: [new Uint8Array([1, 2, 3])]
				}
			]);
		})
	);
	it.effect('a video is the download its video_url names; a retried push keeps its id', () =>
		Effect.gen(function* () {
			const h = yield* host(wechat(), media(json({ video_url: 'https://cdn.example/v.mp4' })), {
				credential: CRED
			});
			const video = encrypt(
				xml('video', '<MediaId><![CDATA[M2]]></MediaId><ThumbMediaId><![CDATA[T2]]></ThumbMediaId>')
			);
			yield* required(h.link.webhook)(post(video));
			yield* required(h.link.webhook)(post(video));
			expect(h.events).toMatchObject([
				{
					messages: [{ id: '3001', attachments: [{ mime: 'video/mp4', bytes: 2, bin: 0 }] }],
					bins: [new Uint8Array([4, 5])]
				},
				{ messages: [{ id: '3001' }] }
			]);
		})
	);
	it.effect('a file the platform refuses stays named on the message', () =>
		Effect.gen(function* () {
			const h = yield* host(wechat(), media(json({ errcode: 40007, errmsg: 'invalid media_id' })), {
				credential: CRED
			});
			yield* required(h.link.webhook)(
				post(
					encrypt(
						xml('voice', '<MediaId><![CDATA[M3]]></MediaId><Format><![CDATA[Speex]]></Format>')
					)
				)
			);
			expect(h.events).toMatchObject([
				{
					messages: [
						{ attachments: [{ name: 'wechat-3001.speex', mime: 'audio/speex', bytes: 0 }] }
					]
				}
			]);
			expect(h.events[0]).not.toHaveProperty('bins');
			const down = yield* host(wechat(), media(new Response('<html>', { status: 502, headers: { 'content-type': 'text/html' } })), {
				credential: CRED
			});
			yield* required(down.link.webhook)(post(encrypt(xml('image', '<MediaId><![CDATA[M5]]></MediaId>'))));
			expect(down.events[0]).not.toHaveProperty('bins');
		})
	);
	it.effect('a stale token is fetched again once for a file', () =>
		Effect.gen(function* () {
			let refused = false;
			const f = fakeFetch([
				(c) =>
					c.url.includes('/cgi-bin/token')
						? json({ access_token: `AT${++tokens}`, expires_in: 7200 })
						: undefined,
				(c) => {
					if (!c.url.includes('/media/get')) return undefined;
					if (refused) return new Response(new Uint8Array([8]));
					refused = true;
					return json({ errcode: 40001, errmsg: 'invalid credential' });
				}
			]);
			const h = yield* host(wechat(), f, { credential: CRED });
			yield* required(h.link.webhook)(post(encrypt(xml('image', '<MediaId><![CDATA[M4]]></MediaId>'))));
			expect(h.events).toMatchObject([{ bins: [new Uint8Array([8])] }]);
		})
	);
	it.effect('a location and a link are their text; an event is still no message', () =>
		Effect.gen(function* () {
			const h = yield* host(wechat(), api(), { credential: CRED });
			yield* required(h.link.webhook)(
				post(
					encrypt(
						xml(
							'location',
							'<Location_X>1.29</Location_X><Location_Y>103.85</Location_Y><Scale>20</Scale><Label><![CDATA[Office]]></Label>'
						)
					)
				)
			);
			yield* required(h.link.webhook)(
				post(
					encrypt(
						xml(
							'link',
							'<Title><![CDATA[Quote]]></Title><Description><![CDATA[v2]]></Description><Url><![CDATA[https://a.example]]></Url>',
							'3002'
						)
					)
				)
			);
			yield* required(h.link.webhook)(
				post(encrypt(xml('event', '<Event><![CDATA[subscribe]]></Event>', null)))
			);
			expect(h.events).toMatchObject([
				{ messages: [{ id: '3001', text: 'Office\n1.29, 103.85' }] },
				{ messages: [{ id: '3002', text: 'Quote\nv2\nhttps://a.example' }] }
			]);
			expect(h.events).toHaveLength(2);
		})
	);
	it.effect(
		'a push without a MsgId keys on its sender and time, so its retry is the same message',
		() =>
			Effect.gen(function* () {
				const h = yield* host(wechat(), api(), { credential: CRED });
				const push = encrypt(xml('text', '<Content><![CDATA[hi]]></Content>', null));
				yield* required(h.link.webhook)(post(push));
				yield* required(h.link.webhook)(post(push));
				expect(h.events).toMatchObject([
					{ messages: [{ id: 'openid-1:1790000000' }] },
					{ messages: [{ id: 'openid-1:1790000000' }] }
				]);
			})
	);
	it.effect('a retried send names the same provider id', () =>
		Effect.gen(function* () {
			const h = yield* host(wechat(), api(), { credential: CRED });
			const hello = { id: 'm-9', to: 'openid-1', text: 'hi' };
			const first = yield* required(h.link.send)(hello, undefined);
			expect(first).toEqual({ provider_id: 'wx-m-9' });
			expect(yield* required(h.link.send)(hello, undefined)).toEqual(first);
		})
	);
	it.effect('sends through the customer-service API; an expired token is fetched again once', () =>
		Effect.gen(function* () {
			const f = api([42001]),
				h = yield* host(wechat(), f, { credential: CRED });
			yield* required(h.link.send)({ id: 'm-1', to: 'openid-1', text: 'hi' }, undefined);
			const sends = f.calls.filter((c) => c.url.includes('/message/custom/send'));
			expect(sends).toHaveLength(2);
			expect(required(sends[1]).url).not.toBe(required(sends[0]).url);
			expect(JSON.parse(required(sends[1]).body)).toEqual({
				touser: 'openid-1',
				msgtype: 'text',
				text: { content: 'hi' }
			});
			expect(
				(yield* Effect.flip(
					required((yield* host(wechat(), api([45015]), { credential: CRED })).link.send)(
						{ id: 'm-2', to: 'o', text: 'x' },
						undefined
					)
				)).message
			).toMatch(/45015/);
		})
	);
	it.effect('an image goes as uploaded media; any other file as a signed download link', () =>
		Effect.gen(function* () {
			const f = api(),
				h = yield* host(wechat(), f, { credential: CRED });
			yield* required(h.link.send)({ id: 'm-3', to: 'openid-1', text: 'hi' }, [
				file('report.pdf', 'application/pdf', '%PDF r'),
				file('chart.png', 'image/png', 'png')
			]);
			const upload = required(f.calls.find((c) => c.url.includes('/media/upload')));
			expect(upload.url).toMatch(/type=image$/);
			const media = required(upload.form).get('media');
			if (!(media instanceof File)) throw new Error('The uploaded image is missing.');
			expect(media.name).toBe('chart.png');
			expect(
				f.calls.filter((c) => c.url.includes('/message/custom/send')).map((c) => JSON.parse(c.body))
			).toEqual([
				{ touser: 'openid-1', msgtype: 'text', text: { content: 'hi' } },
				{
					touser: 'openid-1',
					msgtype: 'text',
					text: { content: 'report.pdf: https://host.example/files/report.pdf?sig=x' }
				},
				{ touser: 'openid-1', msgtype: 'image', image: { media_id: 'MEDIA1' } }
			]);
		})
	);
});
