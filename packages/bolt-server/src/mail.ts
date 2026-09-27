// The email transport (§5.11.2 mail port, rule 61): outbound through Resend or SMTP from `BOLT_MAIL`, inbound through
// Resend's Svix-signed webhook (`BOLT_EMAIL_IN_*`, decoded by the engine's `resendEvent`), and the dev sink `bolt dev`
// and tests use. One `TransportPort` serves sign-in codes and email channels alike.
import { randomUUID } from 'node:crypto';
import { connect as tcp, type Socket } from 'node:net';
import { connect as tls, type TLSSocket } from 'node:tls';
import type { Json, TransportEvent, TransportPort } from '@norbital-ai/bolt/engine';

type Mail = { to: string[]; subject: string; text?: string; html?: string; thread?: string; headers?: { readonly [name: string]: string } };
export type Sender = (mail: Mail, signal: AbortSignal) => Promise<string>;

function decode(message: Json): Mail {
	const m = (typeof message === 'object' && message !== null && !Array.isArray(message) ? message : {}) as { readonly [k: string]: Json };
	const to = (Array.isArray(m['to']) ? m['to'] : [m['to']]).filter((x): x is string => typeof x === 'string' && x !== '');
	if (to.length === 0 || typeof m['subject'] !== 'string') throw new Error('an email needs `to` and `subject`');
	const headers = typeof m['headers'] === 'object' && m['headers'] !== null && !Array.isArray(m['headers'])
		? Object.fromEntries(Object.entries(m['headers']).filter(([, v]) => typeof v === 'string')) as { [k: string]: string } : undefined;
	return { to, subject: m['subject'], ...(typeof m['text'] === 'string' ? { text: m['text'] } : {}), ...(typeof m['html'] === 'string' ? { html: m['html'] } : {}),
		...(typeof m['thread'] === 'string' ? { thread: m['thread'] } : {}), ...(headers === undefined ? {} : { headers }) };
}

/** A transport over `send`; inbound events arrive through `deliver` (the Resend webhook route). */
export function mailTransport(send: Sender): TransportPort & { deliver(event: TransportEvent): Promise<void> } {
	const sinks = new Set<(e: TransportEvent) => Promise<void>>();
	return {
		send: async (_channel, message, signal) => ({ providerId: await send(decode(message), signal) }),
		subscribe(sink) { sinks.add(sink); return () => { sinks.delete(sink); }; },
		async deliver(event) { for (const s of sinks) await s(event); },
	};
}

/** `BOLT_MAIL`: `smtp://` / `smtps://` URL, or a Resend key (`re_…`); `?from=` names the sender, else `noreply@<public host>`. */
export function mailSender(spec: string, publicUrl: string, f: typeof fetch = fetch): Sender {
	const q = spec.indexOf('?'), params = new URLSearchParams(q < 0 ? '' : spec.slice(q + 1));
	const from = params.get('from') ?? `noreply@${new URL(publicUrl).hostname}`;
	if (/^re_/.test(spec)) {
		const key = q < 0 ? spec : spec.slice(0, q);
		return async (mail, signal) => {
			const res = await f('https://api.resend.com/emails', { method: 'POST', signal,
				headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
				body: JSON.stringify({ from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html,
					headers: { ...mail.headers, ...(mail.thread === undefined ? {} : { 'X-Bolt-Thread': mail.thread }) } }) });
			const body = await res.json().catch(() => ({})) as { id?: string; message?: string };
			if (!res.ok || typeof body.id !== 'string') throw new Error(`Resend answered ${res.status}: ${body.message ?? ''}`);
			return body.id;
		};
	}
	const url = new URL(spec);
	if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') throw new Error('BOLT_MAIL is an smtp:// or smtps:// URL, or a Resend key');
	return (mail, signal) => smtp(url, from, mail, signal);
}

/** The dev sink (rule 38a(f)): `bolt dev` and tests only; the code is the fixed one and mail is captured. */
export function devSink(): Sender & { mail: Mail[] } {
	const mail: Mail[] = [];
	return Object.assign(async (m: Mail) => { mail.push(m); return `dev-${mail.length}`; }, { mail });
}

