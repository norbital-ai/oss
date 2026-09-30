// A host's transactional messaging from its configuration: the one injected messaging facility (sign-in codes,
// invitations). Email and phone are chosen separately; channels never use it: each is the tenant's own.
import type { TransactionalProvider } from '@norbital-ai/bolt/engine';
import { resendMail } from './resend/mail.ts';
import { sinchMail, sinchSms, sinchVerification, type SinchRegion } from './sinch/index.ts';
import { twilioMessages } from './twilio/messages.ts';
import { twilioVerify } from './twilio/verify.ts';

/**
 * Email: `resend` (from `from`, a domain the Resend account verified) or `sinch` (Mailgun from `noreply@<domain>`,
 * `region` picking its host). Phone: `twilio` (Verify for codes, Messages for texts) or `sinch` (Verification for codes,
 * SMS through a service plan when given). Each part is optional here; the host decides what it requires.
 */
export type TransactionalConfig = {
	email?: { provider: 'resend'; key: string; from: string } | { provider: 'sinch'; key: string; domain: string; region?: SinchRegion };
	phone?: { provider: 'twilio'; accountSid: string; authToken: string }
		| { provider: 'sinch'; region?: SinchRegion; verification: { key: string; secret: string }; sms?: { planId: string; token: string; from: string } };
};

export function transactional(c: TransactionalConfig, o: { fetch?: typeof fetch } = {}): Partial<TransactionalProvider> {
	const f = o.fetch === undefined ? {} : { fetch: o.fetch };
	const e = c.email, p = c.phone;
	const email = e === undefined ? {}
		: { email: e.provider === 'resend' ? resendMail({ key: e.key, from: e.from, ...f }) : sinchMail({ key: e.key, domain: e.domain, ...e.region === undefined ? {} : { region: e.region }, ...f }) };
	if (p === undefined) return email;
	if (p.provider === 'twilio') {
		const account = { accountSid: p.accountSid, authToken: p.authToken, ...f };
		return { ...email, sms: twilioMessages(account), phone: twilioVerify(account) };
	}
	const region = p.region === undefined ? {} : { region: p.region };
	return { ...email, phone: sinchVerification({ ...p.verification, ...f }), ...p.sms === undefined ? {} : { sms: sinchSms({ ...p.sms, ...region, ...f }) } };
}
