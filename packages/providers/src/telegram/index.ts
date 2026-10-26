// Telegram bot pairing and delivery through the instance's guarded HttpClient.
import { createHash } from 'node:crypto';
import { Effect, Option, Predicate, Schema } from 'effect';
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http';
import type { DriverOpen, Json, OutboundAttachment } from '@norbital-ai/bolt/engine';
import type { ProviderDef } from '../abi.ts';
import { answerFailure, ProviderUnavailable } from '../errors.ts';
import {
	blobOf,
	field,
	hostCall,
	same,
	str,
	storedCredential,
	withFetch,
	type Obj
} from '../util.ts';

const API = 'https://api.telegram.org';
const MEDIA_MAX = 20 * 1024 * 1024;
const Credential = Schema.Struct({ token: Schema.NonEmptyString });
const BotSchema = Schema.Struct({ id: Schema.Number, username: Schema.optionalKey(Schema.String) });
const Answer = Schema.Struct({
	ok: Schema.Boolean,
	result: Schema.optionalKey(Schema.Unknown),
	description: Schema.optionalKey(Schema.String),
	error_code: Schema.optionalKey(Schema.Number)
});
const Sent = Schema.Struct({ message_id: Schema.Number });
const File = Schema.Struct({ file_path: Schema.String });
const Message = Schema.Struct({ to: Schema.NonEmptyString, text: Schema.String });
type Bot = { id?: number; username?: string };

