// One mail from the watched mailbox, read: a delivery report — an RFC 3464 DSN (`multipart/report;
// report-type=delivery-status`), or a legacy non-delivery report (qmail, older Exchange) a mailer daemon sends as prose —
// becomes a delivery report on the sent message it names; anything else is an inbound mail on bolt's wire. Replies and
// auto-replies are ordinary mail here: bolt tells them apart (RFC 3834).
import PostalMime from 'postal-mime';
import { Clock, Effect } from 'effect';
import type { DeliveryReport } from '@norbital-ai/bolt/engine';
import type { Obj } from '../util.ts';

/** A file a message's structure names, its bytes not read. */
export type Named = { name: string; mime: string; bytes: number };
export type Report = Pick<DeliveryReport, 'kind' | 'code' | 'reason' | 'permanent' | 'presumed'>;
export type Read =
	| { kind: 'mail'; message: Obj; bins: Uint8Array[]; from: string; id: string; thread: string }
	/** `ids`: the Message-IDs (ours, on `domain`) the report may be about, most certain first. */
	| { kind: 'report'; ids: string[]; report: Report };

type Parsed = Awaited<ReturnType<typeof PostalMime.parse>>;
const decode = (c: ArrayBuffer | Uint8Array | string) =>
	typeof c === 'string' ? c : new TextDecoder().decode(c);
/** The engine's thread of a mail (`normalizeInbound`): the first reference, else what it replies to, else itself. */
const threadOf = (headers: { readonly [k: string]: string }, id: string) =>
	headers['references']?.split(/\s+/).find((value) => value !== '') || headers['in-reply-to'] || id;
/** The Date header, never after the arrival: a window search reads arrivals, so a stored instant stays inside its window. */
const sentAtOf = (date: string | undefined, receivedAt: string | undefined, now: number) => {
	const known = [Date.parse(date ?? ''), Date.parse(receivedAt ?? '')].filter(Number.isFinite);
	return new Date(known.length === 0 ? now : Math.min(...known)).toISOString();
};
/** A mail with no readable sender still needs one to be stored. */
const NOBODY = 'unknown@invalid';
const UNREADABLE = 'This email could not be read. Its raw source is attached.';
const MSGID = /<[^<>\s@]+@[^<>\s]+>/g;
const DAEMON = /^(mailer-daemon|postmaster|mail-daemon|mailerdaemon)@/i;
const NDR =
	/undeliver|not delivered|could not be delivered|delivery (status notification|failure|has failed|delayed|incomplete)|returned mail|failure notice|mail delivery (failed|system)|non-?deliver/i;
const DELAYED =
	/\bdelay(ed)?\b|will (continue|retry|keep) (to )?(try|trying|retrying)|temporar(y|ily)|not yet been delivered/i;

/** A header block → lowercased names (folded lines unfolded; the first of a repeated name wins). */
const fields = (block: string): Map<string, string> => {
	const out = new Map<string, string>();
	for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
		const colon = line.indexOf(':');
		if (colon > 0 && !out.has(line.slice(0, colon).trim().toLowerCase()))
			out.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
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
	const recipients = status
		.split(/\r?\n\s*\r?\n/)
		.slice(1)
		.map(fields)
		.filter((f) => f.has('action'));
	const ranks: Readonly<Record<string, number>> = { failed: 3, delayed: 2 };
	const rank = (f: Map<string, string>) => ranks[(f.get('action') ?? '').toLowerCase()] ?? 1;
	const worst = recipients.sort((a, b) => rank(b) - rank(a))[0];
	if (worst === undefined) return null;
	const action = worst.get('action')!.toLowerCase(),
		st = /^[245]\.\d{1,3}\.\d{1,3}/.exec(worst.get('status') ?? '')?.[0];
	const diagnostic = (worst.get('diagnostic-code') ?? '').replace(/^[\w-]+\s*;\s*/, '');
	const code = codeOf(diagnostic, st);
	const reason = diagnostic || undefined;
	const facts = {
		...(code === undefined ? {} : { code }),
		...(reason === undefined ? {} : { reason: reason.slice(0, 500) })
	};
	if (action === 'failed') return { kind: 'bounced', permanent: !st?.startsWith('4'), ...facts };
	if (action === 'delayed') return { kind: 'deferred', permanent: false, ...facts };
	// `relayed`/`expanded`: handed on to a system that reports no further, so delivery is inferred
	return { kind: 'delivered', ...(action === 'delivered' ? {} : { presumed: true }), ...facts };
}

