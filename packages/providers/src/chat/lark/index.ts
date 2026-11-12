// Lark and Feishu, through their own SDK's client and message normalizer. Deliveries are event webhooks, so the app needs
// an Encrypt Key: that is what the signature covers. A recall names no sender or thread. No event for an edit exists in
// the SDK, so `history` carries those, and a send's `uuid` makes a resend safe for the hour Lark keeps it.
import { Predicate, Schema } from 'effect';
import { parse as parseJson } from '../http.ts';
import { createHash } from 'node:crypto';
import type { normalize } from '@larksuiteoapi/node-sdk';
import type { ChatConnection, ChatPlatform, Incoming } from '../adapter.ts';
import { nothing, PlatformError, Unverified } from '../adapter.ts';
import { same, signed } from '../verify.ts';

const UUID_MAX = 50;
const PAGES = 10;
type Raw = Parameters<typeof normalize>[0];
const Envelope = Schema.Struct({
	type: Schema.optionalKey(Schema.String),
	token: Schema.optionalKey(Schema.String),
	challenge: Schema.optionalKey(Schema.String),
	header: Schema.optionalKey(Schema.Struct({ event_type: Schema.optionalKey(Schema.String) })),
	event: Schema.optionalKey(Schema.Json)
});
const UserId = Schema.Struct({
	open_id: Schema.optionalKey(Schema.String),
	user_id: Schema.optionalKey(Schema.String),
	union_id: Schema.optionalKey(Schema.String)
});
const Raw: Schema.Codec<Raw> = Schema.Struct({
	sender: Schema.Struct({
		sender_id: UserId,
		sender_type: Schema.optionalKey(Schema.String),
		tenant_key: Schema.optionalKey(Schema.String)
	}),
	message: Schema.Struct({
		message_id: Schema.String,
		root_id: Schema.optionalKey(Schema.String),
		parent_id: Schema.optionalKey(Schema.String),
		create_time: Schema.optionalKey(Schema.String),
		update_time: Schema.optionalKey(Schema.String),
		chat_id: Schema.String,
		thread_id: Schema.optionalKey(Schema.String),
		chat_type: Schema.Literals(['p2p', 'group']),
		message_type: Schema.String,
		content: Schema.String,
		mentions: Schema.optionalKey(
			Schema.Array(
				Schema.Struct({
					key: Schema.String,
					id: UserId,
					name: Schema.optionalKey(Schema.String),
					tenant_key: Schema.optionalKey(Schema.String)
				})
			).pipe(Schema.mutable)
		)
	})
});
const MIME: Readonly<Record<string, string>> = {
	image: 'image/*',
	sticker: 'image/*',
	audio: 'audio/*',
	video: 'video/*'
};

/** Lark answers a refusal with an HTTP error or a 200 and a `code`. A code says nothing of permanence, so it is retried. */
const answered = async <A extends { code?: number | undefined; msg?: string | undefined }>(
	work: Promise<A>
) => {
	const answer = await work.catch((error: unknown) => {
		const response = Predicate.hasProperty(error, 'response') ? error.response : undefined;
		const status =
			Predicate.hasProperty(response, 'status') && typeof response.status === 'number'
				? response.status
				: undefined;
		throw status === undefined ? error : new PlatformError(`Lark answered ${status}`, status);
	});
	if ((answer.code ?? 0) !== 0)
		throw new PlatformError(`Lark ${answer.code}: ${answer.msg ?? 'refused'}`, 502);
	return answer;
};

