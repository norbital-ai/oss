// WeCom (企业微信), through a self-built app's API: no WeCom SDK is installed. A person writes to the app, so every thread
// is one person, in direct. The callback is the same safe mode as WeChat's. WeCom offers no history, typing, edit or
// delete event, and its duplicate check compares content rather than a key, so a send is not idempotent.
import { Schema } from 'effect';
import type { ChatConnection, ChatPlatform } from '../adapter.ts';
import { nothing, PlatformError, Unverified } from '../adapter.ts';
import { signed } from '../verify.ts';
import { wechatDecrypt, wechatSignature, xmlField } from '../../wechat/index.ts';

const API = 'https://qyapi.weixin.qq.com';
const TOKEN_EARLY_MS = 300_000;
const TOKEN_LIFE_S = 7200;
const FILE_MIME: Readonly<Record<string, string>> = {
	image: 'image/*',
	voice: 'audio/*',
	video: 'video/*'
};
const Answer = Schema.Struct({
	errcode: Schema.Number,
	errmsg: Schema.optionalKey(Schema.String)
});

export const wecom: ChatPlatform = {
	id: 'wecom',
	name: { en: 'WeCom', zh: '企业微信' },
	description: { en: 'WeCom app messages', zh: '企业微信应用消息' },
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'webhook',
	guide: 'https://developer.work.weixin.qq.com/',
	fields: [
		{ name: 'corpId', label: { en: 'Corp ID', zh: '企业 ID' } },
		{ name: 'corpSecret', label: { en: 'App secret', zh: '应用 Secret' }, secret: true },
		{ name: 'agentId', label: { en: 'Agent ID', zh: '应用 AgentId' } },
		{ name: 'token', label: { en: 'Callback token', zh: '回调 Token' }, secret: true },
		{
			name: 'encodingAESKey',
			label: { en: 'Callback EncodingAESKey', zh: '回调 EncodingAESKey' },
			secret: true
		}
	],
	async connect(
		{ corpId = '', corpSecret = '', agentId = '', token = '', encodingAESKey = '' },
		host
	) {
		if (Buffer.from(`${encodingAESKey}=`, 'base64').length !== 32)
			throw new PlatformError('EncodingAESKey must be 43 characters', 400);
		if (!Number.isInteger(Number(agentId)))
			throw new PlatformError('Agent ID must be a number', 400);
		let cached: { readonly value: string; readonly until: number } | null = null;
		const url = (path: string, query: Readonly<Record<string, string>>) => {
			const made = new URL(path, API);
			for (const [name, value] of Object.entries(query)) made.searchParams.set(name, value);
			return made;
		};
		// WeCom answers a refusal with 200 and an `errcode`; a refusal may be a revoked token, so the next call fetches one
		const answered = async <A>(schema: Schema.Decoder<A>, response: Response) => {
			if (!response.ok)
				throw new PlatformError(`WeCom answered ${response.status}`, response.status);
			const raw: unknown = await response.json();
			const answer = await Schema.decodeUnknownPromise(Answer)(raw);
			if (answer.errcode === 0) return Schema.decodeUnknownPromise(schema)(raw);
			cached = null;
			throw new PlatformError(`WeCom ${answer.errcode}: ${answer.errmsg ?? 'refused'}`, 502);
		};
		const accessToken = async () => {
			if (cached !== null && Date.now() < cached.until) return cached.value;
			const { access_token, expires_in } = await answered(
				Schema.Struct({
					access_token: Schema.String,
					expires_in: Schema.optionalKey(Schema.Number)
				}),
				await host.fetch(url('/cgi-bin/gettoken', { corpid: corpId, corpsecret: corpSecret }))
			);
			cached = {
				value: access_token,
				until: Date.now() + (expires_in ?? TOKEN_LIFE_S) * 1000 - TOKEN_EARLY_MS
			};
			return access_token;
		};
		await accessToken();
		const verified = (query: URLSearchParams, encrypted: string) => {
			signed(
				query.get('msg_signature'),
				wechatSignature(token, query.get('timestamp') ?? '', query.get('nonce') ?? '', encrypted)
			);
			try {
				return wechatDecrypt(encrypted, encodingAESKey, corpId);
			} catch {
				throw new Unverified('not this app');
			}
		};
		const media = async (id: string) => {
			const response = await host.fetch(
				url('/cgi-bin/media/get', { access_token: await accessToken(), media_id: id })
			);
			// a refusal is JSON, however it is carried
			if (!response.ok || response.headers.get('content-type')?.includes('json') === true)
				await answered(Schema.Unknown, response);
			return new Uint8Array(await response.arrayBuffer());
		};
		const connection: ChatConnection = {
			account: corpId,
			async deliver(request, body) {
				const query = new URL(request.url).searchParams;
				if (request.method === 'GET')
					return nothing(new Response(verified(query, query.get('echostr') ?? '')));
				const xml = verified(query, xmlField(body, 'Encrypt') ?? '');
				const type = xmlField(xml, 'MsgType') ?? '',
					id = xmlField(xml, 'MsgId'),
					from = xmlField(xml, 'FromUserName'),
					mediaId = xmlField(xml, 'MediaId');
				if (type === 'event' || id === null || from === null) return nothing();
				return {
					messages: [
						{
							id,
							thread: from,
							sentAt: new Date(Number(xmlField(xml, 'CreateTime')) * 1000).toISOString(),
							from: { handle: from, name: null },
							text:
								xmlField(xml, 'Content') ??
								xmlField(xml, 'Recognition') ??
								xmlField(xml, 'Title') ??
								xmlField(xml, 'Label') ??
								'',
							files:
								mediaId === null
									? []
									: [
											{
												name: xmlField(xml, 'FileName') ?? `wecom-${id}`,
												mime: FILE_MIME[type] ?? 'application/octet-stream',
												fetch: () => media(mediaId)
											}
										]
						}
					]
				};
			},
			async send(thread, text, key) {
				const sent = await answered(
					Schema.Struct({
						msgid: Schema.optionalKey(Schema.String)
					}),
					await host.fetch(url('/cgi-bin/message/send', { access_token: await accessToken() }), {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							touser: thread,
							agentid: Number(agentId),
							msgtype: 'text',
							text: { content: text }
						})
					})
				);
				return { id: sent.msgid ?? key };
			}
		};
		return connection;
	}
};
