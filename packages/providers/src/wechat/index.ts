// WeChat: an Official Account in safe mode. Pairing takes the AppID, AppSecret, the server Token and the
// EncodingAESKey; an access token is fetched (and cached until shortly before it expires) to prove them. Inbound
// messages arrive on this channel's webhook: the URL check (`signature` over the Token, timestamp and nonce, answered
// with `echostr`), then each POST's `msg_signature` over the encrypted body, decrypted with the EncodingAESKey (AES-256-CBC,
// the AppID as the trailer). Sends are the customer-service message API, which reaches a follower who wrote in the last 48 hours.
// An image attachment is uploaded as temporary media and sent as an image; the API sends no other file, so any other
// attachment goes as a text line with the host's signed download link (valid seven days).
import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { connection, type ChannelProvider } from '@norbital-ai/bolt/engine';
import { blobOf, field, isObj, linkOf, refusal, same, type Obj } from '../util.ts';

const API = 'https://api.weixin.qq.com';
/** What the customer-service API sends as an image; anything else is a download link. */
const IMAGE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/bmp']);

export function wechat(o: { api?: string; now?: () => number } = {}): ChannelProvider {
	const api = o.api ?? API, now = o.now ?? Date.now;
	return {
		transport: 'wechat', id: 'official_account', label: { en: 'WeChat Official Account', zh: '微信公众号' },
		setup: { kind: 'form', webhook: true, steps: [
			{ text: { en: 'In the WeChat Official Accounts Platform, open Settings and Development → Basic Configuration.', zh: '在微信公众平台打开 设置与开发 → 基本配置。' }, href: 'https://mp.weixin.qq.com' },
			{ text: { en: 'Copy the AppID and AppSecret, and add this host\'s outbound IP to the IP whitelist.', zh: '复制 AppID 和 AppSecret，并将本主机的出站 IP 加入 IP 白名单。' } },
			{ text: { en: 'Under Server Configuration: paste this URL, choose a Token, generate an EncodingAESKey, set Message Encryption to Safe Mode, then enable it.',
				zh: '在服务器配置中：粘贴此 URL，设置 Token，生成 EncodingAESKey，将消息加解密方式设为安全模式，然后启用。' }, copy: 'webhookUrl' },
			{ text: { en: 'Paste the four values below. Replies reach a follower within 48 hours of their last message.', zh: '在下方粘贴这四个值。回复仅能在关注者最后一条消息后的 48 小时内送达。' } },
		], fields: [
			{ name: 'appId', label: 'AppID', hint: 'wx…' },
			{ name: 'appSecret', label: 'AppSecret', secret: true },
			{ name: 'token', label: { en: 'Token', zh: '令牌（Token）' }, secret: true },
			{ name: 'encodingAesKey', label: { en: 'EncodingAESKey', zh: '消息加解密密钥（EncodingAESKey）' }, secret: true, hint: { en: '43 characters', zh: '43 个字符' } },
		] },
		test: { to: { name: 'to', label: { en: 'Follower openid', zh: '关注者 openid' }, hint: { en: 'Someone who messaged the account in the last 48 hours', zh: '48 小时内给公众号发过消息的人' } } },
		async open(ctx) {
			type Cred = { appId: string; appSecret: string; token: string; encodingAesKey: string };
			let cred: Cred | null = isObj(ctx.credential) && typeof ctx.credential['appId'] === 'string' ? ctx.credential as unknown as Cred : null;
			let cached: { token: string; until: number } | null = null;
			const accessToken = async (c: Cred, fresh = false): Promise<string> => {
				if (!fresh && cached !== null && cached.until > now()) return cached.token;
				const res = await ctx.fetch(`${api}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(c.appId)}&secret=${encodeURIComponent(c.appSecret)}`);
				const j = await res.json().catch(() => ({})) as Obj;
				if (typeof j['access_token'] !== 'string') throw new Error(`WeChat token: ${String(j['errmsg'] ?? res.status)} (${String(j['errcode'] ?? '')})`);
				cached = { token: j['access_token'], until: now() + (Number(j['expires_in'] ?? 7200) - 300) * 1000 };
				return cached.token;
			};
			/** A customer-service call; an expired token (40001, 42001) is fetched again once. */
			const custom = async (path: string, body: Obj, signal?: AbortSignal) => {
				if (cred === null) throw new Error('the WeChat account is not connected');
				for (const fresh of [false, true]) {
					const res = await ctx.fetch(`${api}/cgi-bin/message/custom/${path}?access_token=${encodeURIComponent(await accessToken(cred, fresh))}`, {
						method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) });
					const j = await res.json().catch(() => ({})) as Obj;
					if (Number(j['errcode'] ?? 0) === 0) return;
					// -1 is "system busy" and 45009 / 45047 a rate limit: retried; any other code is a refusal
					if (fresh || (j['errcode'] !== 40001 && j['errcode'] !== 42001)) throw refusal(`WeChat ${path}: ${String(j['errmsg'] ?? res.status)} (${String(j['errcode'])})`,
						!res.ok ? res.status : j['errcode'] === -1 ? 503 : j['errcode'] === 45009 || j['errcode'] === 45047 ? 429 : 400, String(j['errcode'] ?? res.status));
				}
			};
			return {
				connection: () => cred === null ? connection(ctx.channel, 'wechat', 'unpaired')
					: connection(ctx.channel, 'wechat', 'connected', { stored: true, pairedAs: cred.appId, about: { account: cred.appId } }),
				async pair(input) {
					const c: Cred = { appId: field(input, 'appId', 'The AppID', /^wx[0-9a-f]{16}$/i), appSecret: field(input, 'appSecret', 'The AppSecret'),
						token: field(input, 'token', 'The Token', /^[A-Za-z0-9]{3,32}$/), encodingAesKey: field(input, 'encodingAesKey', 'The EncodingAESKey', /^[A-Za-z0-9]{43}$/) };
					cached = null;
					await accessToken(c, true);
					cred = c;
					await ctx.save(c);
					ctx.changed();
				},
				async unpair() { cred = null; cached = null; await ctx.save(null); },
				async close() {},
				async send(_channel, message, signal, files = []) {
					const m = message as { to: string; text: string };
					const links = await Promise.all(files.filter((f) => !IMAGE.has(f.mime)).map(async (f) => `${f.name}: ${await linkOf(f, 604_800)}`));
					await custom('send', { touser: m.to, msgtype: 'text', text: { content: m.text } }, signal);
					for (const content of links) await custom('send', { touser: m.to, msgtype: 'text', text: { content } }, signal);
					for (const f of files.filter((x) => IMAGE.has(x.mime))) {
						const form = new FormData();
						form.set('media', blobOf(f), f.name);
						const res = await ctx.fetch(`${api}/cgi-bin/media/upload?access_token=${encodeURIComponent(await accessToken(cred!))}&type=image`, { method: 'POST', body: form, signal });
						const j = await res.json().catch(() => ({})) as Obj;
						if (typeof j['media_id'] !== 'string') throw refusal(`WeChat media/upload: ${String(j['errmsg'] ?? res.status)} (${String(j['errcode'] ?? '')})`, res.ok ? 400 : res.status);
						await custom('send', { touser: m.to, msgtype: 'image', image: { media_id: j['media_id'] } }, signal);
					}
					return { providerId: `wx-${randomUUID()}` }; // the API answers no message id
				},
				async typing(_channel, to, signal) { await custom('typing', { touser: to, command: 'Typing' }, signal); },
				async webhook(request) {
					if (cred === null) return new Response(null, { status: 404 });
					const q = new URL(request.url).searchParams, ts = q.get('timestamp') ?? '', nonce = q.get('nonce') ?? '';
					if (request.method === 'GET') // the URL check the platform runs when the operator enables the server configuration
						return same(q.get('signature') ?? '', wechatSignature(cred.token, ts, nonce)) ? new Response(q.get('echostr') ?? '') : new Response(null, { status: 401 });
					const xml = await request.text();
					const encrypted = xmlField(xml, 'Encrypt');
					if (encrypted === null || !same(q.get('msg_signature') ?? '', wechatSignature(cred.token, ts, nonce, encrypted))) return new Response(null, { status: 401 });
					let plain: string;
					try { plain = wechatDecrypt(encrypted, cred.encodingAesKey, cred.appId); } catch { return new Response(null, { status: 401 }); }
					const message = wechatMessage(plain);
					if (message !== null) await ctx.emit({ kind: 'inbound', channel: ctx.channel, message });
					return new Response('success');
				},
			};
		},
	};
}