/** A daemon's prose: the first enhanced or reply code in it, delayed when it says so, else a bounce. */
function ndr(subject: string, body: string): Report {
	const code = codeOf(body);
	const delayed = code?.split(' ').some((c) => c.startsWith('4')) === true || DELAYED.test(subject);
	const line =
		body
			.split(/\r?\n/)
			.map((l) => l.trim())
			.find((l) => /\b[245](\d\d|\.\d{1,3}\.\d{1,3})\b/.test(l)) ??
		body.trim().split(/\r?\n/)[0] ??
		'';
	return delayed
		? {
				kind: 'deferred',
				permanent: false,
				...(code === undefined ? {} : { code }),
				reason: line.slice(0, 500)
			}
		: {
				kind: 'bounced',
				permanent: true,
				...(code === undefined ? {} : { code }),
				reason: line.slice(0, 500)
			};
}

const flat = (list: Parsed['to']) =>
	(list ?? [])
		.flatMap((a) => (a.group === undefined ? [a] : a.group))
		.map((a) => ({ address: a.address.toLowerCase(), name: a.name === '' ? null : a.name }));

/**
 * A header's `;` clauses, lower-cased, read as RFC 8601 writes them. A comment nests and a quoted string holds one
 * value, and either can carry text the sender chose, such as an envelope address: none of it may read as a verdict.
 */
const clausesOf = (value: string) => {
	const clauses = [''];
	const keep = (character: string) => {
		clauses[clauses.length - 1] += character.toLowerCase();
	};
	let depth = 0,
		quoted = false;
	for (let at = 0; at < value.length; at += 1) {
		const character = value.charAt(at);
		if (character === '\\') at += 1;
		else if (quoted) {
			quoted = character !== '"';
			if (!/\s/.test(character)) keep(character);
		} else if (character === '(') depth += 1;
		else if (depth > 0) depth -= character === ')' ? 1 : 0;
		else if (character === ';') clauses.push('');
		else {
			quoted = character === '"';
			keep(character);
		}
	}
	return clauses.map((clause) => clause.trim());
};

/**
 * Whether the mail server that received this message vouches for its `From` domain, the only proof of a sender a
 * mailbox has: `From` is free text. Its verdict is the top `Authentication-Results`, since a sender can only add ones
 * below it. `receiver` names that server (`null` for Microsoft's, which names nobody), and with none known nothing is
 * trusted. It takes a DMARC pass for this domain, or a DKIM pass aligned with it, for a domain that publishes no DMARC.
 * SPF proves the envelope only, never `From`.
 */
export const authenticated = (
	headers: readonly { readonly key: string; readonly value: string }[],
	address: string,
	receiver: string | null | undefined
) => {
	const domain = address.split('@').at(-1)?.toLowerCase() ?? '';
	const top = headers.find(({ key }) => key === 'authentication-results')?.value;
	if (
		receiver === undefined ||
		top === undefined ||
		domain === '' ||
		headers.filter(({ key }) => key === 'from').length !== 1
	)
		return false;
	const [first = '', ...rest] = clausesOf(top);
	const verdicts =
		receiver === null ? [first, ...rest] : first.split(/\s+/)[0] === receiver ? rest : [];
	return verdicts.some((clause) => {
		const [verdict, ...properties] = clause.split(/\s+/);
		const property = (name: string) =>
			properties.find((one) => one.startsWith(`${name}=`))?.slice(name.length + 1);
		if (verdict === 'dmarc=pass') return property('header.from') === domain;
		if (verdict !== 'dkim=pass') return false;
		const signer = property('header.d') ?? property('header.i')?.split('@').at(-1);
		return signer === domain || signer?.endsWith(`.${domain}`) === true;
	});
};

/**
 * Reads one raw message. `domain` is the mailbox address's domain: every Message-ID this mailbox sends is `<id@domain>`,
 * so a report names ours only by one of those (an envelope id `id` is ours as `<id@domain>`). `files` replaces its
 * attachments where the bytes were not read whole. A mail the parser refuses is stored from its headers, its raw source
 * the file, so one bad message never holds the cursor. `receiver` is the mail server `authenticated` trusts.
 */
