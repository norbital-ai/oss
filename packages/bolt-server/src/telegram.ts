// The Telegram transport (rule 61, G12 (4)): a webhook bot. Activation registers `<public>/hooks/bolt.telegram` with a
// secret derived from the token; each verified update becomes one `TransportEvent` through the engine's codec, its media
// fetched through the Bot API into `bins`. Sends are `sendMessage`.
import { createHash } from 'node:crypto';
import { telegramUpdate, telegramVerified, type Json, type TransportEvent, type TransportPort } from '@norbital-ai/bolt/engine';

const API = 'https://api.telegram.org';
export const TELEGRAM_HOOK = '/hooks/bolt.telegram';
const MEDIA_MAX = 20 * 1024 * 1024; // the Bot API's own download cap

export type Telegram = TransportPort & {
	/** `setWebhook` at activation; `getMe` names the bot for mention detection. */
	activate(publicUrl: string): Promise<void>;
	webhook(request: Request): Promise<Response>;
	/** The bot's own name, once `getMe` has answered; what a connection reports it is connected as. */
	username(): string | null;
};

export function telegram(token: string, channel: string, f: typeof fetch = fetch, api = API): Telegram {
	const secret = createHash('sha256').update(`bolt-telegram\u0000${token}`).digest('hex');
	const sinks = new Set<(e: TransportEvent) => Promise<void>>();
	let bot: { id?: number; username?: string } = {};
	const call = async (method: string, body: unknown, signal?: AbortSignal) => {
		const res = await f(`${api}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
			...(signal === undefined ? {} : { signal }) });
		const j = await res.json().catch(() => ({})) as { ok?: boolean; result?: unknown; description?: string };
		if (j.ok !== true) throw new Error(`Telegram ${method}: ${j.description ?? res.status}`);
		return j.result as { [k: string]: unknown };
	};
	return {
		username: () => bot.username ?? null,
		async activate(publicUrl) {
			const me = await call('getMe', {});
			bot = { id: me['id'] as number, username: me['username'] as string };
			await call('setWebhook', { url: `${publicUrl.replace(/\/+$/, '')}${TELEGRAM_HOOK}`, secret_token: secret, allowed_updates: ['message', 'edited_message'] });
		},
		async send(_channel, message, signal) {
			const m = message as { to: string; text: string };
			const [chat, , thread] = String(m.to).split(':');
			const sent = await call('sendMessage', { chat_id: chat, text: m.text, ...(thread === undefined ? {} : { message_thread_id: Number(thread) }) }, signal);
			return { providerId: `${chat}:${String(sent['message_id'])}` };
		},
		/** "typing…" in the chat (a Bot API chat action; it lasts about five seconds or until the next message). */
		async typing(_channel, to, signal) {
			const [chat, , thread] = String(to).split(':');
			await call('sendChatAction', { chat_id: chat, action: 'typing', ...(thread === undefined ? {} : { message_thread_id: Number(thread) }) }, signal);
		},
		subscribe(sink) { sinks.add(sink); return () => { sinks.delete(sink); }; },
		async webhook(request) {
			const headers = { 'x-telegram-bot-api-secret-token': request.headers.get('x-telegram-bot-api-secret-token') ?? undefined };
			if (!telegramVerified(headers, secret)) return new Response(null, { status: 401 });
			const parsed = telegramUpdate(await request.json().catch(() => null), bot);
			if (parsed === null) return new Response(null, { status: 200 });
			const bins: Uint8Array[] = [];
			let message: Json = parsed.message;
			if (parsed.media !== null) {
				try {
					const file = await call('getFile', { file_id: parsed.media.fileId });
					const res = await f(`${api}/file/bot${token}/${String(file['file_path'])}`);
					const bytes = new Uint8Array(await res.arrayBuffer());
					if (res.ok && bytes.byteLength <= MEDIA_MAX) {
						bins.push(bytes);
						message = { ...parsed.message, attachments: [{ fileName: parsed.media.fileName, mimeType: parsed.media.mimeType, byteLength: bytes.byteLength, bin: 0 }] };
					}
				} catch { /* the message still lands; the media is named but absent */ }
			}
			const event: TransportEvent = { kind: 'inbound', channel, message, ...(bins.length === 0 ? {} : { bins }) };
			// durable before the provider is acknowledged (rule 61): a sink rejection is a 500, so Telegram redelivers
			for (const s of sinks) await s(event);
			return new Response(null, { status: 200 });
		},
	};
}