// ── a minimal SMTP client: EHLO, STARTTLS when offered, AUTH PLAIN, one message ──
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const word = (s: string) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
const wrap = (s: string) => b64(s).replace(/.{76}/g, '$&\r\n');
export function rfc5322(from: string, mail: Mail, id: string): string {
	const head = [`From: ${from}`, `To: ${mail.to.join(', ')}`, `Subject: ${word(mail.subject)}`, `Date: ${new Date().toUTCString()}`,
		`Message-ID: <${id}@${from.split('@')[1] ?? 'bolt'}>`, 'MIME-Version: 1.0', ...Object.entries(mail.headers ?? {}).map(([k, v]) => `${k}: ${v}`)];
	const part = (type: string, body: string) => `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(body)}`;
	if (mail.html === undefined) return `${head.join('\r\n')}\r\n${part('text/plain', mail.text ?? '')}`;
	const boundary = `b-${id}`;
	return `${head.join('\r\n')}\r\nContent-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n--${boundary}\r\n${part('text/plain', mail.text ?? '')}\r\n`
		+ `--${boundary}\r\n${part('text/html', mail.html)}\r\n--${boundary}--`;
}
async function smtp(url: URL, from: string, mail: Mail, signal: AbortSignal): Promise<string> {
	const host = url.hostname, port = Number(url.port || (url.protocol === 'smtps:' ? 465 : 587));
	let socket: Socket | TLSSocket = url.protocol === 'smtps:' ? tls({ host, port, servername: host }) : tcp({ host, port });
	let buffer = '', waiting: ((line: string) => void) | null = null, failed: Error | null = null;
	const onData = (d: Buffer) => { buffer += d.toString('utf8'); pump(); };
	const pump = () => {
		const m = /^(\d{3}) .*\r?\n/m.exec(buffer);
		if (m === null || waiting === null) return;
		const reply = buffer.slice(0, m.index + m[0].length);
		buffer = buffer.slice(reply.length);
		const w = waiting; waiting = null; w(reply);
	};
	const listen = (s: Socket | TLSSocket) => {
		s.on('data', onData);
		s.on('error', (e) => { failed = e; waiting?.(''); });
	};
	listen(socket);
	signal.addEventListener('abort', () => socket.destroy(new Error('the mail call hit its wall')), { once: true });
	const reply = (expect: number) => new Promise<string>((resolve, reject) => {
		waiting = (r) => failed !== null ? reject(failed) : Number(r.slice(0, 3)) === expect ? resolve(r) : reject(new Error(`SMTP: ${r.trim()}`));
		pump();
	});
	const say = async (line: string, expect: number) => { socket.write(`${line}\r\n`); return reply(expect); };
	try {
		await reply(220);
		let ehlo = await say(`EHLO bolt`, 250);
		if (url.protocol === 'smtp:' && /STARTTLS/i.test(ehlo)) {
			await say('STARTTLS', 220);
			socket.off('data', onData);
			socket = tls({ socket, servername: host });
			listen(socket);
			ehlo = await say('EHLO bolt', 250);
		} else if (url.protocol === 'smtp:' && url.username !== '' && !['localhost', '127.0.0.1'].includes(host))
			throw new Error('SMTP: the server offers no STARTTLS; refusing to send credentials in clear');
		if (url.username !== '') await say(`AUTH PLAIN ${b64(`\u0000${decodeURIComponent(url.username)}\u0000${decodeURIComponent(url.password)}`)}`, 235);
		await say(`MAIL FROM:<${from}>`, 250);
		for (const to of mail.to) await say(`RCPT TO:<${to}>`, 250);
		await say('DATA', 354);
		const id = randomUUID();
		await say(`${rfc5322(from, mail, id).replace(/^\./gm, '..')}\r\n.`, 250);
		socket.write('QUIT\r\n');
		return id;
	} finally {
		socket.end();
	}
}
