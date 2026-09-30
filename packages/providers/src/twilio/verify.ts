// Twilio Verify as the host's `PhoneVerifier`: sign-in codes to a mobile number by SMS or WhatsApp, generated and
// checked by Twilio. The Verify service is the account's one named `Norbital`, found (or created) once.
import type { PhoneVerifier } from '@norbital-ai/bolt/engine';
import { twilio, type TwilioAccount } from './messages.ts';

const VERIFY = 'https://verify.twilio.com/v2/Services';

export function twilioVerify(a: TwilioAccount & { name?: string }): PhoneVerifier {
	const name = a.name ?? 'Norbital';
	let service: Promise<string> | undefined;
	const find = async (signal: AbortSignal) => {
		// ponytail: the first page only (1000 services)
		const list = await twilio<{ services?: { sid: string; friendly_name: string }[] }>(a, `${VERIFY}?PageSize=1000`, signal);
		return list.body.services?.find((s) => s.friendly_name === name)?.sid
			?? (await twilio<{ sid: string }>(a, VERIFY, signal, { FriendlyName: name })).body.sid;
	};
	// cached once found; a failed lookup is retried by the next call
	const sid = (signal: AbortSignal) => service ??= find(signal).catch((e: unknown) => { service = undefined; throw e; });
	return {
		via: ['sms', 'whatsapp'], // WhatsApp needs the account's WhatsApp sender enabled for Verify
		async start(to, via, signal) {
			await twilio(a, `${VERIFY}/${await sid(signal)}/Verifications`, signal, { To: to, Channel: via });
		},
		async check(to, code, signal) {
			try {
				const r = await twilio<{ status?: string }>(a, `${VERIFY}/${await sid(signal)}/VerificationCheck`, signal, { To: to, Code: code });
				return r.body.status === 'approved';
			} catch (e) {
				// no pending verification (expired, used, or out of attempts) is a wrong code, not a failure
				if ((e as { status?: number }).status === 404) return false;
				throw e;
			}
		},
	};
}
