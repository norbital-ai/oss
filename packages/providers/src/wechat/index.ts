import { Cache, Effect, Exit, Option, Random, Schema } from 'effect';
import { createDecipheriv, createHash } from 'node:crypto';
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';
import type { DriverOpen, Json, OutboundAttachment } from '@norbital-ai/bolt/engine';
import type { ProviderDef } from '../abi.ts';
import { answerFailure, ProviderUnavailable } from '../errors.ts';
import {
	blobOf,
	field,
	hostCall,
	linkOf,
	same,
	storedCredential,
	withFetch,
	type Obj
} from '../util.ts';

const API = 'https://api.weixin.qq.com';
const IMAGE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/bmp']);
const Credential = Schema.Struct({
	appId: Schema.NonEmptyString,
	appSecret: Schema.NonEmptyString,
	token: Schema.NonEmptyString,
	encodingAesKey: Schema.NonEmptyString
});
const Answer = Schema.Struct({
	access_token: Schema.optionalKey(Schema.String),
	expires_in: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
	errcode: Schema.optionalKey(Schema.Number),
	errmsg: Schema.optionalKey(Schema.String),
	media_id: Schema.optionalKey(Schema.String)
});
const Message = Schema.Struct({ to: Schema.NonEmptyString, text: Schema.String });
type Cred = typeof Credential.Type;

