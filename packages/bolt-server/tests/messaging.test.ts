// The host's messaging from `BOLT_TRANSACTIONAL_EMAIL` and `BOLT_TRANSACTIONAL_PHONE` (§5.11.2): the keys checked at
// start, the providers they wire (Resend or Sinch mail; Twilio Verify + Messages or Sinch Verification + SMS), and a
// local host without them printing to its log.
import { describe, expect, it } from 'vitest';
import { decodeConfig } from '../src/config.ts';
import { messaging } from '../src/mail.ts';

const signal = new AbortController().signal;
const config = (over: { [k: string]: string } = {}) => decodeConfig({ BOLT_ARTIFACT: '/a', BOLT_PGLITE_DIR: '/d', BOLT_PUBLIC_URL: 'https://acme.example', ...over });
const resend = { BOLT_TRANSACTIONAL_EMAIL: 'resend', BOLT_RESEND_API_KEY: 're_key' };
const twilio = { BOLT_TRANSACTIONAL_PHONE: 'twilio', BOLT_TWILIO_ACC_SID: 'AC123', BOLT_TWILIO_AUTH_TOKEN: 'secret' };
const sinch = { BOLT_TRANSACTIONAL_EMAIL: 'sinch', BOLT_TRANSACTIONAL_PHONE: 'sinch', BOLT_SINCH_MAILGUN_KEY: 'mg', BOLT_SINCH_MAILGUN_DOMAIN: 'mg.acme.example',
	BOLT_SINCH_SMS_PLAN_ID: 'plan', BOLT_SINCH_SMS_TOKEN: 'tok', BOLT_SINCH_SMS_FROM: '+15550001111', BOLT_SINCH_VERIFICATION_KEY: 'app', BOLT_SINCH_VERIFICATION_SECRET: 'sec' };

/** A fetch answering every provider's happy path, recording URLs. */
function fake() {
	const urls: string[] = [], bodies: string[] = [];
	const f = (async (url: string, init: RequestInit) => {
		urls.push(url);
		bodies.push(String(init.body ?? ''));
		if (url.endsWith('PageSize=1000')) return Response.json({ services: [{ sid: 'VA1', friendly_name: 'Norbital' }] });
		if (url.startsWith('https://messaging.twilio.com')) return Response.json({ services: [{ sid: 'MG1' }] });
		return Response.json({ id: 'x', sid: 'X1', status: 'pending' }, { status: 201 });
	}) as unknown as typeof fetch;
	return { f, urls, bodies };
}

