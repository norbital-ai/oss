// Resend's `POST /emails` as the host's mail port: sign-in codes and invitations. `from` is the host's sender
// (`noreply@<public host>` unless configured), on a domain the Resend account has verified.
import { refusalOf, type Json, type TransportPort } from '@norbital-ai/bolt/engine';

export type ResendMail = { key: string; from: string; fetch?: typeof fetch };

const invalid = (message: string) => Object.assign(new Error(message), { kind: 'invalid' });
const strings = (v: Json | undefined) => (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && x !== '');

export function resendMail(o: ResendMail): TransportPort {
	return {
		async send(_channel, message, signal) {
			const m = (typeof message === 'object' && message !== null && !Array.isArray(message) ? message : {}) as { readonly [k: string]: Json };
			const to = strings(m['to']), cc = strings(m['cc']);
			if (to.length === 0 || typeof m['subject'] !== 'string') throw invalid('an email needs `to` and `subject`');
			const text = typeof m['text'] === 'string' && m['text'] !== '' ? m['text'] : undefined;
			const html = typeof m['html'] === 'string' && m['html'] !== '' ? m['html'] : undefined;
			if (text === undefined && html === undefined) throw invalid('an email needs `text` or `html`');
			const headers = { ...typeof m['thread'] === 'string' ? { 'X-Bolt-Thread': m['thread'] } : {},
				...typeof m['inReplyTo'] === 'string' ? { 'In-Reply-To': m['inReplyTo'], References: strings(m['references']).join(' ') } : {} };
			const res = await (o.fetch ?? fetch)('https://api.resend.com/emails', {
				method: 'POST', signal, headers: { authorization: `Bearer ${o.key}`, 'content-type': 'application/json' },
				body: JSON.stringify({ from: typeof m['from'] === 'string' ? m['from'] : o.from, to, ...cc.length === 0 ? {} : { cc }, subject: m['subject'],
					...text === undefined ? {} : { text }, ...html === undefined ? {} : { html }, ...Object.keys(headers).length === 0 ? {} : { headers } }),
			});
			const body = await res.text();
			if (!res.ok) {
				const reason = (() => { try { return String((JSON.parse(body) as { message?: unknown }).message ?? body); } catch { return body; } })();
				throw Object.assign(new Error(`resend ${res.status}: ${reason}`), { kind: refusalOf(res.status, reason)?.kind ?? 'upstream', status: res.status });
			}
			const id = (() => { try { return (JSON.parse(body) as { id?: unknown }).id; } catch { return undefined; } })();
			return { providerId: typeof id === 'string' ? id : `resend-${Date.now()}` };
		},
		subscribe: () => () => {},
	};
}
