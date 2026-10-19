// Host configuration selects the injected transactional messaging facilities.
import { Effect } from 'effect';
import { resendMail } from './resend/mail.ts';
import { sinchMail, sinchSms, sinchVerification, type SinchRegion } from './sinch/index.ts';
import { twilioMessages } from './twilio/messages.ts';
import { twilioVerify } from './twilio/verify.ts';
import type { PhoneVerifierDef, TransportDef } from './transport.ts';

export type TransactionalConfig = {
	email?:
		| { provider: 'resend'; key: string; from: string }
		| { provider: 'sinch'; key: string; domain: string; region?: SinchRegion };
	phone?:
		| { provider: 'twilio'; accountSid: string; authToken: string }
		| {
				provider: 'sinch';
				region?: SinchRegion;
				verification: { key: string; secret: string };
				sms?: { planId: string; token: string; from: string };
		  };
};
export type TransactionalDef = {
	readonly email: TransportDef;
	readonly sms: TransportDef;
	readonly phone: PhoneVerifierDef;
};

export const transactional = Effect.fn('Providers.transactional')(function* (
	configuration: TransactionalConfig
): Effect.fn.Return<Partial<TransactionalDef>> {
	const email = configuration.email,
		phone = configuration.phone;
	const result: Partial<TransactionalDef> =
		email === undefined
			? {}
			: {
					email: email.provider === 'resend' ? resendMail(email) : sinchMail(email)
				};
	if (phone === undefined) return result;
	if (phone.provider === 'twilio')
		return { ...result, sms: yield* twilioMessages(phone), phone: yield* twilioVerify(phone) };
	return {
		...result,
		phone: sinchVerification(phone.verification),
		...(phone.sms === undefined
			? {}
			: {
					sms: sinchSms({
						...phone.sms,
						...(phone.region === undefined ? {} : { region: phone.region })
					})
				})
	};
});
