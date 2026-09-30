// Twilio's Messages API as the host's SMS port: invitation links texted to a mobile number. The sender is discovered
// from the account, once: its first Messaging Service, else its first SMS-capable number. Outbound only.
import { refusalOf, type Json, type TransportPort } from '@norbital-ai/bolt/engine';

export type TwilioAccount = { accountSid: string; authToken: string; fetch?: typeof fetch };

/**
 * One call to a Twilio REST API with the account's basic auth; a form body when `form` is given. A refusal throws an
 * `Error` carrying the `FacilityError` kind it maps to (429 `rateLimited`, another 4xx `invalid`, else `upstream`).
 */
export async function twilio<T>(a: TwilioAccount, url: string, signal: AbortSignal, form?: { readonly [k: string]: string }): Promise<{ status: number; body: T }> {
	const res = await (a.fetch ?? fetch)(url, {
		method: form === undefined ? 'GET' : 'POST', signal,
		headers: { authorization: `Basic ${Buffer.from(`${a.accountSid}:${a.authToken}`).toString('base64')}`,
			...(form === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }) },
		...(form === undefined ? {} : { body: new URLSearchParams(form) }),
	});
	const text = await res.text();
	if (res.ok) return { status: res.status, body: JSON.parse(text) as T };
	const message = (() => { try { return String((JSON.parse(text) as { message?: unknown }).message ?? text); } catch { return text; } })();
	throw Object.assign(new Error(`twilio ${res.status}: ${message}`), { kind: refusalOf(res.status, message)?.kind ?? 'upstream', status: res.status });
}

function decode(message: Json): { to: string; text: string } {
	const m = (typeof message === 'object' && message !== null && !Array.isArray(message) ? message : {}) as { readonly [k: string]: Json };
	if (typeof m['to'] !== 'string' || !/^\+[1-9]\d{7,14}$/.test(m['to']) || typeof m['text'] !== 'string')
		throw Object.assign(new Error('a text needs `to` (+ and its digits) and `text`'), { kind: 'invalid' });
	return { to: m['to'], text: m['text'] };
}

/** The SMS port over the account's Messages API; `send` takes `{ to: '+…', text }`. */
export function twilioMessages(a: TwilioAccount): TransportPort {
	let sender: Promise<{ MessagingServiceSid: string } | { From: string }> | undefined;
	const discover = async (signal: AbortSignal) => {
		const services = await twilio<{ services?: { sid: string }[] }>(a, 'https://messaging.twilio.com/v1/Services?PageSize=1', signal);
		const service = services.body.services?.[0]?.sid;
		if (service !== undefined) return { MessagingServiceSid: service };
		// ponytail: the first page only (1000 numbers); an account with more and none SMS-capable there sends nothing
		const numbers = await twilio<{ incoming_phone_numbers?: { phone_number: string; capabilities?: { sms?: boolean } }[] }>(a,
			`https://api.twilio.com/2010-04-01/Accounts/${a.accountSid}/IncomingPhoneNumbers.json?PageSize=1000`, signal);
		const from = numbers.body.incoming_phone_numbers?.find((n) => n.capabilities?.sms === true)?.phone_number;
		if (from === undefined) throw Object.assign(new Error('twilio: the account has no Messaging Service and no SMS-capable number to send from'), { kind: 'upstream' });
		return { From: from };
	};
	return {
		async send(_channel, message, signal) {
			const t = decode(message);
			// cached once found; a failed discovery is retried by the next send
			const from = await (sender ??= discover(signal).catch((e: unknown) => { sender = undefined; throw e; }));
			const sent = await twilio<{ sid: string }>(a, `https://api.twilio.com/2010-04-01/Accounts/${a.accountSid}/Messages.json`, signal,
				{ To: t.to, Body: t.text, ...from });
			return { providerId: sent.body.sid };
		},
		subscribe: () => () => {},
	};
}
