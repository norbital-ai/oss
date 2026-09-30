// WeChat Official Account: setup validation with an access token, the URL check, msg_signature refusal, safe-mode AES
// decryption (and refusal of another account's message), and the customer-service send with a token refreshed once.
import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { wechat, wechatDecrypt, wechatSignature } from '../src/wechat/index.ts';
import { fakeFetch, file, host, json, signal } from './kit.ts';

const KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', APP = 'wx0123456789abcdef', TOKEN = 'tok123';
const CRED = { appId: APP, appSecret: 's3cret', token: TOKEN, encodingAesKey: KEY };
/** The platform's side: random(16) · len · msg · appId, PKCS#7 to 32 bytes, AES-256-CBC. */
const encrypt = (msg: string, appId = APP) => {
	const key = Buffer.from(`${KEY}=`, 'base64'), body = Buffer.from(msg), len = Buffer.alloc(4);
	len.writeUInt32BE(body.length);
	const plain = Buffer.concat([randomBytes(16), len, body, Buffer.from(appId)]), pad = 32 - (plain.length % 32);
	const c = createCipheriv('aes-256-cbc', key, key.subarray(0, 16)).setAutoPadding(false);
	return Buffer.concat([c.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])), c.final()]).toString('base64');
};
const text = '<xml><ToUserName><![CDATA[gh_1]]></ToUserName><FromUserName><![CDATA[openid-1]]></FromUserName><CreateTime>1790000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好]]></Content><MsgId>2001</MsgId></xml>';
const post = (enc: string, sig = wechatSignature(TOKEN, '1790000000', 'n1', enc)) =>
	new Request(`https://internal/hook?timestamp=1790000000&nonce=n1&encrypt_type=aes&msg_signature=${sig}`, { method: 'POST',
		body: `<xml><ToUserName><![CDATA[gh_1]]></ToUserName><Encrypt><![CDATA[${enc}]]></Encrypt></xml>` });
let tokens = 0;
const api = (errcodes: number[] = []) => fakeFetch([
	(c) => c.url.includes('/cgi-bin/token') ? (c.url.includes('secret=s3cret') ? json({ access_token: `AT${++tokens}`, expires_in: 7200 }) : json({ errcode: 40125, errmsg: 'invalid appsecret' })) : undefined,
	(c) => c.url.includes('/message/custom/') ? json({ errcode: errcodes.shift() ?? 0, errmsg: 'x' }) : undefined,
	(c) => c.url.includes('/media/upload') ? json({ type: 'image', media_id: 'MEDIA1', created_at: 1 }) : undefined,
]);

describe('WeChat', () => {
	it('validates the four fields, then the AppSecret with an access token', async () => {
		const h = await host(wechat(), api());
		await expect(h.link.pair({ ...CRED, encodingAesKey: 'short' })).rejects.toThrow(/EncodingAESKey does not look right/);
		await expect(h.link.pair({ ...CRED, appId: 'nope' })).rejects.toThrow(/AppID/);
		await expect(h.link.pair({ ...CRED, appSecret: 'wrong' })).rejects.toThrow(/invalid appsecret/);
		expect(h.saved).toEqual([]);
		await h.link.pair(CRED);
		expect(h.saved).toEqual([CRED]);
		expect(h.link.connection()).toMatchObject({ state: 'connected', about: { account: APP } });
	});
	it('answers the URL check only with a right signature', async () => {
		const h = await host(wechat(), api(), CRED);
		const check = (sig: string) => h.link.webhook!(new Request(`https://internal/hook?signature=${sig}&timestamp=1&nonce=n&echostr=echo-9`));
		expect(await (await check(wechatSignature(TOKEN, '1', 'n'))).text()).toBe('echo-9');
		expect((await check('deadbeef')).status).toBe(401);
	});
	it('refuses a bad msg_signature or another account\'s message; decrypts and decodes a text message', async () => {
		const h = await host(wechat(), api(), CRED);
		expect((await h.link.webhook!(post(encrypt(text), 'bad'))).status).toBe(401);
		expect((await h.link.webhook!(post(encrypt(text, 'wxffffffffffffffff')))).status).toBe(401);
		expect(h.events).toEqual([]);
		const r = await h.link.webhook!(post(encrypt(text)));
		expect(await r.text()).toBe('success');
		expect(h.events).toEqual([{ kind: 'inbound', channel: 'desk', message: { id: '2001', thread: 'openid-1', sentAt: '2026-09-21T14:13:20.000Z',
			from: { handle: 'openid-1', name: null }, text: '你好', group: false, invocation: 'direct', replyTo: null, attachments: [] } }]);
		expect(wechatDecrypt(encrypt('abc'), KEY, APP)).toBe('abc');
	});
	it('sends through the customer-service API; an expired token is fetched again once', async () => {
		const f = api([42001]), h = await host(wechat(), f, CRED);
		await h.link.send('desk', { to: 'openid-1', text: 'hi' }, signal());
		const sends = f.calls.filter((c) => c.url.includes('/message/custom/send'));
		expect(sends).toHaveLength(2);
		expect(sends[1]!.url).not.toBe(sends[0]!.url);
		expect(JSON.parse(sends[1]!.body)).toEqual({ touser: 'openid-1', msgtype: 'text', text: { content: 'hi' } });
		await expect((await host(wechat(), api([45015]), CRED)).link.send('desk', { to: 'o', text: 'x' }, signal())).rejects.toThrow(/45015/);
	});
	it('an image goes as uploaded media; any other file as a signed download link', async () => {
		const f = api(), h = await host(wechat(), f, CRED);
		await h.link.send('desk', { to: 'openid-1', text: 'hi' }, signal(), [file('report.pdf', 'application/pdf', '%PDF r'), file('chart.png', 'image/png', 'png')]);
		const upload = f.calls.find((c) => c.url.includes('/media/upload'))!;
		expect(upload.url).toMatch(/type=image$/);
		expect((upload.form!.get('media') as File).name).toBe('chart.png');
		expect(f.calls.filter((c) => c.url.includes('/message/custom/send')).map((c) => JSON.parse(c.body))).toEqual([
			{ touser: 'openid-1', msgtype: 'text', text: { content: 'hi' } },
			{ touser: 'openid-1', msgtype: 'text', text: { content: 'report.pdf: https://host.example/files/report.pdf?sig=x' } },
			{ touser: 'openid-1', msgtype: 'image', image: { media_id: 'MEDIA1' } }]);
	});
});
