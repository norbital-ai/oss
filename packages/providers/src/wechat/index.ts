import { Cache, Effect, Exit, Option, Schema } from 'effect';
import { createDecipheriv, createHash } from 'node:crypto';
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';
import type { DriverOpen, Json, OutboundAttachment } from '@norbital-ai/bolt/engine';
import type { ProviderDef } from '../abi.ts';
import { answerFailure, ProviderUnavailable, type ProviderFailure } from '../errors.ts';
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
const Message = Schema.Struct({
	id: Schema.NonEmptyString,
	to: Schema.NonEmptyString,
	text: Schema.String
});
/** `media/get` answers bytes, or JSON: a video's `video_url`, or a refusal. */
const decodeMedia = Schema.decodeUnknownOption(
	Schema.fromJsonString(
		Schema.Struct({
			video_url: Schema.optionalKey(Schema.String),
			errcode: Schema.optionalKey(Schema.Number),
			errmsg: Schema.optionalKey(Schema.String)
		})
	)
);
type Cred = typeof Credential.Type;
type Download = { readonly type: string; readonly body: Uint8Array };

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
			const download = (request: HttpClientRequest.HttpClientRequest) =>
				withFetch(
					ctx,
					Effect.gen(function* () {
						const response = yield* HttpClient.execute(request);
						if (response.status >= 400)
							return yield* Effect.fail(new ProviderUnavailable({ message: 'refused' }));
						return {
							type: response.headers['content-type'] ?? '',
							body: new Uint8Array(yield* response.arrayBuffer)
						};
					})
				).pipe(
					Effect.mapError(() => new ProviderUnavailable({ message: 'WeChat media request failed' }))
				);
			const media = Effect.fn('WeChat.media')(function* (
				value: Cred,
				id: string,
				fresh = false
			): Effect.fn.Return<Download, ProviderFailure> {
				const got = yield* download(
					HttpClientRequest.get(`${API}/cgi-bin/media/get`, {
						urlParams: { access_token: yield* accessToken(value, fresh), media_id: id }
					})
				);
				if (!/json|text\/plain/.test(got.type)) return got;
				const answer = Option.getOrUndefined(decodeMedia(new TextDecoder().decode(got.body)));
				if (answer?.video_url !== undefined)
					return yield* download(HttpClientRequest.get(answer.video_url));
				if (!fresh && (answer?.errcode === 40001 || answer?.errcode === 42001))
					return yield* media(value, id, true);
				return yield* Effect.fail(
					new ProviderUnavailable({ message: `WeChat media/get: ${answer?.errcode ?? got.type}` })
				);
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
					// the API answers no id, and a retry of this message must name the same one
					return { providerId: `wx-${m.id}` };
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
					const parsed = wechatMessage(plain.value);
					if (parsed === null) return new Response('success');
					const file = parsed.media;
					// the platform gives up after five seconds and delivers again: a file not held by then stays named
					const got =
						file === null
							? null
							: yield* media(value, file.id).pipe(
									Effect.timeoutOption('3 seconds'),
									Effect.map(Option.getOrNull),
									Effect.tapCause(Effect.logWarning),
									Effect.orElseSucceed(() => null)
								);
					const message =
						file === null || got === null
							? parsed.message
							: {
									...parsed.message,
									attachments: [
										{
											name: file.name,
											mime: got.type.split(';')[0] || file.mime,
											bytes: got.body.byteLength,
											bin: 0
										}
									]
								};
					yield* hostCall('store WeChat message', () =>
						ctx.emit({
							kind: 'messages',
							messages: [message],
							...(got === null ? {} : { bins: [got.body] })
						})
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

/** The file a message names by `MediaId`, which the link downloads before it emits the event. */
export type WechatMedia = { id: string; name: string; mime: string };
const lines = (...parts: readonly (string | null)[]) =>
	parts.filter((part) => part !== null && part !== '').join('\n');

/**
 * One decrypted message → the wire message and its file; `null` for events (follow, menu clicks), which are no message.
 * The platform redelivers for three retries: `MsgId` keys them, `FromUserName` and `CreateTime` where a push has none.
 */
export function wechatMessage(xml: string): { message: Obj; media: WechatMedia | null } | null {
	const type = xmlField(xml, 'MsgType'),
		from = xmlField(xml, 'FromUserName'),
		at = Number(xmlField(xml, 'CreateTime')),
		mediaId = xmlField(xml, 'MediaId');
	if (type === null || type === 'event' || from === null || !Number.isFinite(at)) return null;
	const id = xmlField(xml, 'MsgId') ?? `${from}:${at}`,
		format = xmlField(xml, 'Format')?.toLowerCase() ?? 'amr',
		[mime, extension] =
			type === 'image'
				? ['image/jpeg', 'jpg']
				: type === 'voice'
					? [`audio/${format}`, format]
					: ['video/mp4', 'mp4'];
	const media = mediaId === null ? null : { id: mediaId, name: `wechat-${id}.${extension}`, mime };
	return {
		media,
		message: {
			id,
			thread: from,
			sentAt: new Date(at * 1000).toISOString(),
			from: { handle: from, name: null },
			text:
				type === 'location'
					? lines(
							xmlField(xml, 'Label'),
							`${xmlField(xml, 'Location_X')}, ${xmlField(xml, 'Location_Y')}`
						)
					: type === 'link'
						? lines(xmlField(xml, 'Title'), xmlField(xml, 'Description'), xmlField(xml, 'Url'))
						: (xmlField(xml, 'Content') ?? ''),
			group: false,
			invocation: 'direct',
			replyTo: null,
			attachments: media === null ? [] : [{ name: media.name, mime, bytes: 0 }]
		}
	};
}
