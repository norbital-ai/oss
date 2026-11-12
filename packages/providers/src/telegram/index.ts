// Telegram bot pairing and delivery through the instance's guarded HttpClient.
import { createHash } from 'node:crypto';
import { Effect, Option, Predicate, Schema } from 'effect';
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';
import type { DriverOpen, Json, OutboundAttachment } from '@norbital-ai/bolt/engine';
import type { ProviderDef } from '../abi.ts';
import { answerFailure, notConnected, ProviderUnavailable } from '../errors.ts';
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
const UpdateMessage = Schema.StructWithRest(
	Schema.Struct({
		message_id: Schema.Number,
		date: Schema.Number,
		chat: Schema.Struct({
			id: Schema.Number,
			type: Schema.String,
			title: Schema.optionalKey(Schema.String)
		}),
		from: Schema.optionalKey(
			Schema.Struct({
				id: Schema.Number,
				first_name: Schema.optionalKey(Schema.String),
				last_name: Schema.optionalKey(Schema.String)
			})
		),
		text: Schema.optionalKey(Schema.String),
		caption: Schema.optionalKey(Schema.String),
		is_topic_message: Schema.optionalKey(Schema.Boolean),
		message_thread_id: Schema.optionalKey(Schema.Number),
		reply_to_message: Schema.optionalKey(
			Schema.Struct({
				message_id: Schema.Number,
				from: Schema.optionalKey(Schema.Struct({ id: Schema.Number }))
			})
		),
		edit_date: Schema.optionalKey(Schema.Number)
	}),
	[Schema.Record(Schema.String, Schema.Unknown)]
);
const Update = Schema.decodeUnknownOption(
	Schema.Struct({
		message: Schema.optionalKey(UpdateMessage),
		edited_message: Schema.optionalKey(UpdateMessage)
	})
);

