// Telegram: a Bot API bot on a webhook. Pairing takes the bot token: `getMe` names the bot, `setWebhook` registers this
// channel's own URL with a secret derived from the token (the host sets it; the operator pastes nothing). Each verified
// update becomes one inbound event, its media fetched through the Bot API into `bins`. Sends are `sendMessage`, then one
// `sendDocument` per attachment in the same chat (a document keeps its file name and bytes; a photo would be recompressed).
import { createHash } from 'node:crypto';
import { connection, type ChannelProvider, type Json } from '@norbital-ai/bolt/engine';
import { blobOf, field, isObj, refusal, same, str, type Obj } from '../util.ts';

const API = 'https://api.telegram.org';
const MEDIA_MAX = 20 * 1024 * 1024; // the Bot API's own download cap
type Bot = { id?: number; username?: string };

export function telegram(o: { api?: string } = {}): ChannelProvider {
	const api = o.api ?? API;
	return {
		transport: 'telegram', id: 'bot', label: { en: 'Telegram bot', zh: 'Telegram 机器人' },
		setup: { kind: 'form', steps: [
			{ text: { en: 'In Telegram, open @BotFather and send /newbot; choose a name and a username ending in "bot".',
				zh: '在 Telegram 中打开 @BotFather 并发送 /newbot；选择一个名称和以 “bot” 结尾的用户名。' }, href: 'https://t.me/BotFather' },
			{ text: { en: 'Copy the token BotFather answers with and paste it below. This host registers its webhook with Telegram itself.',
				zh: '复制 BotFather 回复的令牌并粘贴到下方。本主机会自行向 Telegram 注册 Webhook。' } },
			{ text: { en: 'For groups: add the bot to the group; it answers when mentioned or replied to.', zh: '群组：将机器人加入群组；被提及或被回复时它会应答。' } },
		], fields: [{ name: 'token', label: { en: 'Bot token', zh: '机器人令牌' }, secret: true, hint: '123456789:AA…' }] },
		test: { to: { name: 'to', label: { en: 'Chat id', zh: '聊天 ID' }, hint: { en: 'Your chat id with the bot: message it first', zh: '您与机器人的聊天 ID：请先给它发一条消息' } } },
		async open(ctx) {
			let token = isObj(ctx.credential) ? str(ctx.credential['token']) : null;
			let bot: Bot = {}, error: string | null = null;
			const secret = () => createHash('sha256').update(`bolt-telegram\u0000${token ?? ''}`).digest('hex');
			const call = async (t: string, method: string, body: unknown, signal?: AbortSignal) => {
				const res = await ctx.fetch(`${api}/bot${t}/${method}`, { method: 'POST',
					...(body instanceof FormData ? { body } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
					...(signal === undefined ? {} : { signal }) });
				const j = await res.json().catch(() => ({})) as { ok?: boolean; result?: unknown; description?: string; error_code?: number };
				if (j.ok !== true) throw refusal(`Telegram ${method}: ${j.description ?? res.status}`, j.error_code ?? res.status);
				return j.result as Obj;
			};
			const activate = async (t: string) => {
				const me = await call(t, 'getMe', {});
				bot = { id: me['id'] as number, username: me['username'] as string };
				await call(t, 'setWebhook', { url: ctx.webhookUrl, secret_token: createHash('sha256').update(`bolt-telegram\u0000${t}`).digest('hex'),
					allowed_updates: ['message', 'edited_message'] });
			};
			if (token !== null) await activate(token).catch((e: unknown) => { error = `${e instanceof Error ? e.message : String(e)} — pair again with a working token`; });
			const need = () => { if (token === null) throw new Error('the Telegram bot is not connected'); return token; };
			return {
				connection: () => token === null ? connection(ctx.channel, 'telegram', 'unpaired')
					: error !== null ? connection(ctx.channel, 'telegram', 'error', { error, stored: true })
					: connection(ctx.channel, 'telegram', 'connected', { stored: true, pairedAs: bot.username === undefined ? null : `@${bot.username}`,
						about: bot.username === undefined ? {} : { botName: `@${bot.username}` } }),
				async pair(input) {
					const t = field(input, 'token', 'The bot token', /^\d+:[\w-]+$/);
					await activate(t); // a bad token throws before anything is kept
					token = t;
					error = null;
					await ctx.save({ token: t });
					ctx.changed();
				},
				async unpair() {
					if (token !== null) await call(token, 'deleteWebhook', {}).catch(() => undefined);
					token = null;
					await ctx.save(null);
				},
				async close() {},
				async send(_channel, message, signal, files = []) {
					const m = message as { to: string; text: string };
					const [chat, , thread] = String(m.to).split(':');
					const sent = await call(need(), 'sendMessage', { chat_id: chat, text: m.text, ...(thread === undefined ? {} : { message_thread_id: Number(thread) }) }, signal);
					// ponytail: a failed document after the text retries the whole message (the text again); send as one media group if that shows
					for (const f of files) {
						const form = new FormData();
						form.set('chat_id', chat!);
						if (thread !== undefined) form.set('message_thread_id', thread);
						form.set('document', blobOf(f), f.name);
						await call(need(), 'sendDocument', form, signal);
					}
					return { providerId: `${chat}:${String(sent['message_id'])}` };
				},
				/** "typing…" in the chat (a Bot API chat action; it lasts about five seconds or until the next message). */
				async typing(_channel, to, signal) {
					const [chat, , thread] = String(to).split(':');
					await call(need(), 'sendChatAction', { chat_id: chat, action: 'typing', ...(thread === undefined ? {} : { message_thread_id: Number(thread) }) }, signal);
				},
				async webhook(request) {
					if (token === null || !same(request.headers.get('x-telegram-bot-api-secret-token') ?? '', secret())) return new Response(null, { status: 401 });
					const parsed = telegramUpdate(await request.json().catch(() => null), bot);
					if (parsed === null) return new Response(null, { status: 200 });
					const bins: Uint8Array[] = [];
					let message: Json = parsed.message;
					if (parsed.media !== null) {
						try {
							const file = await call(token, 'getFile', { file_id: parsed.media.fileId });
							const res = await ctx.fetch(`${api}/file/bot${token}/${String(file['file_path'])}`);
							const bytes = new Uint8Array(await res.arrayBuffer());
							if (res.ok && bytes.byteLength <= MEDIA_MAX) {
								bins.push(bytes);
								message = { ...parsed.message, attachments: [{ fileName: parsed.media.fileName, mimeType: parsed.media.mimeType, byteLength: bytes.byteLength, bin: 0 }] };
							}
						} catch { /* the message still lands; the media is named but absent */ }
					}
					// durable before the provider is acknowledged (rule 61): a rejection is a 500, so Telegram redelivers
					await ctx.emit({ kind: 'inbound', channel: ctx.channel, message, ...(bins.length === 0 ? {} : { bins }) });
					return new Response(null, { status: 200 });
				},
			};
		},
	};
}

/** Media the link downloads through the Bot API before it emits the event (its bytes become a `bin`). */
export type TelegramMedia = { fileId: string; fileName: string; mimeType: string };
/** One Bot API update → the wire message (`message` or `edited_message`), or `null` for updates the channel ignores. */
export function telegramUpdate(update: unknown, bot: Bot): { message: Obj; media: TelegramMedia | null } | null {
	if (!isObj(update)) return null;
	const edited = isObj(update['edited_message']);
	const msg = (edited ? update['edited_message'] : update['message']) as Json;
	if (!isObj(msg) || !isObj(msg['chat']) || typeof msg['message_id'] !== 'number' || typeof msg['date'] !== 'number') return null;
	const chat = msg['chat'], chatId = String(chat['id']);
	const group = chat['type'] !== 'private';
	const text = typeof msg['text'] === 'string' ? msg['text'] : typeof msg['caption'] === 'string' ? msg['caption'] : '';
	const from = isObj(msg['from']) ? msg['from'] : {};
	const name = [from['first_name'], from['last_name']].filter((p) => typeof p === 'string' && p !== '').join(' ');
	const thread = msg['is_topic_message'] === true && typeof msg['message_thread_id'] === 'number' ? `${chatId}:thread:${msg['message_thread_id']}` : chatId;
	const reply = isObj(msg['reply_to_message']) ? msg['reply_to_message'] : null;
	const sentAt = new Date(msg['date'] * 1000).toISOString();
	const doc = [msg['document'], msg['video'], msg['audio'], msg['voice']].find(isObj) as Obj | undefined;
	const photo = Array.isArray(msg['photo']) ? msg['photo'].at(-1) : undefined;
	const media: TelegramMedia | null = doc !== undefined && typeof doc['file_id'] === 'string'
		? { fileId: doc['file_id'], fileName: str(doc['file_name']) ?? `file-${doc['file_id']}`, mimeType: str(doc['mime_type']) ?? 'application/octet-stream' }
		: isObj(photo) && typeof photo['file_id'] === 'string' ? { fileId: photo['file_id'], fileName: `photo-${photo['file_id']}.jpg`, mimeType: 'image/jpeg' } : null;
	return { media, message: {
		// a Bot API message id is per chat, so the chat is part of the provider id
		id: `${chatId}:${msg['message_id']}`, thread, sentAt, text, group, ...(group && str(chat['title']) !== null ? { title: str(chat['title']) } : {}),
		from: { handle: String(from['id'] ?? ''), name: name === '' ? null : name },
		replyTo: reply !== null && typeof reply['message_id'] === 'number' ? `${chatId}:${reply['message_id']}` : null,
		invocation: group ? invocationOf(msg, text, bot) : 'direct',
		...(edited ? { version: new Date(((msg['edit_date'] as number | undefined) ?? msg['date']) * 1000).toISOString() } : {}),
		attachments: [],
	} };
}
function invocationOf(msg: Obj, text: string, bot: Bot): 'mention' | 'reply' | 'ambient' {
	const handle = bot.username === undefined ? undefined : `@${bot.username.toLowerCase()}`;
	for (const e of (Array.isArray(msg['entities']) ? msg['entities'] : Array.isArray(msg['caption_entities']) ? msg['caption_entities'] : []).filter(isObj)) {
		const part = text.slice(Number(e['offset'] ?? 0), Number(e['offset'] ?? 0) + Number(e['length'] ?? 0)).toLowerCase();
		if (e['type'] === 'mention' && handle !== undefined && part === handle) return 'mention';
		if (e['type'] === 'text_mention' && isObj(e['user']) && e['user']['id'] === bot.id) return 'mention';
		if (e['type'] === 'bot_command' && handle !== undefined && part.endsWith(handle)) return 'mention';
	}
	const reply = msg['reply_to_message'];
	return isObj(reply) && isObj(reply['from']) && bot.id !== undefined && reply['from']['id'] === bot.id ? 'reply' : 'ambient';
}
