// Zalo bots through the Zalo Bot Platform. Webhooks only: it offers no history, no edits and no dedupe key. Its API takes
// the bot token in the path, so a URL here is a secret. The webhook itself is set in Zalo's dashboard.
import { Schema } from 'effect';
import { parse as parseJson, download as downloadFile, json } from '../http.ts';
import type { ChatConnection, ChatPlatform, Incoming } from '../adapter.ts';
import { nothing, PlatformError } from '../adapter.ts';
import { signed } from '../verify.ts';

const API = 'https://bot-api.zaloplatforms.com';
const LIMIT = 2000;
const Message = Schema.Struct({
	message_id: Schema.String,
	date: Schema.Number,
	chat: Schema.Struct({
		id: Schema.String,
		chat_type: Schema.Union([Schema.Literal('PRIVATE'), Schema.Literal('GROUP')])
	}),
	from: Schema.Struct({
		id: Schema.String,
		display_name: Schema.String
	}),
	text: Schema.optionalKey(Schema.String),
	photo: Schema.optionalKey(Schema.String),
	caption: Schema.optionalKey(Schema.String)
});
type Message = typeof Message.Type;
const Update = Schema.Struct({
	event_name: Schema.optionalKey(Schema.String),
	message: Schema.optionalKey(Message)
});
type Update = typeof Update.Type;

const parse = (message: Message, photo: (url: string) => Promise<Uint8Array>): Incoming | null => {
	const text = message.text ?? message.caption ?? '',
		url = message.photo;
	if (text === '' && url === undefined) return null;
	return {
		id: message.message_id,
		thread: message.chat.id,
		sentAt: new Date(message.date).toISOString(),
		from: { handle: message.from.id, name: message.from.display_name },
		text,
		group: message.chat.chat_type === 'GROUP',
		...(url === undefined
			? {}
			: {
					files: [{ name: `zalo-${message.message_id}`, mime: 'image/*', fetch: () => photo(url) }]
				})
	};
};

export const zalo: ChatPlatform = {
	id: 'zalo',
	name: { en: 'Zalo', zh: 'Zalo' },
	description: { en: 'Zalo bots', zh: 'Zalo 机器人' },
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'webhook',
	icon: 'simple-icons:zalo',
	guide: 'https://bot.zapps.me/docs',
	fields: [
		{ name: 'botToken', label: { en: 'Bot token', zh: '机器人令牌' }, secret: true },
		{ name: 'webhookSecret', label: { en: 'Webhook secret', zh: 'Webhook 密钥' }, secret: true }
	],
	async connect({ botToken = '', webhookSecret = '' }, host) {
		const call = async <A>(
			schema: Schema.Decoder<A>,
			method: string,
			body?: object
		): Promise<A> => {
			const response = await host.fetch(`${API}/bot${botToken}/${method}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				...(body === undefined ? {} : { body: JSON.stringify(body) })
			});
			const answer = await json(
				Schema.Struct({
					ok: Schema.optionalKey(Schema.Boolean),
					result: Schema.Unknown,
					error_code: Schema.optionalKey(Schema.Number),
					description: Schema.optionalKey(Schema.String)
				}),
				response
			);
			if (response.ok && answer.ok === true)
				return Schema.decodeUnknownPromise(schema)(answer.result);
			throw new PlatformError(
				answer.description ?? `Zalo answered ${response.status}`,
				response.ok ? (answer.error_code ?? 500) : response.status
			);
		};
		const photo = (url: string) => downloadFile(host.fetch, url);
		const me = await call(
			Schema.Struct({
				id: Schema.String,
				account_name: Schema.optionalKey(Schema.String)
			}),
			'getMe'
		);
		const connection: ChatConnection = {
			account: me.account_name ?? me.id,
			async deliver(request, body) {
				signed(request.headers.get('x-bot-api-secret-token'), webhookSecret);
				const hook = await parseJson(
					Schema.Struct({
						...Update.fields,
						result: Schema.optionalKey(Update)
					}),
					body
				);
				// the event sits at the root of a delivery, or under `result` as in Zalo's other answers
				const { message } = hook.result ?? hook;
				if (message === undefined || message.from.id === me.id) return nothing();
				const parsed = parse(message, photo);
				return parsed === null ? nothing() : { messages: [parsed] };
			},
			async send(thread, text) {
				const characters = [...text];
				let id = '';
				for (let at = 0; at === 0 || at < characters.length; at += LIMIT)
					({ message_id: id } = await call(
						Schema.Struct({
							message_id: Schema.String
						}),
						'sendMessage',
						{
							chat_id: thread,
							text: characters.slice(at, at + LIMIT).join('')
						}
					));
				return { id };
			},
			typing: async (thread, on) => {
				if (on) await call(Schema.Json, 'sendChatAction', { chat_id: thread, action: 'typing' });
			}
		};
		return connection;
	}
};