export function telegram(o: { readonly api?: string } = {}): ProviderDef {
	const api = o.api ?? API;
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
						const request = HttpClientRequest.post(`${api}/bot${value}/${method}`);
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
					url: ctx.webhook_url,
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
					? Effect.fail(notConnected('the Telegram bot'))
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
					return { provider_id: `${chat}:${sent.message_id}` };
				}),
				// a chat action lapses by itself (5 s): there is nothing to send to stop it
				typing: (to: string, on: boolean) =>
					Effect.gen(function* () {
						if (!on) return;
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
									`${api}/file/bot${value}/${file.file_path}`
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
export type TelegramMedia = { fileId: string; name: string; mime: string; bytes?: number };
/** One Bot API update → the wire message (`message` or `edited_message`), or `null` for updates the link ignores. */
export function telegramUpdate(
	update: unknown,
	bot: Bot
): { message: Obj; media: TelegramMedia | null } | null {
	const decoded = Update(update);
	if (decoded._tag === 'None') return null;
	const edited = decoded.value.edited_message !== undefined;
	const msg = decoded.value.edited_message ?? decoded.value.message;
	if (msg === undefined) return null;
	const chat = msg.chat,
		chatId = String(chat.id);
	const group = chat.type !== 'private';
	const text = msg.text ?? msg.caption ?? '';
	const name = [msg.from?.first_name, msg.from?.last_name]
		.filter((p) => p !== undefined && p !== '')
		.join(' ');
	const thread =
		msg.is_topic_message === true && msg.message_thread_id !== undefined
			? `${chatId}:thread:${msg.message_thread_id}`
			: chatId;
	const sent_at = new Date(msg.date * 1000).toISOString();
	const media = mediaOf(msg);
	return {
		media,
		message: {
			// a Bot API message id is per chat, so the chat is part of the provider id
			id: `${chatId}:${msg.message_id}`,
			thread,
			sent_at,
			text: text === '' ? said(msg) : text,
			group,
			...(group && str(chat.title) !== null ? { title: str(chat.title) } : {}),
			from: { handle: String(msg.from?.id ?? ''), name: name === '' ? null : name },
			reply_to:
				msg.reply_to_message === undefined ? null : `${chatId}:${msg.reply_to_message.message_id}`,
			invocation: group ? invocationOf(msg, text, bot) : 'direct',
			...(edited
				? {
						version: new Date((msg.edit_date ?? msg.date) * 1000).toISOString()
					}
				: {}),
			// named before its bytes: a file getFile refuses (over 20 MB) or a failed download stays on the message
			attachments:
				media === null ? [] : [{ name: media.name, mime: media.mime, bytes: media.bytes ?? 0 }]
		}
	};
}
/** A message's one file. `animation` also fills `document`, so the older field is enough for the same file. */
function mediaOf(msg: Readonly<Record<string, unknown>>): TelegramMedia | null {
	const sticker = Predicate.isObject(msg['sticker']) ? msg['sticker'] : {};
	const [mime, extension] =
		sticker['is_video'] === true
			? ['video/webm', '.webm']
			: sticker['is_animated'] === true
				? ['application/x-tgsticker', '.tgs']
				: ['image/webp', '.webp'];
	const photo = Array.isArray(msg['photo']) ? msg['photo'].at(-1) : undefined;
	for (const [file, fallback, suffix] of [
		[msg['document'], 'application/octet-stream', ''],
		[msg['animation'], 'video/mp4', '.mp4'],
		[msg['video'], 'video/mp4', '.mp4'],
		[msg['audio'], 'audio/mpeg', '.mp3'],
		[msg['voice'], 'audio/ogg', '.ogg'],
		[msg['video_note'], 'video/mp4', '.mp4'],
		[msg['live_photo'], 'video/mp4', '.mp4'],
		[msg['sticker'], mime, extension],
		[photo, 'image/jpeg', '.jpg']
	] as const) {
		if (!Predicate.isObject(file) || typeof file['file_id'] !== 'string') continue;
		const id = file['file_id'],
			bytes = file['file_size'];
		return {
			fileId: id,
			name: str(file['file_name']) ?? `${file === photo ? 'photo' : 'file'}-${id}${suffix}`,
			mime: str(file['mime_type']) ?? fallback,
			...(typeof bytes === 'number' ? { bytes } : {})
		};
	}
	return null;
}
/** What a message with no text says: the kinds the Bot API carries as fields, and a marker for what holds no content a bot can read. */
function said(msg: Readonly<Record<string, unknown>>): string {
	const field = (key: string) => (Predicate.isObject(msg[key]) ? msg[key] : null);
	const contact = field('contact'),
		venue = field('venue'),
		location = field('location'),
		poll = field('poll'),
		dice = field('dice'),
		titled = field('game') ?? field('invoice') ?? field('checklist');
	if (contact !== null)
		return [contact['first_name'], contact['last_name'], contact['phone_number']]
			.filter((part) => typeof part === 'string' && part !== '')
			.join(' ');
	// a venue also fills `location`
	if (venue !== null) return `${venue['title']}, ${venue['address']}`;
	if (location !== null) return `${location['latitude']}, ${location['longitude']}`;
	if (poll !== null)
		return [
			poll['question'],
			...(Array.isArray(poll['options']) ? poll['options'] : [])
				.filter(Predicate.isObject)
				.map((option) => `- ${option['text']}`)
		].join('\n');
	if (dice !== null) return `${dice['emoji']} ${dice['value']}`;
	if (titled !== null) return String(titled['title']);
	if (field('story') !== null) return '[story]';
	if (field('paid_media') !== null) return '[paid media]';
	if (field('rich_message') !== null) return '[rich message]';
	return str(field('sticker')?.['emoji']) ?? '';
}
function invocationOf(
	msg: typeof UpdateMessage.Type,
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
	return bot.id !== undefined && msg.reply_to_message?.from?.id === bot.id ? 'reply' : 'ambient';
}