export function telegram(): ProviderDef {
	return {
		_tag: 'ProviderDef',
		driver: 'telegram',
		id: 'bot',
		label: { en: 'Telegram bot', zh: 'Telegram 机器人' },
		setup: {
			kind: 'form',
			steps: [
				{
					text: {
						en: 'In Telegram, open @BotFather and send /newbot; choose a name and a username ending in "bot".',
						zh: '在 Telegram 中打开 @BotFather 并发送 /newbot；选择一个名称和以 “bot” 结尾的用户名。'
					},
					href: 'https://t.me/BotFather'
				},
				{
					text: {
						en: 'Copy the token BotFather answers with and paste it below. This host registers its webhook with Telegram itself.',
						zh: '复制 BotFather 回复的令牌并粘贴到下方。本主机会自行向 Telegram 注册 Webhook。'
					}
				},
				{
					text: {
						en: 'For groups: add the bot to the group; it answers when mentioned or replied to.',
						zh: '群组：将机器人加入群组；被提及或被回复时它会应答。'
					}
				}
			],
			fields: [
				{
					name: 'token',
					label: { en: 'Bot token', zh: '机器人令牌' },
					secret: true,
					hint: '123456789:AA…'
				}
			]
		},
		test: {
			to: {
				name: 'to',
				label: { en: 'Chat id', zh: '聊天 ID' },
				hint: {
					en: 'Your chat id with the bot: message it first',
					zh: '您与机器人的聊天 ID：请先给它发一条消息'
				}
			}
		},
		open: Effect.fn('Telegram.open')(function* (ctx: DriverOpen) {
			const stored = yield* storedCredential(ctx, Credential);
			let token: string | null = Option.isSome(stored) ? stored.value.token : null;
			let bot: Bot = {};
			const secret = (value: string) =>
				createHash('sha256').update(`bolt-telegram\u0000${value}`).digest('hex');
			const call = <A>(
				schema: Schema.Decoder<A>,
				value: string,
				method: string,
				body: Json | FormData
			) =>
				withFetch(
					ctx,
					Effect.gen(function* () {
						const request = HttpClientRequest.post(`${API}/bot${value}/${method}`);
						const response = yield* HttpClient.execute(
							body instanceof FormData
								? request.pipe(HttpClientRequest.bodyFormData(body))
								: request.pipe(HttpClientRequest.bodyJsonUnsafe(body))
						).pipe(
							Effect.mapError(
								() => new ProviderUnavailable({ message: `Telegram ${method}: request failed` })
							)
						);
						const answer = yield* HttpClientResponse.schemaBodyJson(Answer)(response).pipe(
							Effect.mapError(
								() => new ProviderUnavailable({ message: `Telegram ${method}: invalid response` })
							)
						);
						if (!answer.ok)
							return yield* Effect.fail(
								answerFailure(
									`Telegram ${method}: ${answer.description ?? response.status}`,
									answer.error_code ?? response.status
								)
							);
						return yield* Schema.decodeUnknownEffect(schema)(answer.result).pipe(
							Effect.mapError(
								() => new ProviderUnavailable({ message: `Telegram ${method}: invalid result` })
							)
						);
					})
				);
			const connected = () =>
				hostCall('report Telegram status', () =>
					ctx.status({
						state: 'connected',
						account: bot.username === undefined ? null : `@${bot.username}`,
						about: bot.username === undefined ? {} : { botName: `@${bot.username}` }
					})
				);
			const activate = Effect.fn('Telegram.activate')(function* (value: string) {
				bot = yield* call(BotSchema, value, 'getMe', {});
				yield* call(Schema.Boolean, value, 'setWebhook', {
					url: ctx.webhookUrl,
					secret_token: secret(value),
					allowed_updates: ['message', 'edited_message']
				});
			});
			if (token !== null)
				yield* activate(token).pipe(
					Effect.andThen(connected),
					Effect.catch((error) =>
						hostCall('report Telegram status', () =>
							ctx.status({
								state: 'error',
								error: `${error.message} — pair again with a working token`
							})
						)
					)
				);
			const need = () =>
				token === null
					? Effect.fail(new ProviderUnavailable({ message: 'the Telegram bot is not connected' }))
					: Effect.succeed(token);
			return {
				pair: Effect.fn('Telegram.pair')(function* (input: Json) {
					const value = yield* field(input, 'token', 'The bot token', /^\d+:[\w-]+$/);
					yield* activate(value);
					yield* hostCall('store Telegram credential', () =>
						ctx.credentials.write(new Map([['credential', { token: value }]]))
					);
					token = value;
					yield* connected();
				}),
				unpair: () =>
					Effect.gen(function* () {
						if (token !== null)
							yield* call(Schema.Boolean, token, 'deleteWebhook', {}).pipe(
								Effect.tapCause(Effect.logWarning),
								Effect.ignore
							);
						token = null;
					}),
				close: Effect.void,
				send: Effect.fn('Telegram.send')(function* (
					message: Json,
					files: readonly OutboundAttachment[] = []
				) {
					const m = yield* Schema.decodeUnknownEffect(Message)(message).pipe(
						Effect.mapError(() => answerFailure('a Telegram message needs `to` and `text`', 400))
					);
					const value = yield* need();
					const [chat = '', , thread] = m.to.split(':');
					const sent = yield* call(Sent, value, 'sendMessage', {
						chat_id: chat,
						text: m.text,
						...(thread === undefined ? {} : { message_thread_id: Number(thread) })
					});
					for (const file of files) {
						const form = new FormData();
						form.set('chat_id', chat);
						form.set('document', blobOf(file), file.name);
						if (thread !== undefined) form.set('message_thread_id', thread);
						yield* call(Sent, value, 'sendDocument', form);
					}
					return { providerId: `${chat}:${sent.message_id}` };
				}),
				typing: (to: string) =>
					Effect.gen(function* () {
						const [chat = '', , thread] = to.split(':');
						yield* call(Schema.Boolean, yield* need(), 'sendChatAction', {
							chat_id: chat,
							action: 'typing',
							...(thread === undefined ? {} : { message_thread_id: Number(thread) })
						});
					}),
				webhook: Effect.fn('Telegram.webhook')(function* (request: Request) {
					if (
						token === null ||
						!same(request.headers.get('x-telegram-bot-api-secret-token') ?? '', secret(token))
					)
						return new Response(null, { status: 401 });
					const payload = yield* Effect.tryPromise({
						try: () => request.json(),
						catch: () => new ProviderUnavailable({ message: 'Telegram update is not JSON' })
					}).pipe(Effect.orElseSucceed(() => null));
					const parsed = telegramUpdate(payload, bot);
					if (parsed === null) return new Response(null, { status: 200 });
					const bins: Uint8Array[] = [];
					let message: Json = parsed.message;
					if (parsed.media !== null) {
						const media = parsed.media,
							value = token;
						yield* withFetch(
							ctx,
							Effect.gen(function* () {
								const file = yield* call(File, value, 'getFile', { file_id: media.fileId });
								const response = yield* HttpClient.get(
									`${API}/file/bot${value}/${file.file_path}`
								).pipe(
									Effect.mapError(
										() => new ProviderUnavailable({ message: 'Telegram media request failed' })
									)
								);
								const bytes = new Uint8Array(
									yield* response.arrayBuffer.pipe(
										Effect.mapError(
											() => new ProviderUnavailable({ message: 'Telegram media body failed' })
										)
									)
								);
								if (response.status < 400 && bytes.byteLength <= MEDIA_MAX) {
									bins.push(bytes);
									message = {
										...parsed.message,
										attachments: [
											{ name: media.name, mime: media.mime, bytes: bytes.byteLength, bin: 0 }
										]
									};
								}
							})
						).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
					}
					yield* hostCall('store Telegram update', () =>
						ctx.emit({
							kind: 'messages',
							messages: [message],
							...(bins.length === 0 ? {} : { bins })
						})
					);
					return new Response(null, { status: 200 });
				})
			};
		})
	};
}