export const lark: ChatPlatform = {
	id: 'lark',
	name: { en: 'Lark / Feishu', zh: '飞书 / Lark' },
	description: { en: 'Lark and Feishu chats', zh: '飞书与 Lark 会话' },
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'history',
	idempotent: true,
	guide: 'https://open.feishu.cn/document/server-docs/event-subscription-guide/overview',
	fields: [
		{ name: 'appId', label: { en: 'App ID', zh: '应用 ID' } },
		{ name: 'appSecret', label: { en: 'App secret', zh: '应用密钥' }, secret: true },
		{ name: 'encryptKey', label: { en: 'Encrypt key', zh: 'Encrypt Key' }, secret: true },
		{
			name: 'verificationToken',
			label: { en: 'Verification token', zh: 'Verification Token' },
			secret: true
		},
		{
			name: 'domain',
			label: { en: 'Enter lark for Lark, blank for Feishu', zh: 'Lark 请填 lark，飞书留空' },
			optional: true
		}
	],
	async connect({
		appId = '',
		appSecret = '',
		encryptKey = '',
		verificationToken = '',
		domain = ''
	}) {
		const sdk = await import('@larksuiteoapi/node-sdk');
		const client = new sdk.Client({
			appId,
			appSecret,
			domain: domain.trim().toLowerCase() === 'lark' ? sdk.Domain.Lark : sdk.Domain.Feishu,
			loggerLevel: sdk.LoggerLevel.error
		});
		const cipher = new sdk.AESCipher(encryptKey);
		const { bot } = await answered<{
			code?: number;
			msg?: string;
			bot?: { open_id?: string; app_name?: string };
		}>(client.request({ url: '/open-apis/bot/v3/info', method: 'GET' }));
		const openId = bot?.open_id;
		if (openId === undefined) throw new PlatformError('Lark names no bot for this app', 401);
		const content = async (message_id: string, file_key: string, type: string) => {
			const resource = await client.im.v1.messageResource.get({
				path: { message_id, file_key },
				params: { type }
			});
			const chunks: Buffer[] = [];
			for await (const chunk of resource.getReadableStream()) chunks.push(Buffer.from(chunk));
			return new Uint8Array(Buffer.concat(chunks));
		};
		const parse = async (event: Raw): Promise<Incoming | null> => {
			if (event.sender.sender_type !== 'user') return null;
			const message = await sdk.normalize(event, {
				botIdentity: { openId, name: bot?.app_name ?? 'bot' }
			});
			const { messageId, chatId, rootId, threadId } = message;
			return {
				id: messageId,
				thread: threadId === undefined ? chatId : `${chatId}:${rootId ?? messageId}:${threadId}`,
				sent_at: new Date(message.createTime).toISOString(),
				from: { handle: message.senderId, name: message.senderName ?? null },
				text: message.content,
				group: message.chatType !== 'p2p',
				mentioned: message.mentionedBot,
				reply_to: message.replyToMessageId ?? null,
				files: message.resources.map(({ type, fileKey, fileName }) => ({
					name: fileName ?? fileKey,
					mime: MIME[type] ?? 'application/octet-stream',
					fetch: () => content(messageId, fileKey, type === 'image' ? 'image' : 'file')
				}))
			};
		};
		const answersBot = async (parent: string) => {
			const found = await answered(
				client.im.v1.message.get({ path: { message_id: parent } })
			).catch(() => null);
			return found?.data?.items?.[0]?.sender?.id === appId;
		};
		const connection: ChatConnection = {
			account: bot?.app_name ?? openId,
			async deliver(request, body) {
				const { encrypt } = await parseJson(
					Schema.Struct({ encrypt: Schema.optionalKey(Schema.String) }),
					body
				);
				if (encrypt === undefined) throw new Unverified('not encrypted');
				let plain: typeof Envelope.Type;
				try {
					plain = await parseJson(Envelope, cipher.decrypt(encrypt));
				} catch {
					throw new Unverified('not this app');
				}
				if (plain.type === 'url_verification') {
					if (plain.token === undefined || !same(plain.token, verificationToken))
						throw new Unverified('bad token');
					return nothing(Response.json({ challenge: plain.challenge }));
				}
				const stamp = `${request.headers.get('x-lark-request-timestamp')}${request.headers.get('x-lark-request-nonce')}`;
				signed(
					request.headers.get('x-lark-signature'),
					createHash('sha256').update(`${stamp}${encryptKey}${body}`).digest('hex')
				);
				const type = plain.header?.event_type,
					event = plain.event;
				if (event === undefined) return nothing();
				if (type === 'im.message.recalled_v1') {
					const { message_id } = await Schema.decodeUnknownPromise(
						Schema.Struct({ message_id: Schema.String })
					)(event);
					return {
						messages: [
							{
								id: message_id,
								thread: '',
								sent_at: new Date().toISOString(),
								from: { handle: '', name: null },
								text: '',
								deleted: true
							}
						]
					};
				}
				if (type !== 'im.message.receive_v1') return nothing();
				const message = await parse(await Schema.decodeUnknownPromise(Raw)(event));
				if (message === null) return nothing();
				const parent = message.group ? message.reply_to : null;
				return {
					messages: [{ ...message, replied_to: parent != null && (await answersBot(parent)) }]
				};
			},
			async send(thread, text, key) {
				const [chat = '', root] = thread.split(':');
				const data = {
					content: JSON.stringify({ text }),
					msg_type: 'text',
					uuid: createHash('sha256').update(key).digest('hex').slice(0, UUID_MAX)
				};
				const sent = await answered(
					root === undefined
						? client.im.v1.message.create({
								params: { receive_id_type: chat.startsWith('ou_') ? 'open_id' : 'chat_id' },
								data: { ...data, receive_id: chat }
							})
						: client.im.v1.message.reply({
								path: { message_id: root },
								data: { ...data, reply_in_thread: true }
							})
				);
				return { id: sent.data?.message_id ?? key };
			},
			async history(thread, since) {
				const [chat_id = '', , topic] = thread.split(':');
				const about = await answered(client.im.v1.chat.get({ path: { chat_id } }));
				const chat_type = about.data?.chat_mode === 'p2p' ? 'p2p' : 'group',
					messages: Incoming[] = [];
				const pages = await client.im.v1.message.listWithIterator({
					params: {
						container_id_type: topic === undefined ? 'chat' : 'thread',
						container_id: topic ?? chat_id,
						start_time: String(Math.floor(Date.parse(since) / 1000)),
						sort_type: 'ByCreateTimeAsc'
					}
				});
				let page = 0;
				for await (const items of pages) {
					if (page++ === PAGES) return { messages, complete: false };
					for (const item of items?.items ?? []) {
						if (item.message_id === undefined || item.sender === undefined) continue;
						const message = await parse({
							sender: {
								sender_id: { open_id: item.sender.id },
								sender_type: item.sender.sender_type
							},
							message: {
								message_id: item.message_id,
								...(item.root_id === undefined ? {} : { root_id: item.root_id }),
								...(item.parent_id === undefined ? {} : { parent_id: item.parent_id }),
								...(item.thread_id === undefined ? {} : { thread_id: item.thread_id }),
								...(item.create_time === undefined ? {} : { create_time: item.create_time }),
								chat_id,
								chat_type,
								message_type: item.msg_type ?? 'text',
								content: item.body?.content ?? '{}',
								mentions: (item.mentions ?? []).map(({ key, id, name }) => ({
									key,
									id: { open_id: id },
									name
								}))
							}
						});
						if (message === null || message.thread !== thread) continue;
						messages.push(
							item.deleted === true
								? { ...message, text: '', deleted: true, files: [] }
								: item.updated === true && item.update_time !== undefined
									? { ...message, version: new Date(Number(item.update_time)).toISOString() }
									: message
						);
					}
				}
				return { messages, complete: true };
			}
		};
		return connection;
	}
};