/** SHA-1 over the sorted, concatenated parts: the platform's `signature` (Token, timestamp, nonce) and `msg_signature` (plus the ciphertext). */
export const wechatSignature = (...parts: string[]): string => createHash('sha1').update([...parts].sort().join('')).digest('hex');

/** Safe mode: AES-256-CBC under the EncodingAESKey (its first 16 bytes the IV), PKCS#7 over 32-byte blocks; `random(16) · len(4) · msg · appId`. */
export function wechatDecrypt(encrypted: string, encodingAesKey: string, appId: string): string {
	const key = Buffer.from(`${encodingAesKey}=`, 'base64');
	const d = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16)).setAutoPadding(false);
	const padded = Buffer.concat([d.update(Buffer.from(encrypted, 'base64')), d.final()]);
	const pad = padded[padded.length - 1]!;
	if (pad < 1 || pad > 32) throw new Error('bad padding');
	const body = padded.subarray(16, padded.length - pad), len = body.readUInt32BE(0);
	if (body.subarray(4 + len).toString('utf8') !== appId) throw new Error('another account\'s message');
	return body.subarray(4, 4 + len).toString('utf8');
}

/** `<Tag><![CDATA[…]]></Tag>` or `<Tag>…</Tag>`, the flat XML the platform sends. */
export const xmlField = (xml: string, tag: string): string | null => {
	const m = new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</${tag}>`).exec(xml);
	return m === null ? null : m[1] ?? m[2] ?? null;
};

/** One decrypted message → the wire message; `null` for events (follow, menu clicks) and kinds a channel does not read. */
export function wechatMessage(xml: string): Obj | null {
	const type = xmlField(xml, 'MsgType'), from = xmlField(xml, 'FromUserName'), id = xmlField(xml, 'MsgId'), at = Number(xmlField(xml, 'CreateTime'));
	if (type !== 'text' || from === null || id === null || !Number.isFinite(at)) return null;
	return { id, thread: from, sentAt: new Date(at * 1000).toISOString(), from: { handle: from, name: null }, text: xmlField(xml, 'Content') ?? '',
		group: false, invocation: 'direct', replyTo: null, attachments: [] };
}