/** Media the link downloads through the Bot API before it emits the event (its bytes become a `bin`). */
export type TelegramMedia = { fileId: string; name: string; mime: string };
/** One Bot API update → the wire message (`message` or `edited_message`), or `null` for updates the link ignores. */
export function telegramUpdate(
	update: unknown,
	bot: Bot
): { message: Obj; media: TelegramMedia | null } | null {
	if (!Predicate.isObject(update)) return null;
	const edited = Predicate.isObject(update['edited_message']);
	const msg = edited ? update['edited_message'] : update['message'];
	if (
		!Predicate.isObject(msg) ||
		!Predicate.isObject(msg['chat']) ||
		typeof msg['message_id'] !== 'number' ||
		typeof msg['date'] !== 'number'
	)
		return null;
	const chat = msg['chat'],
		chatId = String(chat['id']);
	const group = chat['type'] !== 'private';
	const text =
		typeof msg['text'] === 'string'
			? msg['text']
			: typeof msg['caption'] === 'string'
				? msg['caption']
				: '';
	const from = Predicate.isObject(msg['from']) ? msg['from'] : {};
	const name = [from['first_name'], from['last_name']]
		.filter((p) => typeof p === 'string' && p !== '')
		.join(' ');
	const thread =
		msg['is_topic_message'] === true && typeof msg['message_thread_id'] === 'number'
			? `${chatId}:thread:${msg['message_thread_id']}`
			: chatId;
	const reply = Predicate.isObject(msg['reply_to_message']) ? msg['reply_to_message'] : null;
	const sentAt = new Date(msg['date'] * 1000).toISOString();
	const doc = [msg['document'], msg['video'], msg['audio'], msg['voice']].find(Predicate.isObject);
	const photo = Array.isArray(msg['photo']) ? msg['photo'].at(-1) : undefined;
	const media: TelegramMedia | null =
		doc !== undefined && typeof doc['file_id'] === 'string'
			? {
					fileId: doc['file_id'],
					name: str(doc['file_name']) ?? `file-${doc['file_id']}`,
					mime: str(doc['mime_type']) ?? 'application/octet-stream'
				}
			: Predicate.isObject(photo) && typeof photo['file_id'] === 'string'
				? { fileId: photo['file_id'], name: `photo-${photo['file_id']}.jpg`, mime: 'image/jpeg' }
				: null;
	return {
		media,
		message: {
			// a Bot API message id is per chat, so the chat is part of the provider id
			id: `${chatId}:${msg['message_id']}`,
			thread,
			sentAt,
			text,
			group,
			...(group && str(chat['title']) !== null ? { title: str(chat['title']) } : {}),
			from: { handle: String(from['id'] ?? ''), name: name === '' ? null : name },
			replyTo:
				reply !== null && typeof reply['message_id'] === 'number'
					? `${chatId}:${reply['message_id']}`
					: null,
			invocation: group ? invocationOf(msg, text, bot) : 'direct',
			...(edited
				? {
						version: new Date(
							(typeof msg['edit_date'] === 'number' ? msg['edit_date'] : msg['date']) * 1000
						).toISOString()
					}
				: {}),
			attachments: []
		}
	};
}
function invocationOf(
	msg: Readonly<Record<string, unknown>>,
	text: string,
	bot: Bot
): 'mention' | 'reply' | 'ambient' {
	const handle = bot.username === undefined ? undefined : `@${bot.username.toLowerCase()}`;
	for (const e of (Array.isArray(msg['entities'])
		? msg['entities']
		: Array.isArray(msg['caption_entities'])
			? msg['caption_entities']
			: []
	).filter(Predicate.isObject)) {
		const part = text
			.slice(Number(e['offset'] ?? 0), Number(e['offset'] ?? 0) + Number(e['length'] ?? 0))
			.toLowerCase();
		if (e['type'] === 'mention' && handle !== undefined && part === handle) return 'mention';
		if (e['type'] === 'text_mention' && Predicate.isObject(e['user']) && e['user']['id'] === bot.id)
			return 'mention';
		if (e['type'] === 'bot_command' && handle !== undefined && part.endsWith(handle))
			return 'mention';
	}
	const reply = msg['reply_to_message'];
	return Predicate.isObject(reply) &&
		Predicate.isObject(reply['from']) &&
		bot.id !== undefined &&
		reply['from']['id'] === bot.id
		? 'reply'
		: 'ambient';
}
