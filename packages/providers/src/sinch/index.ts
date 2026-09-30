// Sinch as a host's transactional messaging: mail through Sinch's email API (Mailgun), texted invitations through the
// SMS REST API (a service plan and its API token), and a mobile number's sign-in code by SMS or WhatsApp through the
// Verification API (an application's key and secret). Outbound only.
import { refusalOf, type Json, type PhoneVerifier, type TransportPort } from '@norbital-ai/bolt/engine';

type Fetch = typeof fetch;
const obj = (m: Json) => (typeof m === 'object' && m !== null && !Array.isArray(m) ? m : {}) as { readonly [k: string]: Json };
const strings = (v: Json | undefined) => (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && x !== '');
const invalid = (message: string) => Object.assign(new Error(message), { kind: 'invalid' });

/** The answer's JSON; a refusal throws an `Error` carrying its FacilityError kind (429 `rateLimited`, 4xx `invalid`, else `upstream`). */
async function answer<T>(who: string, res: Response): Promise<T> {
	const text = await res.text();
	if (res.ok) return (text === '' ? {} : JSON.parse(text)) as T;
	const reason = (() => { try { const b = JSON.parse(text) as { message?: unknown; text?: unknown }; return String(b.message ?? b.text ?? text); } catch { return text; } })();
	throw Object.assign(new Error(`${who} ${res.status}: ${reason}`), { kind: refusalOf(res.status, reason)?.kind ?? 'upstream', status: res.status });
}
/**
 * The Sinch region an account's APIs live in: SMS has one host per region (`<region>.sms.api.sinch.com`); Mailgun only a
 * US and an EU one, so `au`, `br` and `ca` mail through the US host; Verification is one global host.
 */
export const SINCH_REGIONS = ['us', 'eu', 'au', 'br', 'ca'] as const;
export type SinchRegion = typeof SINCH_REGIONS[number];
const mailgunHost = (region: SinchRegion = 'us') => region === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net';

const basic = (user: string, secret: string) => `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`;

/**
 * Mail through Mailgun (Sinch's email API) from `noreply@<domain>`, `domain` the account's verified sending domain,
 * on the region's host (an EU-hosted domain is served only by `api.eu.mailgun.net`).
 */
export function sinchMail(o: { key: string; domain: string; region?: SinchRegion; fetch?: Fetch }): TransportPort {
	return {
		async send(_channel, message, signal) {
			const m = obj(message), to = strings(m['to']);
			if (to.length === 0 || typeof m['subject'] !== 'string') throw invalid('an email needs `to` and `subject`');
			if (typeof m['text'] !== 'string' && typeof m['html'] !== 'string') throw invalid('an email needs `text` or `html`');
			const form = new URLSearchParams({ from: typeof m['from'] === 'string' ? m['from'] : `noreply@${o.domain}`, subject: m['subject'] });
			for (const x of to) form.append('to', x);
			for (const x of strings(m['cc'])) form.append('cc', x);
			if (typeof m['text'] === 'string') form.set('text', m['text']);
			if (typeof m['html'] === 'string') form.set('html', m['html']);
			if (typeof m['thread'] === 'string') form.set('h:X-Bolt-Thread', m['thread']);
			if (typeof m['inReplyTo'] === 'string') { form.set('h:In-Reply-To', m['inReplyTo']); form.set('h:References', strings(m['references']).join(' ')); }
			const sent = await answer<{ id?: string }>('mailgun', await (o.fetch ?? fetch)(`https://${mailgunHost(o.region)}/v3/${o.domain}/messages`, {
				method: 'POST', signal, body: form, headers: { authorization: basic('api', o.key), 'content-type': 'application/x-www-form-urlencoded' } }));
			return { providerId: sent.id ?? `mailgun-${Date.now()}` };
		},
		subscribe: () => () => {},
	};
}

/** Texts `{ to: '+…', text }` from `from` through a service plan, on its region's host (a plan answers only there). */
export function sinchSms(o: { planId: string; token: string; from: string; region?: SinchRegion; fetch?: Fetch }): TransportPort {
	return {
		async send(_channel, message, signal) {
			const m = obj(message);
			if (typeof m['to'] !== 'string' || !/^\+[1-9]\d{7,14}$/.test(m['to']) || typeof m['text'] !== 'string') throw invalid('a text needs `to` (+ and its digits) and `text`');
			const sent = await answer<{ id: string }>('sinch sms', await (o.fetch ?? fetch)(`https://${o.region ?? 'us'}.sms.api.sinch.com/xms/v1/${o.planId}/batches`, {
				method: 'POST', signal, headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ from: o.from, to: [m['to']], body: m['text'] }) }));
			return { providerId: sent.id };
		},
		subscribe: () => () => {},
	};
}

/**
 * A mobile number's code by SMS or WhatsApp, generated and checked by Sinch Verification. The application must send
 * six-digit numeric codes (its dashboard settings), since sign-in takes six digits.
 */
export function sinchVerification(o: { key: string; secret: string; fetch?: Fetch }): PhoneVerifier {
	const base = 'https://verification.api.sinch.com/verification/v1/verifications';
	const headers = { authorization: basic(o.key, o.secret), 'content-type': 'application/json' };
	// the method a number's code went by, which its report names; ponytail: per process, a restart reports as SMS
	const method = new Map<string, 'sms' | 'whatsapp'>();
	return {
		via: ['sms', 'whatsapp'],
		async start(to, via, signal) {
			await answer('sinch verification', await (o.fetch ?? fetch)(base, { method: 'POST', signal, headers,
				body: JSON.stringify({ identity: { type: 'number', endpoint: to }, method: via }) }));
			method.set(to, via);
		},
		async check(to, code, signal) {
			const via = method.get(to) ?? 'sms';
			const res = await (o.fetch ?? fetch)(`${base}/number/${encodeURIComponent(to)}`, { method: 'PUT', signal, headers,
				body: JSON.stringify({ method: via, [via]: { code } }) });
			if (res.status === 404) return false; // no verification pending for the number
			const r = await answer<{ status?: string }>('sinch verification', res);
			if (r.status === 'SUCCESSFUL') method.delete(to);
			return r.status === 'SUCCESSFUL';
		},
	};
}

