// One mail from the watched mailbox, read: a delivery report — an RFC 3464 DSN (`multipart/report;
// report-type=delivery-status`), or a legacy non-delivery report (qmail, older Exchange) a mailer daemon sends as prose —
// becomes a delivery report on the sent message it names; anything else is an inbound mail on bolt's wire. Replies and
// auto-replies are ordinary mail here: bolt tells them apart (RFC 3834).
import PostalMime from 'postal-mime';
import type { DeliveryReport } from '@norbital-ai/bolt/engine';
import type { Obj } from '../util.ts';

export type Report = Pick<DeliveryReport, 'kind' | 'code' | 'reason' | 'permanent' | 'presumed'>;
export type Read =
	| { kind: 'mail'; message: Obj; bins: Uint8Array[]; from: string }
	/** `ids`: the Message-IDs (ours, on `domain`) the report may be about, most certain first. */
	| { kind: 'report'; ids: string[]; report: Report };

type Parsed = Awaited<ReturnType<typeof PostalMime.parse>>;
const decode = (c: ArrayBuffer | Uint8Array | string) => typeof c === 'string' ? c : new TextDecoder().decode(c);
const MSGID = /<[^<>\s@]+@[^<>\s]+>/g;
const DAEMON = /^(mailer-daemon|postmaster|mail-daemon|mailerdaemon)@/i;
const NDR = /undeliver|not delivered|could not be delivered|delivery (status notification|failure|has failed|delayed|incomplete)|returned mail|failure notice|mail delivery (failed|system)|non-?deliver/i;
const DELAYED = /\bdelay(ed)?\b|will (continue|retry|keep) (to )?(try|trying|retrying)|temporar(y|ily)|not yet been delivered/i;

/** A header block → lowercased names (folded lines unfolded; the first of a repeated name wins). */
const fields = (block: string): Map<string, string> => {
	const out = new Map<string, string>();
	for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
		const colon = line.indexOf(':');
		if (colon > 0 && !out.has(line.slice(0, colon).trim().toLowerCase())) out.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
	}
	return out;
};
/** `550 5.1.1` from a diagnostic or prose: the basic reply code and the enhanced status, whichever are there. */
export const codeOf = (s: string, status?: string): string | undefined => {
	const basic = /\b([245]\d\d)(?=[ -]|$)/.exec(s)?.[1];
	const enhanced = status ?? /\b([245]\.\d{1,3}\.\d{1,3})\b/.exec(s)?.[1];
	return [basic, enhanced].filter((x) => x !== undefined).join(' ') || undefined;
};

/** RFC 3464's per-recipient blocks → the worst one: a failure, else a delay, else a delivery. */
function dsn(status: string): Report | null {
	const recipients = status.split(/\r?\n\s*\r?\n/).slice(1).map(fields).filter((f) => f.has('action'));
	const rank = (f: Map<string, string>) => ({ failed: 3, delayed: 2 } as { [a: string]: number })[f.get('action')!.toLowerCase()] ?? 1;
	const worst = recipients.sort((a, b) => rank(b) - rank(a))[0];
	if (worst === undefined) return null;
	const action = worst.get('action')!.toLowerCase(), st = /^[245]\.\d{1,3}\.\d{1,3}/.exec(worst.get('status') ?? '')?.[0];
	const diagnostic = (worst.get('diagnostic-code') ?? '').replace(/^[\w-]+\s*;\s*/, '');
	const code = codeOf(diagnostic, st);
	const reason = diagnostic || undefined;
	const facts = { ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason: reason.slice(0, 500) }) };
	if (action === 'failed') return { kind: 'bounced', permanent: !st?.startsWith('4'), ...facts };
	if (action === 'delayed') return { kind: 'deferred', permanent: false, ...facts };
	// `relayed`/`expanded`: handed on to a system that reports no further, so delivery is inferred
	return { kind: 'delivered', ...(action === 'delivered' ? {} : { presumed: true }), ...facts };
}

