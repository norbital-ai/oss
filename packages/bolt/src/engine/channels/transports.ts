// The transport contract (P24, rule 61): what a host transport adapter hands the engine through `TransportPort`, the
// provider codecs every host shares (Telegram webhook updates, Baileys WhatsApp messages, Resend events behind Svix),
// and the in-memory fake the tests drive. The adapters that own sockets and HTTP (Baileys, the Bot API, Resend) live
// in the host; they call these codecs and emit `TransportEvent`s. Nothing here names a host (P18).
import { timingSafeEqual } from 'node:crypto';
import type { Json } from '../../decl/values.ts';
import type { TransportEvent, TransportPort } from '../contracts.ts';
import { verifySignature } from '../runs/webhook.ts';
import { isObj, type Obj } from './store.ts';

export type Invocation = 'direct' | 'mention' | 'reply' | 'ambient';
/**
 * An inbound message as the author types see it (`InboundMail` / `InboundChat`, decl/runtime/channel.ts) plus the
 * transport's facts: `group`, `invocation`, `version` (edit order), `deleted` (the sender's revoke), `history` (a
 * backfill nobody waits on). Attachment bytes ride the event's `bins`, named by `bin`.
 */
export type WireAttachment = { fileName: string; mimeType: string; byteLength: number; bin?: number; file?: Json };
export type Inbound = {
	id: string; thread: string; sentAt: string; sender: string; senderName: string | null; text: string; replyTo: string | null;
	group: boolean; invocation: Invocation; version: string; deleted: boolean; history: boolean; attachments: readonly WireAttachment[];
	/** Email only: the full mail (GAP-C1) and the ids it references, for reply matching. */
	email: Obj | null; references: readonly string[];
};

const str = (v: unknown): string | null => typeof v === 'string' && v !== '' ? v : null;
const iso = (v: unknown): string | null => { const s = str(v); return s !== null && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null; };

/** Decodes a `TransportEvent.message` at the trust boundary; `null` for anything malformed (the adapter's bug, never a row). */
export function decodeInbound(transport: string, m: Json): Inbound | null {
	if (!isObj(m)) return null;
	const id = str(m['id']), sentAt = iso(m['sentAt']);
	// a revoke may name only its target (Baileys reports the id alone): `thread === ''` tombstones by `(channel, id)`
	if (id !== null && m['deleted'] === true && (str(m['thread']) === null || sentAt === null))
		return { id, thread: '', sentAt: sentAt ?? new Date().toISOString(), sender: '', senderName: null, text: '', replyTo: null, group: false, invocation: 'ambient',
			version: sentAt ?? new Date().toISOString(), deleted: true, history: m['history'] === true, attachments: [], email: null, references: [] };
	if (id === null || sentAt === null) return null;
	const attachments = (Array.isArray(m['attachments']) ? m['attachments'] : []).flatMap((a): WireAttachment[] => {
		if (!isObj(a) || str(a['fileName']) === null || str(a['mimeType']) === null || typeof a['byteLength'] !== 'number') return [];
		return [{ fileName: a['fileName'] as string, mimeType: a['mimeType'] as string, byteLength: a['byteLength'],
			...(typeof a['bin'] === 'number' ? { bin: a['bin'] } : {}), ...(a['file'] === undefined ? {} : { file: a['file'] }) }];
	});
	const facts = { sentAt, version: iso(m['version']) ?? sentAt, deleted: m['deleted'] === true, history: m['history'] === true, attachments };
	const text = typeof m['text'] === 'string' ? m['text'] : '';
	if (transport === 'email') {
		const from = isObj(m['from']) ? str(m['from']['address']) : null;
		if (from === null) return null;
		const headers = isObj(m['headers']) ? m['headers'] : {};
		const chain = String(headers['references'] ?? '').split(/\s+/).filter((r) => r !== '');
		const refs = [...new Set([String(headers['in-reply-to'] ?? ''), ...chain].filter((r) => r !== ''))];
		const { attachments: _a, invocation: _i, version: _v, deleted: _d, history: _h, group: _g, ...mail } = m;
		// one conversation per mail thread: its root, else the message it answers, else itself
		return { id, thread: str(m['thread']) ?? chain[0] ?? refs[0] ?? id, sender: from.toLowerCase(), senderName: isObj(m['from']) ? str(m['from']['name']) : null,
			text, replyTo: null, group: false, invocation: 'direct', email: mail, references: refs, ...facts };
	}
	const from = isObj(m['from']) ? str(m['from']['handle']) : null, thread = str(m['thread']);
	if (from === null || thread === null) return null;
	const group = m['group'] === true;
	const inv = m['invocation'];
	const invocation: Invocation = !group ? 'direct' : inv === 'mention' || inv === 'reply' ? inv : 'ambient';
	return { id, thread, sender: from, senderName: isObj(m['from']) ? str(m['from']['name']) : null, text, replyTo: str(m['replyTo']),
		group, invocation, email: null, references: [], ...facts };
}