export const readMail = Effect.fn('Mailbox.readMail')(function* (
	source: Uint8Array | string,
	domain: string,
	fallbackId: string,
	deliveryReports: boolean = true,
	receivedAt?: string,
	files?: readonly Named[],
	receiver?: string | null
): Effect.fn.Return<Read> {
	const now = yield* Clock.currentTimeMillis;
	const e =
		source.length === 0
			? null
			: yield* Effect.tryPromise(() =>
					PostalMime.parse(source, {
						forceRfc822Attachments: true,
						attachmentEncoding: 'arraybuffer'
					})
				).pipe(Effect.orElseSucceed(() => null));
	if (e === null) {
		const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : source,
			text = decode(bytes),
			end = text.search(/\r?\n\r?\n/),
			head = fields(end < 0 ? text : text.slice(0, end));
		const id = head.get('message-id') || fallbackId,
			address = /[^\s<>"]+@[^\s<>"]+/.exec(head.get('from') ?? '')?.[0]?.toLowerCase() ?? NOBODY,
			headers = Object.fromEntries(
				['in-reply-to', 'references'].flatMap((name) => {
					const value = head.get(name);
					return value === undefined ? [] : [[name, value]];
				})
			);
		yield* Effect.logWarning(`The email ${id} could not be parsed: storing its raw source`);
		return {
			kind: 'mail',
			from: address,
			id,
			thread: threadOf(headers, id),
			bins: files === undefined ? [bytes] : [],
			message: {
				id,
				thread: null,
				sentAt: sentAtOf(head.get('date'), receivedAt, now),
				from: { address, name: null },
				replyTo: null,
				to: [],
				cc: [],
				subject: head.get('subject')?.slice(0, 998) ?? '',
				text: UNREADABLE,
				html: null,
				headers,
				attachments: files ?? [
					{ name: 'message.eml', mime: 'message/rfc822', bytes: bytes.byteLength, bin: 0 }
				]
			}
		};
	}
	const headers: { [k: string]: string } = {};
	for (const h of e.headers) headers[h.key] ??= h.value;
	const from = flat(e.from === undefined ? [] : [e.from])[0] ?? { address: '', name: null };
	const subject = e.subject ?? '';
	const status = e.attachments.find((a) =>
		/^message\/(global-)?delivery-status$/i.test(a.mimeType)
	);
	const dsnType = /report-type\s*=\s*"?delivery-status/i.test(headers['content-type'] ?? '');
	if (
		deliveryReports &&
		(status !== undefined || dsnType || (DAEMON.test(from.address) && NDR.test(subject)))
	) {
		const original = e.attachments
			.filter((a) =>
				/^(message\/(global-)?rfc822|text\/rfc822-headers|message\/global-headers)$/i.test(
					a.mimeType
				)
			)
			.map((a) => decode(a.content))
			.join('\n');
		const text = e.text ?? '';
		const envid =
			status === undefined
				? undefined
				: fields(decode(status.content).split(/\r?\n\s*\r?\n/)[0] ?? '').get(
						'original-envelope-id'
					);
		const ours = `@${domain.toLowerCase()}>`;
		const ids = [
			...new Set([
				...(envid === undefined || envid === ''
					? []
					: [envid.startsWith('<') ? envid : `<${envid}@${domain}>`]),
				...(fields(original).get('message-id')?.match(MSGID) ?? []),
				...[
					headers['x-original-message-id'],
					headers['in-reply-to'],
					headers['references']
				].flatMap((h) => h?.match(MSGID) ?? []),
				...(original === '' ? (/^\s*message-id:\s*(<[^>]+>)/gim.exec(text)?.slice(1) ?? []) : [])
			])
		].filter((id) => id.toLowerCase().endsWith(ours));
		const report =
			(status === undefined ? null : dsn(decode(status.content))) ?? ndr(subject, text);
		return { kind: 'report', ids, report };
	}
	const bins: Uint8Array[] = [];
	const attachments =
		files ??
		e.attachments.map((a) => {
			const bytes =
				typeof a.content === 'string'
					? new TextEncoder().encode(a.content)
					: new Uint8Array(a.content);
			bins.push(bytes);
			return {
				name: a.filename ?? `attachment-${bins.length}`,
				mime: a.mimeType,
				bytes: bytes.byteLength,
				bin: bins.length - 1
			};
		});
	const id = e.messageId ?? fallbackId;
	return {
		kind: 'mail',
		from: from.address,
		id,
		thread: threadOf(headers, id),
		bins,
		message: {
			id,
			thread: null,
			sentAt: sentAtOf(e.date, receivedAt, now),
			from: from.address === '' ? { ...from, address: NOBODY } : from,
			replyTo: flat(e.replyTo)[0] ?? null,
			to: flat(e.to),
			cc: flat(e.cc),
			subject,
			text: e.text ?? '',
			html: e.html ?? null,
			headers,
			attachments,
			...(authenticated(e.headers, from.address, receiver) ? { authenticated: true } : {})
		}
	};
});