/** A daemon's prose: the first enhanced or reply code in it, delayed when it says so, else a bounce. */
function ndr(subject: string, body: string): Report {
	const code = codeOf(body);
	const delayed = code?.split(' ').some((c) => c.startsWith('4')) === true || DELAYED.test(subject);
	const line = body.split(/\r?\n/).map((l) => l.trim()).find((l) => /\b[245](\d\d|\.\d{1,3}\.\d{1,3})\b/.test(l)) ?? body.trim().split(/\r?\n/)[0] ?? '';
	return delayed ? { kind: 'deferred', permanent: false, ...(code === undefined ? {} : { code }), reason: line.slice(0, 500) }
		: { kind: 'bounced', permanent: true, ...(code === undefined ? {} : { code }), reason: line.slice(0, 500) };
}

const flat = (list: Parsed['to']) => (list ?? []).flatMap((a) => a.group === undefined ? [a] : a.group)
	.map((a) => ({ address: a.address.toLowerCase(), name: a.name === '' ? null : a.name }));

/**
 * Reads one raw message. `domain` is the channel address's domain: every Message-ID this channel sends is `<id@domain>`,
 * so a report names ours only by one of those (an envelope id `id` is ours as `<id@domain>`).
 */
export async function readMail(source: Uint8Array | string, domain: string, fallbackId: string): Promise<Read> {
	const e = await PostalMime.parse(source, { forceRfc822Attachments: true, attachmentEncoding: 'arraybuffer' });
	const headers: { [k: string]: string } = {};
	for (const h of e.headers) headers[h.key] ??= h.value;
	const from = flat(e.from === undefined ? [] : [e.from])[0] ?? { address: '', name: null };
	const subject = e.subject ?? '';
	const status = e.attachments.find((a) => /^message\/(global-)?delivery-status$/i.test(a.mimeType));
	const dsnType = /report-type\s*=\s*"?delivery-status/i.test(headers['content-type'] ?? '');
	if (status !== undefined || dsnType || (DAEMON.test(from.address) && NDR.test(subject))) {
		const original = e.attachments.filter((a) => /^(message\/(global-)?rfc822|text\/rfc822-headers|message\/global-headers)$/i.test(a.mimeType)).map((a) => decode(a.content)).join('\n');
		const text = e.text ?? '';
		const envid = status === undefined ? undefined : fields(decode(status.content).split(/\r?\n\s*\r?\n/)[0] ?? '').get('original-envelope-id');
		const ours = `@${domain.toLowerCase()}>`;
		const ids = [...new Set([
			...(envid === undefined || envid === '' ? [] : [envid.startsWith('<') ? envid : `<${envid}@${domain}>`]),
			...(fields(original).get('message-id')?.match(MSGID) ?? []),
			...[headers['x-original-message-id'], headers['in-reply-to'], headers['references']].flatMap((h) => h?.match(MSGID) ?? []),
			...(original === '' ? /^\s*message-id:\s*(<[^>]+>)/gim.exec(text)?.slice(1) ?? [] : []),
		])].filter((id) => id.toLowerCase().endsWith(ours));
		const report = (status === undefined ? null : dsn(decode(status.content))) ?? ndr(subject, text);
		return { kind: 'report', ids, report };
	}
	const bins: Uint8Array[] = [];
	const attachments = e.attachments.map((a) => {
		const bytes = typeof a.content === 'string' ? new TextEncoder().encode(a.content) : new Uint8Array(a.content);
		bins.push(bytes);
		return { fileName: a.filename ?? `attachment-${bins.length}`, mimeType: a.mimeType, byteLength: bytes.byteLength, bin: bins.length - 1 };
	});
	const date = Date.parse(e.date ?? '');
	return { kind: 'mail', from: from.address, bins, message: {
		id: e.messageId ?? fallbackId, thread: null, sentAt: new Date(Number.isNaN(date) ? Date.now() : date).toISOString(), from,
		replyTo: flat(e.replyTo)[0] ?? null, to: flat(e.to), cc: flat(e.cc), subject, text: e.text ?? '', html: e.html ?? null, headers, attachments,
	} };
}