export function wechat(): ProviderDef {
	return {
		_tag: 'ProviderDef',
		driver: 'wechat',
		id: 'official_account',
		label: { en: 'WeChat Official Account', zh: '微信公众号' },
		setup: {
			kind: 'form',
			webhook: true,
			steps: [
				{
					text: {
						en: 'In the WeChat Official Accounts Platform, open Settings and Development → Basic Configuration.',
						zh: '在微信公众平台打开 设置与开发 → 基本配置。'
					},
					href: 'https://mp.weixin.qq.com'
				},
				{
					text: {
						en: "Copy the AppID and AppSecret, and add this host's outbound IP to the IP whitelist.",
						zh: '复制 AppID 和 AppSecret，并将本主机的出站 IP 加入 IP 白名单。'
					}
				},
				{
					text: {
						en: 'Under Server Configuration: paste this URL, choose a Token, generate an EncodingAESKey, set Message Encryption to Safe Mode, then enable it.',
						zh: '在服务器配置中：粘贴此 URL，设置 Token，生成 EncodingAESKey，将消息加解密方式设为安全模式，然后启用。'
					},
					copy: 'webhookUrl'
				},
				{
					text: {
						en: 'Paste the four values below. Replies reach a follower within 48 hours of their last message.',
						zh: '在下方粘贴这四个值。回复仅能在关注者最后一条消息后的 48 小时内送达。'
					}
				}
			],
			fields: [
				{ name: 'appId', label: { en: 'AppID', zh: 'AppID' }, hint: { en: 'wx…', zh: 'wx…' } },
				{ name: 'appSecret', label: { en: 'AppSecret', zh: 'AppSecret' }, secret: true },
				{ name: 'token', label: { en: 'Token', zh: '令牌（Token）' }, secret: true },
				{
					name: 'encodingAesKey',
					label: { en: 'EncodingAESKey', zh: '消息加解密密钥（EncodingAESKey）' },
					secret: true,
					hint: { en: '43 characters', zh: '43 个字符' }
				}
			]
		},
		test: {
			to: {
				name: 'to',
				label: { en: 'Follower openid', zh: '关注者 openid' },
				hint: {
					en: 'Someone who messaged the account in the last 48 hours',
					zh: '48 小时内给公众号发过消息的人'
				}
			}
		},
		open: Effect.fn('WeChat.open')(function* (ctx: DriverOpen) {
			const stored = yield* storedCredential(ctx, Credential);
			let cred: Cred | null = Option.getOrNull(stored);
			const connected = (value: Cred) =>
				hostCall('report WeChat status', () =>
					ctx.status({ state: 'connected', account: value.appId, about: { account: value.appId } })
				);
			const call = (request: HttpClientRequest.HttpClientRequest) =>
				withFetch(
					ctx,
					Effect.gen(function* () {
						const response = yield* HttpClient.execute(request).pipe(
							Effect.mapError(() => new ProviderUnavailable({ message: 'WeChat request failed' }))
						);
						const answer = yield* HttpClientResponse.schemaBodyJson(Answer)(response).pipe(
							Effect.mapError(
								() => new ProviderUnavailable({ message: 'WeChat response is malformed' })
							)
						);
						if (response.status >= 400)
							return yield* Effect.fail(
								answerFailure(`WeChat ${response.status}: ${answer.errmsg ?? ''}`, response.status)
							);
						return answer;
					})
				);
			const tokens = yield* Cache.makeWith(
				(value: Cred) =>
					Effect.gen(function* () {
						const answer = yield* call(
							HttpClientRequest.get(`${API}/cgi-bin/token`, {
								urlParams: {
									grant_type: 'client_credential',
									appid: value.appId,
									secret: value.appSecret
								}
							})
						);
						if (!answer.access_token)
							return yield* Effect.fail(
								new ProviderUnavailable({
									message: `WeChat token: ${answer.errmsg ?? ''} (${answer.errcode ?? ''})`
								})
							);
						return {
							token: answer.access_token,
							ttl: Math.max(0, (Number(answer.expires_in ?? 7200) - 300) * 1000)
						};
					}),
				{
					capacity: 1,
					timeToLive: (exit) =>
						Exit.isSuccess(exit) && Number.isFinite(exit.value.ttl) ? exit.value.ttl : 0
				}
			);
			const accessToken = (value: Cred, fresh = false) =>
				Effect.gen(function* () {
					if (fresh) yield* Cache.invalidate(tokens, value);
					return (yield* Cache.get(tokens, value)).token;
				});
			const custom = Effect.fn('WeChat.custom')(function* (path: string, body: Json) {
				if (cred === null)
					return yield* Effect.fail(
						new ProviderUnavailable({ message: 'the WeChat account is not connected' })
					);
				const value = cred;
				for (const fresh of [false, true]) {
					const answer = yield* call(
						HttpClientRequest.post(`${API}/cgi-bin/message/custom/${path}`, {
							urlParams: { access_token: yield* accessToken(value, fresh) }
						}).pipe(HttpClientRequest.bodyJsonUnsafe(body))
					);
					if ((answer.errcode ?? 0) === 0) return;
					if (fresh || (answer.errcode !== 40001 && answer.errcode !== 42001))
						return yield* Effect.fail(
							answerFailure(
								`WeChat ${path}: ${answer.errmsg ?? ''} (${answer.errcode})`,
								answer.errcode === -1
									? 503
									: answer.errcode === 45009 || answer.errcode === 45047
										? 429
										: 400,
								String(answer.errcode)
							)
						);
				}
			});
			if (cred !== null) yield* connected(cred);
			return {
				pair: Effect.fn('WeChat.pair')(function* (input: Json) {
					const value = {
						appId: yield* field(input, 'appId', 'The AppID', /^wx[0-9a-f]{16}$/i),
						appSecret: yield* field(input, 'appSecret', 'The AppSecret'),
						token: yield* field(input, 'token', 'The Token', /^[A-Za-z0-9]{3,32}$/),
						encodingAesKey: yield* field(
							input,
							'encodingAesKey',
							'The EncodingAESKey',
							/^[A-Za-z0-9]{43}$/
						)
					};
					yield* Cache.invalidateAll(tokens);
					yield* accessToken(value, true);
					yield* hostCall('store WeChat credential', () =>
						ctx.credentials.write(new Map([['credential', value]]))
					);
					cred = value;
					yield* connected(value);
				}),
				unpair: () =>
					Effect.gen(function* () {
						cred = null;
						yield* Cache.invalidateAll(tokens);
					}),
				close: Effect.void,
				send: Effect.fn('WeChat.send')(function* (
					message: Json,
					files: readonly OutboundAttachment[] = []
				) {
					if (cred === null)
						return yield* Effect.fail(
							new ProviderUnavailable({ message: 'the WeChat account is not connected' })
						);
					const value = cred;
					const m = yield* Schema.decodeUnknownEffect(Message)(message).pipe(
						Effect.mapError(() => answerFailure('a WeChat message needs `to` and `text`', 400))
					);
					const links = yield* Effect.forEach(
						files.filter((file) => !IMAGE.has(file.mime)),
						(file) => linkOf(file, 604800).pipe(Effect.map((url) => `${file.name}: ${url}`)),
						{ concurrency: 'unbounded' }
					);
					yield* custom('send', { touser: m.to, msgtype: 'text', text: { content: m.text } });
					for (const content of links)
						yield* custom('send', { touser: m.to, msgtype: 'text', text: { content } });
					for (const file of files.filter((item) => IMAGE.has(item.mime))) {
						const form = new FormData();
						form.set('media', blobOf(file), file.name);
						const answer = yield* call(
							HttpClientRequest.post(`${API}/cgi-bin/media/upload`, {
								urlParams: { access_token: yield* accessToken(value), type: 'image' }
							}).pipe(HttpClientRequest.bodyFormData(form))
						);
						if (!answer.media_id)
							return yield* Effect.fail(
								answerFailure(
									`WeChat media/upload: ${answer.errmsg ?? ''} (${answer.errcode ?? ''})`,
									400
								)
							);
						yield* custom('send', {
							touser: m.to,
							msgtype: 'image',
							image: { media_id: answer.media_id }
						});
					}
					return { providerId: `wx-${yield* Random.nextInt}` };
				}),
				typing: (to: string, on: boolean) =>
					custom('typing', { touser: to, command: on ? 'Typing' : 'CancelTyping' }),
				webhook: Effect.fn('WeChat.webhook')(function* (request: Request) {
					if (cred === null) return new Response(null, { status: 404 });
					const q = new URL(request.url).searchParams,
						ts = q.get('timestamp') ?? '',
						nonce = q.get('nonce') ?? '';
					if (request.method === 'GET')
						return same(q.get('signature') ?? '', wechatSignature(cred.token, ts, nonce))
							? new Response(q.get('echostr') ?? '')
							: new Response(null, { status: 401 });
					const xml = yield* hostCall('read WeChat body', () => request.text());
					const encrypted = xmlField(xml, 'Encrypt');
					if (
						encrypted === null ||
						!same(q.get('msg_signature') ?? '', wechatSignature(cred.token, ts, nonce, encrypted))
					)
						return new Response(null, { status: 401 });
					const value = cred;
					const plain = yield* Effect.try({
						try: () => wechatDecrypt(encrypted, value.encodingAesKey, value.appId),
						catch: () => new ProviderUnavailable({ message: 'WeChat ciphertext was refused' })
					}).pipe(
						Effect.map(Option.some),
						Effect.orElseSucceed(() => Option.none())
					);
					if (Option.isNone(plain)) return new Response(null, { status: 401 });
					const message = wechatMessage(plain.value);
					if (message !== null)
						yield* hostCall('store WeChat message', () =>
							ctx.emit({ kind: 'messages', messages: [message] })
						);
					return new Response('success');
				})
			};
		})
	};
}

