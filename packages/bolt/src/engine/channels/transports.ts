// The transport contract (P24, rule 61): what a provider link hands the engine through `TransportPort` (decoded here at
// the trust boundary) and the in-memory fake the tests drive. The provider codecs (Bot API updates, WhatsApp Web
// messages, Slack events, …) live in `@norbital-ai/providers`, injected by a host; nothing here names a provider (P18).
import type { Json } from '../../decl/values.ts';
import type { TransportEvent, TransportPort } from '../contracts.ts';
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
	/** The ids a group message named as mentions, as the provider sent them. A row nobody answered is diagnosed from these. */
	mentions: readonly string[];
	/** A group chat's own name, when the provider says it (Telegram's `chat.title`, WhatsApp's group subject). */
	title: string | null;
	participants?: readonly { handle: string; name: string | null }[];
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
			version: sentAt ?? new Date().toISOString(), deleted: true, history: m['history'] === true, attachments: [], mentions: [], email: null, references: [], title: null };
	if (id === null || sentAt === null) return null;
	const attachments = (Array.isArray(m['attachments']) ? m['attachments'] : []).flatMap((a): WireAttachment[] => {
		if (!isObj(a) || str(a['fileName']) === null || str(a['mimeType']) === null || typeof a['byteLength'] !== 'number') return [];
		return [{ fileName: a['fileName'] as string, mimeType: a['mimeType'] as string, byteLength: a['byteLength'],
			...(typeof a['bin'] === 'number' ? { bin: a['bin'] } : {}), ...(a['file'] === undefined ? {} : { file: a['file'] }) }];
	});
	const participants = Array.isArray(m['participants']) ? m['participants'].flatMap((participant) => {
		if (!isObj(participant) || str(participant['handle']) === null) return [];
		return [{ handle: str(participant['handle'])!, name: str(participant['name']) }];
	}) : undefined;
	const facts = { ...(participants === undefined ? {} : { participants }), sentAt, version: iso(m['version']) ?? sentAt, deleted: m['deleted'] === true, history: m['history'] === true, attachments };
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
			text, replyTo: null, group: false, invocation: 'direct', email: mail, references: refs, mentions: [], title: null, ...facts };
	}
	const from = isObj(m['from']) ? str(m['from']['handle']) : null, thread = str(m['thread']);
	if (from === null || thread === null) return null;
	const group = m['group'] === true;
	const inv = m['invocation'];
	const invocation: Invocation = !group ? 'direct' : inv === 'mention' || inv === 'reply' ? inv : 'ambient';
	const mentions = Array.isArray(m['mentionedJid']) ? m['mentionedJid'].filter((j): j is string => typeof j === 'string')
		: Array.isArray(m['mentions']) ? m['mentions'].filter((j): j is string => typeof j === 'string') : [];
	return { id, thread, sender: from, senderName: isObj(m['from']) ? str(m['from']['name']) : null, text, replyTo: str(m['replyTo']),
		group, invocation, mentions, email: null, references: [], title: group ? str(m['title']) : null, ...facts };
}

// ── the test fake (P20: every transport has one; G12 runs against them) ──
export type FakeTransport = TransportPort & {
	/** `attachments`: what bolt read for the send (the message itself keeps its FileRefs). */
	sent: { channel: string; message: Json; providerId: string; attachments?: readonly { name: string; mime: string; bytes: Uint8Array }[] }[];
	/** Every typing indicator shown, by chat. */
	typed: { channel: string; to: string }[];
	/** Decides a send's fate: throw to fail it (a `timeout`-named error hangs past the wall is not simulated). */
	fail: ((message: Json) => Error | null) | null;
	/** The quiet window a send answers with (an email provider's), after which bolt presumes it delivered. */
	presumeAfterMs: number | null;
	/** Hands one event to every subscriber, as the adapter would; rejects when a sink rejects (a redelivery). */
	emit(event: TransportEvent): Promise<void>;
};
export function fakeTransport(prefix = 'p'): FakeTransport {
	const sinks = new Set<(e: TransportEvent) => Promise<void>>();
	let n = 0;
	const t: FakeTransport = {
		sent: [], typed: [], fail: null, presumeAfterMs: null,
		async typing(channel, to) { t.typed.push({ channel, to }); },
		async send(channel, message, _signal, attachments) {
			const err = t.fail?.(message) ?? null;
			if (err !== null) throw err;
			const providerId = `${prefix}-${++n}`;
			t.sent.push({ channel, message, providerId, ...(attachments === undefined ? {} : { attachments: attachments.map(({ name, mime, bytes }) => ({ name, mime, bytes })) }) });
			return t.presumeAfterMs === null ? { providerId } : { providerId, presumeAfterMs: t.presumeAfterMs };
		},
		subscribe(sink) { sinks.add(sink); return () => { sinks.delete(sink); }; },
		async emit(event) { for (const s of sinks) await s(event); },
	};
	return t;
}
