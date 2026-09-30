// The host's own messaging (§5.11.2): sign-in codes and invitations. `BOLT_TRANSACTIONAL_EMAIL` and
// `BOLT_TRANSACTIONAL_PHONE` select the providers (from `@norbital-ai/providers`); this file only wires what `config.ts` decoded.
// A local host without them prints every message to its log instead; `devSink` captures mail for tests.
import { loggedPhone, type Json, type TransactionalProvider, type TransportEvent, type TransportPort } from '@norbital-ai/bolt/engine';
import { transactional } from '@norbital-ai/providers';
import type { Config } from './config.ts';

type Mail = { to: string[]; subject: string; text?: string; html?: string };
/** What sends one message: the mail port's `send`. */
export type Sender = TransportPort['send'];

const obj = (message: Json) => (typeof message === 'object' && message !== null && !Array.isArray(message) ? message : {}) as { readonly [k: string]: Json };

/** A transport over `send`; inbound events arrive through `deliver` (the email hook). */
export function mailTransport(send: Sender): TransportPort & { deliver(event: TransportEvent): Promise<void> } {
	const sinks = new Set<(e: TransportEvent) => Promise<void>>();
	return {
		send,
		subscribe(sink) { sinks.add(sink); return () => { sinks.delete(sink); }; },
		async deliver(event) { for (const s of sinks) await s(event); },
	};
}

/** The dev sink (rule 38a(f)): tests only; mail is captured, nothing leaves. */
export function devSink(): Sender & { mail: Mail[] } {
	const mail: Mail[] = [];
	return Object.assign(async (_channel: string, message: Json) => {
		const m = obj(message);
		mail.push({ to: (Array.isArray(m['to']) ? m['to'] : [m['to']]).filter((x): x is string => typeof x === 'string'), subject: String(m['subject'] ?? ''),
			...(typeof m['text'] === 'string' ? { text: m['text'] } : {}), ...(typeof m['html'] === 'string' ? { html: m['html'] } : {}) });
		return { providerId: `dev-${mail.length}` };
	}, { mail });
}

/**
 * A local host's sink: every message printed to the log, a sign-in code as `(sign-in code 123456)` (the local loop's
 * tooling reads that line).
 */
export function logSink(kind: 'mail' | 'sms', log: (line: string) => void): TransportPort {
	return {
		async send(_channel, message) {
			const m = obj(message), text = String(m['text'] ?? '');
			const code = /\b(\d{6})\b/.exec(text)?.[1];
			log(`${kind} → ${[m['to']].flat().join(', ')}: ${String(m['subject'] ?? text)}${code === undefined ? '' : ` (sign-in code ${code})`}`);
			return { providerId: `log-${Date.now()}` };
		},
		subscribe: () => () => {},
	};
}

/**
 * The identity host's messaging: the configured transactional providers, each part not configured, on a
 * local host, a log sink (mail and texts printed, a number's code printed by `loggedPhone`; `fixed` is 38a(f)'s
 * 123456), else nothing (`requirements` refuses such a start).
 */
export function messaging(c: Config, log: (line: string) => void, f: typeof fetch = fetch, sink = c.local, fixed = false): Partial<TransactionalProvider> {
	const configured = c.transactional === null ? {} : transactional(c.transactional, { fetch: f });
	return sink ? { email: logSink('mail', log), sms: logSink('sms', log), phone: loggedPhone(log, fixed), ...configured } : configured;
}
