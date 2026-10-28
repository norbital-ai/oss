// This host's transactional facilities (sign-in codes, invitations): each one explicit in its settings.
import { Effect } from 'effect';
import type { HttpClient } from 'effect/http/HttpClient';
import { loggedPhone, type Json, type TransportPort } from '@norbital-ai/bolt/engine';
import { off, type Facilities } from '@norbital-ai/bolt/facilities';
import type { ProviderRefused, ProviderUnavailable } from '@norbital-ai/providers';
import type { HostSettings } from './host.ts';
import { resendMail } from './resend.ts';
import { twilioMessages, twilioVerify } from './twilio.ts';

/** One message sent through a provider API. */
export type TransportDef = {
	readonly send: (
		message: Json
	) => Effect.Effect<
		{ readonly providerId: string },
		ProviderRefused | ProviderUnavailable,
		HttpClient
	>;
};
/** A number's sign-in code, sent and checked by the provider. */
export type PhoneVerifierDef = {
	readonly via: readonly ('sms' | 'whatsapp')[];
	readonly start: (
		to: string,
		via: 'sms' | 'whatsapp'
	) => Effect.Effect<void, ProviderRefused | ProviderUnavailable, HttpClient>;
	readonly check: (
		to: string,
		code: string
	) => Effect.Effect<boolean, ProviderRefused | ProviderUnavailable, HttpClient>;
};
export type Run = <A, E>(
	effect: Effect.Effect<A, E, HttpClient>,
	options?: { readonly signal?: AbortSignal | undefined }
) => Promise<A>;

/** A transport that writes each message as one log line (a `log` selection). */
const logged = (kind: string, log: (line: string) => void): TransportPort => ({
	send: async (_kind, message: Json) => {
		log(`${kind} → ${JSON.stringify(message)}`);
		return { providerId: `log-${Date.now()}` };
	}
});

export const messaging = Effect.fn('server.messaging')(function* (
	config: Pick<HostSettings, 'transactional'>,
	run: Run,
	log: (line: string) => void
) {
	const { email, phone } = config.transactional;
	const native = (def: TransportDef): TransportPort => ({
		send: (_kind, message, signal) => run(def.send(message), { signal })
	});
	const twilio = phone === null || phone.provider === 'log' ? undefined : phone;
	const verifier = twilio === undefined ? undefined : yield* twilioVerify(twilio);
	const members: Pick<Facilities['transactional'], 'mail' | 'sms' | 'phone'> = {
		mail: email.provider === 'log' ? logged('mail', log) : native(resendMail(email)),
		sms:
			phone === null
				? off
				: twilio === undefined
					? logged('sms', log)
					: native(yield* twilioMessages(twilio)),
		phone:
			phone === null
				? off
				: verifier === undefined
					? loggedPhone(log)
					: {
							via: verifier.via,
							start: (to, via, signal) => run(verifier.start(to, via), { signal }),
							check: (to, code, signal) => run(verifier.check(to, code), { signal })
						}
	};
	return members;
});