/** SHA-1 over the sorted, concatenated parts: the platform's `signature` (Token, timestamp, nonce) and `msg_signature` (plus the ciphertext). */
export const wechatSignature = (...parts: string[]): string =>
	createHash('sha1')
		.update([...parts].sort().join(''))
		.digest('hex');

/** Safe mode: AES-256-CBC under the EncodingAESKey (its first 16 bytes the IV), PKCS#7 over 32-byte blocks; `random(16) · len(4) · msg · appId`. */
export function wechatDecrypt(encrypted: string, encodingAesKey: string, appId: string): string {
	const key = Buffer.from(`${encodingAesKey}=`, 'base64');
	const d = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16)).setAutoPadding(false);
	const padded = Buffer.concat([d.update(Buffer.from(encrypted, 'base64')), d.final()]);
	const pad = padded[padded.length - 1];
	if (pad === undefined || pad < 1 || pad > 32) throw new Error('bad padding');
	const body = padded.subarray(16, padded.length - pad),
		len = body.readUInt32BE(0);
	if (body.subarray(4 + len).toString('utf8') !== appId)
		throw new Error("another account's message");
	return body.subarray(4, 4 + len).toString('utf8');
}

/** `<Tag><![CDATA[…]]></Tag>` or `<Tag>…</Tag>`, the flat XML the platform sends. */
export const xmlField = (xml: string, tag: string): string | null => {
	const m = new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</${tag}>`).exec(xml);
	return m === null ? null : (m[1] ?? m[2] ?? null);
};

/** One decrypted message → the wire message; `null` for events (follow, menu clicks) and kinds a conversation does not read. */
export function wechatMessage(xml: string): Obj | null {
	const type = xmlField(xml, 'MsgType'),
		from = xmlField(xml, 'FromUserName'),
		id = xmlField(xml, 'MsgId'),
		at = Number(xmlField(xml, 'CreateTime'));
	if (type !== 'text' || from === null || id === null || !Number.isFinite(at)) return null;
	return {
		id,
		thread: from,
		sentAt: new Date(at * 1000).toISOString(),
		from: { handle: from, name: null },
		text: xmlField(xml, 'Content') ?? '',
		group: false,
		invocation: 'direct',
		replyTo: null,
		attachments: []
	};
}