// ── Telegram (webhook ingress, `transports-telegram.ts` today) ──
/** The webhook's `X-Telegram-Bot-Api-Secret-Token`, compared in constant time. */
export function telegramVerified(headers: { readonly [lowercase: string]: string | undefined }, secret: string): boolean {
	const got = Buffer.from(headers['x-telegram-bot-api-secret-token'] ?? ''), want = Buffer.from(secret);
	return secret !== '' && got.length === want.length && timingSafeEqual(got, want);
}
/** Media the adapter downloads through the Bot API before it emits the event (its bytes become a `bin`). */
export type TelegramMedia = { fileId: string; fileName: string; mimeType: string };
/** One Bot API update → the wire message (`message` or `edited_message`), or `null` for updates the channel ignores. */
export function telegramUpdate(update: unknown, bot: { id?: number; username?: string }): { message: Obj; media: TelegramMedia | null } | null {
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
		id: `${chatId}:${msg['message_id']}`, thread, sentAt, text, group,
		from: { handle: String(from['id'] ?? ''), name: name === '' ? null : name },
		replyTo: reply !== null && typeof reply['message_id'] === 'number' ? `${chatId}:${reply['message_id']}` : null,
		invocation: group ? telegramInvocation(msg, text, bot) : 'direct',
		...(edited ? { version: new Date(((msg['edit_date'] as number | undefined) ?? msg['date']) * 1000).toISOString() } : {}),
		attachments: [],
	} };
}
function telegramInvocation(msg: Obj, text: string, bot: { id?: number; username?: string }): Invocation {
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

// ── WhatsApp (a paired account over Baileys, a persistent socket the adapter owns; `transports-whatsapp.ts` today) ──
/** One Baileys `WAMessage` (read structurally) → the wire message, or `null` (our own echo, a receipt, an empty message). */
export function whatsappMessage(msg: unknown, self: string | undefined, options: { history?: boolean; lid?: string } = {}): Obj | null {
	if (!isObj(msg) || !isObj(msg['key']) || msg['key']['fromMe'] === true) return null;
	const key = msg['key'], jid = str(key['remoteJid']), id = str(key['id']), content = msg['message'];
	const ts = Number(msg['messageTimestamp']);
	if (jid === null || id === null || !isObj(content) || !Number.isFinite(ts)) return null;
	const group = jid.endsWith('@g.us');
	const sentAt = new Date(ts * 1000).toISOString();
	const from = { handle: group ? str(key['participant']) ?? jid : jid, name: str(msg['pushName'])?.trim() ?? null };
	const base = { thread: jid, sentAt, from, group, attachments: [], ...(options.history === true ? { history: true } : {}) };
	// a sender's revoke tombstones the message; an edit converges its text (the target id is the edited message's)
	const protocol = content['protocolMessage'];
	if (isObj(protocol)) {
		const target = isObj(protocol['key']) ? str(protocol['key']['id']) : null;
		if (target === null) return null;
		if (Number(protocol['type']) === 0) return { ...base, id: target, text: '', deleted: true, invocation: 'ambient' };
		if (Number(protocol['type']) !== 14 || !isObj(protocol['editedMessage'])) return null;
		return { ...base, id: target, text: whatsappText(protocol['editedMessage']), version: sentAt, invocation: 'ambient' };
	}
	const text = whatsappText(content);
	const context = [content['extendedTextMessage'], content['imageMessage'], content['documentMessage'], content['videoMessage']]
		.find((x) => isObj(x) && isObj(x['contextInfo'])) as Obj | undefined;
	const info = context?.['contextInfo'] as Obj | undefined;
	// Both of our identities: WhatsApp addresses a linked device by LID in `mentionedJid`, so matching only the phone
	// JID the number prints as reads every real mention as ambient. Either form, with or without a device suffix.
	const ours = [self, options.lid].flatMap((id) => {
		const bare = id?.split(':')[0]?.split('@')[0];
		return bare === undefined || bare === '' ? [] : [bare];
	});
	const isOurs = (jid: string): boolean => ours.some((b) => jid.startsWith(b));
	const mentioned = Array.isArray(info?.['mentionedJid']) && info['mentionedJid'].some((j) => typeof j === 'string' && isOurs(j));
	// a reply to anybody is not a reply to us: only a quote of our own message counts, which `participant` names
	const repliedToUs = typeof info?.['participant'] === 'string' && isOurs(info['participant']);
	return { ...base, id, text, replyTo: str(info?.['stanzaId']), invocation: !group ? 'direct' : mentioned ? 'mention' : repliedToUs ? 'reply' : 'ambient' };
}
function whatsappText(content: Obj): string {
	for (const [k, f] of [['conversation', null], ['extendedTextMessage', 'text'], ['imageMessage', 'caption'], ['videoMessage', 'caption'], ['documentMessage', 'caption']] as const) {
		const v = f === null ? content[k] : isObj(content[k]) ? content[k][f] : undefined;
		if (typeof v === 'string') return v;
	}
	return '';
}

// ── email (Resend events behind a Svix signature) ──
const RESEND: { readonly [type: string]: string } = { 'email.sent': 'sent', 'email.delivered': 'delivered', 'email.opened': 'opened',
	'email.bounced': 'bounced', 'email.complained': 'bounced', 'email.failed': 'failed' };
const address = (v: unknown): Obj | null => {
	const s = str(v);
	if (s === null) return null;
	const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(s);
	return m === null ? { address: s.trim(), name: null } : { address: m[2]!.trim(), name: m[1] === '' ? null : m[1]!.replace(/^"|"$/g, '') };
};
/**
 * One Resend webhook delivery → an event on channel `channel`: `'unverified'` (answer 401, record nothing), `null` for
 * event types the channel ignores. `email.received` is an inbound mail; the delivery types map onto `DeliveryKind`.
 */
export function resendEvent(channel: string, headers: { readonly [lowercase: string]: string | undefined }, body: Uint8Array, secret: string, nowMs: number): TransportEvent | 'unverified' | null {
	if (!verifySignature('svix', secret, { method: 'POST', headers, body }, nowMs)) return 'unverified';
	let e: Json;
	try {
		e = JSON.parse(new TextDecoder().decode(body)) as Json;
	} catch {
		return null;
	}
	if (!isObj(e) || !isObj(e['data'])) return null;
	const d = e['data'], type = String(e['type']), at = iso(e['created_at']) ?? new Date(nowMs).toISOString();
	if (type === 'email.received') {
		const headersIn = isObj(d['headers']) ? d['headers'] : {};
		return { kind: 'inbound', channel, message: {
			id: str(d['message_id']) ?? String(d['email_id']), thread: null, sentAt: iso(d['created_at']) ?? at, from: address(d['from']),
			replyTo: address(Array.isArray(d['reply_to']) ? d['reply_to'][0] : d['reply_to']),
			to: (Array.isArray(d['to']) ? d['to'] : []).map(address).filter((x) => x !== null), cc: (Array.isArray(d['cc']) ? d['cc'] : []).map(address).filter((x) => x !== null),
			subject: str(d['subject']) ?? '', text: str(d['text']) ?? '', html: str(d['html']),
			headers: Object.fromEntries(Object.entries(headersIn).map(([k, v]) => [k.toLowerCase(), String(v)])), attachments: [] } };
	}
	const kind = RESEND[type];
	if (kind === undefined || str(d['email_id']) === null) return null;
	const reason = isObj(d['bounce']) ? str(d['bounce']['message']) : isObj(d['failed']) ? str(d['failed']['reason']) : null;
	return { kind: 'delivery', channel, providerId: d['email_id'] as string, event: kind, at, ...(reason === null ? {} : { data: { reason } }) };
}

// ── the test fake (P20: every transport has one; G12 runs against them) ──
export type FakeTransport = TransportPort & {
	sent: { channel: string; message: Json; providerId: string }[];
	/** Decides a send's fate: throw to fail it (a `timeout`-named error hangs past the wall is not simulated). */
	fail: ((message: Json) => Error | null) | null;
	/** Hands one event to every subscriber, as the adapter would; rejects when a sink rejects (a redelivery). */
	emit(event: TransportEvent): Promise<void>;
};
export function fakeTransport(prefix = 'p'): FakeTransport {
	const sinks = new Set<(e: TransportEvent) => Promise<void>>();
	let n = 0;
	const t: FakeTransport = {
		sent: [], fail: null,
		async send(channel, message) {
			const err = t.fail?.(message) ?? null;
			if (err !== null) throw err;
			const providerId = `${prefix}-${++n}`;
			t.sent.push({ channel, message, providerId });
			return { providerId };
		},
		subscribe(sink) { sinks.add(sink); return () => { sinks.delete(sink); }; },
		async emit(event) { for (const s of sinks) await s(event); },
	};
	return t;
}