describe('BOLT_TRANSACTIONAL_EMAIL and BOLT_TRANSACTIONAL_PHONE', () => {
	it('reads each selection and its keys; a selected provider needs its keys, and a key no selection uses refuses', () => {
		expect(config().transactional).toBeNull();
		expect(config({ ...resend, ...twilio }).transactional).toEqual({ email: { provider: 'resend', key: 're_key', from: 'noreply@acme.example' },
			phone: { provider: 'twilio', accountSid: 'AC123', authToken: 'secret' } });
		expect(config({ ...resend, BOLT_RESEND_FROM: 'Acme <hi@acme.example>' }).transactional).toEqual({ email: { provider: 'resend', key: 're_key', from: 'Acme <hi@acme.example>' } });
		expect(config(twilio).transactional).toEqual({ phone: { provider: 'twilio', accountSid: 'AC123', authToken: 'secret' } });
		expect(config({ ...resend, BOLT_TRANSACTIONAL_PHONE: 'none' }).transactional).toEqual({ email: { provider: 'resend', key: 're_key', from: 'noreply@acme.example' } });
		expect(config(sinch).transactional).toMatchObject({ email: { provider: 'sinch', key: 'mg', domain: 'mg.acme.example', region: 'us' },
			phone: { provider: 'sinch', sms: { planId: 'plan' }, verification: { key: 'app' } } });
		expect(() => config({ BOLT_TRANSACTIONAL_EMAIL: 'resend' })).toThrow(/BOLT_TRANSACTIONAL_EMAIL=resend needs BOLT_RESEND_API_KEY/);
		expect(() => config({ BOLT_TRANSACTIONAL_EMAIL: 'sinch' })).toThrow(/BOLT_SINCH_MAILGUN_KEY/);
		expect(() => config({ BOLT_TRANSACTIONAL_PHONE: 'twilio' })).toThrow(/BOLT_TWILIO_ACC_SID and BOLT_TWILIO_AUTH_TOKEN/);
		expect(() => config({ BOLT_TRANSACTIONAL_PHONE: 'sinch' })).toThrow(/BOLT_SINCH_VERIFICATION_KEY/);
		expect(() => config({ ...twilio, BOLT_TWILIO_AUTH_TOKEN: '' })).toThrow(/BOLT_TWILIO_ACC_SID, BOLT_TWILIO_AUTH_TOKEN together/);
		expect(() => config({ ...twilio, BOLT_TWILIO_ACC_SID: 'XX1' })).toThrow(/AC…/);
		expect(() => config({ ...sinch, BOLT_SINCH_SMS_FROM: '' })).toThrow(/Sinch SMS needs/);
		expect(config({ ...sinch, BOLT_SINCH_REGION: 'eu' }).transactional).toMatchObject({ email: { region: 'eu' }, phone: { region: 'eu' } });
		expect(() => config({ ...sinch, BOLT_SINCH_REGION: 'sg' })).toThrow(/BOLT_SINCH_REGION is one of us, eu, au, br, ca, not 'sg'/);
		expect(() => config({ ...sinch, BOLT_TWILIO_ACC_SID: 'AC1' })).toThrow(/BOLT_TWILIO_ACC_SID is set but no selection uses it \(BOLT_TRANSACTIONAL_PHONE=twilio\)/);
		expect(() => config({ ...resend, ...twilio, BOLT_SINCH_MAILGUN_KEY: 'mg' })).toThrow(/BOLT_SINCH_MAILGUN_KEY is set but no selection uses it/);
		expect(() => config({ ...resend, BOLT_SINCH_REGION: 'eu' })).toThrow(/BOLT_TRANSACTIONAL_EMAIL=sinch or BOLT_TRANSACTIONAL_PHONE=sinch/);
		expect(() => config({ BOLT_RESEND_API_KEY: 're' })).toThrow(/BOLT_TRANSACTIONAL_EMAIL=resend/);
		expect(() => config({ BOLT_TRANSACTIONAL_EMAIL: 'sendgrid' })).toThrow(/resend or sinch, not 'sendgrid'/);
		expect(() => config({ BOLT_TRANSACTIONAL_PHONE: 'vonage' })).toThrow(/twilio, sinch or none/);
		expect(() => config({ BOLT_TRANSACTIONAL_PROVIDER: 'twilio' })).toThrow(/unknown configuration: BOLT_TRANSACTIONAL_PROVIDER/);
		expect(() => config({ BOLT_MAIL: 'smtp://127.0.0.1:2525' })).toThrow(/unknown configuration: BOLT_MAIL/);
		expect(config().local).toBe(false);
		expect(config({ BOLT_PUBLIC_URL: 'http://localhost:3100' }).local).toBe(true);
		expect(config({ BOLT_PUBLIC_URL: 'http://localhost:3100', BOLT_ENVIRONMENT: 'production' }).local).toBe(false);
	});

	it('resend + twilio wires Resend from noreply@<public host>, Verify and Messages to the one account', async () => {
		const { f, urls, bodies } = fake();
		const m = messaging(config({ ...resend, ...twilio }), () => {}, f);
		await m.email!.send('email', { to: 'a@x.test', subject: 'Code', text: 'Your sign-in code is 123456.' }, signal);
		expect(JSON.parse(bodies[0]!)).toMatchObject({ from: 'noreply@acme.example', to: ['a@x.test'] });
		await m.phone!.start('+6581234567', 'whatsapp', signal);
		await m.sms!.send('sms', { to: '+6581234567', text: 'You are invited.' }, signal);
		expect(urls).toEqual(['https://api.resend.com/emails', 'https://verify.twilio.com/v2/Services?PageSize=1000',
			'https://verify.twilio.com/v2/Services/VA1/Verifications', 'https://messaging.twilio.com/v1/Services?PageSize=1',
			'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json']);
	});

	it('sinch wires Mailgun, SMS and Verification; without phone numbers cannot sign in', async () => {
		const { f, urls } = fake();
		const m = messaging(config(sinch), () => {}, f);
		await m.email!.send('email', { to: 'a@x.test', subject: 'Code', text: 'x' }, signal);
		await m.phone!.start('+6581234567', 'sms', signal);
		await m.sms!.send('sms', { to: '+6581234567', text: 'You are invited.' }, signal);
		expect(urls).toEqual(['https://api.mailgun.net/v3/mg.acme.example/messages', 'https://verification.api.sinch.com/verification/v1/verifications',
			'https://us.sms.api.sinch.com/xms/v1/plan/batches']);
		expect(Object.keys(messaging(config({ BOLT_TRANSACTIONAL_EMAIL: 'sinch', BOLT_SINCH_MAILGUN_KEY: 'mg', BOLT_SINCH_MAILGUN_DOMAIN: 'd' }), () => {}, f))).toEqual(['email']);
	});

	it('a local host without a provider prints mail, texts and phone codes as `(sign-in code …)`; a deployed one gets nothing', async () => {
		const lines: string[] = [];
		const local = messaging(config({ BOLT_PUBLIC_URL: 'http://localhost:3100' }), (l) => lines.push(l));
		await local.email!.send('email', { to: 'a@x.test', subject: 'Your sign-in code', text: 'Your sign-in code is 654321.' }, signal);
		await local.sms!.send('sms', { to: '+6581234567', text: 'You are invited: https://acme.example/invite/1' }, signal);
		await local.phone!.start('+6581234567', 'whatsapp', signal);
		expect(lines.slice(0, 2)).toEqual(['mail → a@x.test: Your sign-in code (sign-in code 654321)', 'sms → +6581234567: You are invited: https://acme.example/invite/1']);
		const code = /sign-in code (\d{6})\)/.exec(lines[2]!)?.[1];
		expect(lines[2]).toMatch(/^whatsapp → \+6581234567: /);
		expect(await local.phone!.check('+6581234567', code!, signal)).toBe(true);
		expect(await local.phone!.check('+6581234567', code!, signal)).toBe(false);   // single use
		expect(messaging(config(), () => {})).toEqual({});
		// a local host with only phone configured still prints its mail
		const phoneOnly = messaging(config({ BOLT_PUBLIC_URL: 'http://localhost:3100', ...twilio }), () => lines.push('printed'), fake().f);
		await phoneOnly.email!.send('email', { to: 'a@x.test', subject: 'x', text: 'y' }, signal);
		expect(lines.at(-1)).toBe('printed');
	});
});
