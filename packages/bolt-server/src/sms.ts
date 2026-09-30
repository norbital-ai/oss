// The SMS port (§5.11.2): sign-in codes and invitation links texted to a mobile number, through Twilio from `BOLT_SMS`,
// or printed to the host's log by the `log` sink a local host uses. Outbound only: nothing is received.
import type { Json, TransportPort } from '@norbital-ai/bolt/engine';

/** A text to send: `to` in international form (`+6581234567`). */
type Text = { to: string; text: string };

function decode(message: Json): Text {
	const m = (typeof message === 'object' && message !== null && !Array.isArray(message) ? message : {}) as { readonly [k: string]: Json };
	if (typeof m['to'] !== 'string' || !/^\+[1-9]\d{7,14}$/.test(m['to']) || typeof m['text'] !== 'string') throw new Error('a text needs `to` (+ and its digits) and `text`');
	return { to: m['to'], text: m['text'] };
}

/**
 * `BOLT_SMS`: `twilio:<account sid>:<auth token>:<from>` — `from` a sending number (`+15551234567`) or a messaging service
 * (`MG…`) — or `log`, which prints every text to the host's log instead of sending it (a local host only).
 */
export function parseSms(spec: string): { provider: 'twilio'; sid: string; token: string; from: string } | { provider: 'log' } {
	if (spec === 'log') return { provider: 'log' };
	const [provider, sid, token, from] = spec.split(':');
	if (provider !== 'twilio' || !sid?.startsWith('AC') || !token || !(from !== undefined && (/^\+[1-9]\d{7,14}$/.test(from) || from.startsWith('MG'))))
		throw new Error('BOLT_SMS is twilio:<account sid AC…>:<auth token>:<from +number or MG… service>, or log');
	return { provider, sid, token, from };
}

export function smsTransport(spec: string, log: (line: string) => void, f: typeof fetch = fetch): TransportPort {
	const p = parseSms(spec);
	return {
		async send(_channel, message, signal) {
			const t = decode(message);
			if (p.provider === 'log') {
				log(`sms → ${t.to}: ${t.text}`);
				return { providerId: `log-${Date.now()}` };
			}
			const body = new URLSearchParams({ To: t.to, Body: t.text, ...(p.from.startsWith('MG') ? { MessagingServiceSid: p.from } : { From: p.from }) });
			const res = await f(`https://api.twilio.com/2010-04-01/Accounts/${p.sid}/Messages.json`, {
				method: 'POST', body, signal,
				headers: { authorization: `Basic ${Buffer.from(`${p.sid}:${p.token}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
			});
			const answer = await res.json().catch(() => ({})) as { sid?: string; message?: string };
			if (!res.ok || typeof answer.sid !== 'string') throw new Error(`twilio ${res.status}: ${answer.message ?? 'the text was not accepted'}`);
			return { providerId: answer.sid };
		},
		subscribe: () => () => {},
	};
}
