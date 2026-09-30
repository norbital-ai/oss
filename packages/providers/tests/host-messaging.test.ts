// The host's transactional providers against a fake fetch: Twilio Verify (service by friendly name, start by SMS or
// WhatsApp, check), Twilio Messages (sender discovery, the send), Resend emails, Sinch (Mailgun mail, SMS,
// Verification) and the `transactional` factory; refusals as FacilityError kinds.
import { describe, expect, it } from 'vitest';
import { SINCH_REGIONS, resendMail, sinchMail, sinchSms, sinchVerification, transactional, twilioMessages, twilioVerify, type SinchRegion } from '../src/index.ts';

const signal = new AbortController().signal;
type Call = { url: string; method: string; headers: Record<string, string>; body: string };
/** A fetch that records each call and answers from `answer(url, method)`. */
function fake(answer: (url: string, method: string) => Response) {
	const calls: Call[] = [];
	const f = (async (url: string, init: RequestInit) => {
		const method = init.method ?? 'GET';
		calls.push({ url, method, headers: init.headers as Record<string, string>, body: init.body === undefined ? '' : String(init.body) });
		return answer(url, method);
	}) as unknown as typeof fetch;
	return { f, calls };
}
const form = (c: Call) => Object.fromEntries(new URLSearchParams(c.body));
const basic = `Basic ${Buffer.from('AC123:secret').toString('base64')}`;

describe('Twilio Verify', () => {
	it('finds the Norbital service once, starts by SMS or WhatsApp, and checks the code', async () => {
		const { f, calls } = fake((url, method) =>
			url.endsWith('Services?PageSize=1000') ? Response.json({ services: [{ sid: 'VA0', friendly_name: 'Other' }, { sid: 'VA1', friendly_name: 'Norbital' }] })
				: url.endsWith('/Verifications') ? Response.json({ sid: 'VE1', status: 'pending' }, { status: 201 })
					: Response.json({ status: method === 'POST' && calls.at(-1)!.body.includes('Code=424242') ? 'approved' : 'pending' }));
		const v = twilioVerify({ accountSid: 'AC123', authToken: 'secret', fetch: f });
		await v.start('+6581234567', 'sms', signal);
		await v.start('+6581234567', 'whatsapp', signal);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET https://verify.twilio.com/v2/Services?PageSize=1000',
			'POST https://verify.twilio.com/v2/Services/VA1/Verifications', 'POST https://verify.twilio.com/v2/Services/VA1/Verifications']);
		expect(calls[1]!.headers['authorization']).toBe(basic);
		expect(calls[1]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
		expect(form(calls[1]!)).toEqual({ To: '+6581234567', Channel: 'sms' });
		expect(form(calls[2]!)).toEqual({ To: '+6581234567', Channel: 'whatsapp' });
		expect(await v.check('+6581234567', '424242', signal)).toBe(true);
		expect(calls.at(-1)!.url).toBe('https://verify.twilio.com/v2/Services/VA1/VerificationCheck');
		expect(form(calls.at(-1)!)).toEqual({ To: '+6581234567', Code: '424242' });
		expect(await v.check('+6581234567', '000000', signal)).toBe(false);
	});

	it('creates the service when the account has none by that name', async () => {
		const { f, calls } = fake((url, method) => method === 'GET' ? Response.json({ services: [] })
			: url.endsWith('/v2/Services') ? Response.json({ sid: 'VA9' }, { status: 201 }) : Response.json({ status: 'pending' }, { status: 201 }));
		await twilioVerify({ accountSid: 'AC123', authToken: 'secret', fetch: f }).start('+6581234567', 'sms', signal);
		expect(form(calls[1]!)).toEqual({ FriendlyName: 'Norbital' });
		expect(calls[2]!.url).toBe('https://verify.twilio.com/v2/Services/VA9/Verifications');
	});

	it('no pending verification (404) is a wrong code; a refusal throws its FacilityError kind; a failed lookup is retried', async () => {
		let listFails = true;
		const { f } = fake((url) => url.includes('PageSize') ? (listFails ? new Response('down', { status: 503 }) : Response.json({ services: [{ sid: 'VA1', friendly_name: 'Norbital' }] }))
			: url.endsWith('VerificationCheck') ? Response.json({ code: 20404, message: 'The requested resource was not found' }, { status: 404 })
				: Response.json({ code: 60203, message: 'Max send attempts reached' }, { status: 429 }));
		const v = twilioVerify({ accountSid: 'AC123', authToken: 'secret', fetch: f });
		await expect(v.start('+6581234567', 'sms', signal)).rejects.toMatchObject({ kind: 'upstream', status: 503 });
		listFails = false;
		await expect(v.start('+6581234567', 'sms', signal)).rejects.toMatchObject({ kind: 'rateLimited', status: 429, message: 'twilio 429: Max send attempts reached' });
		expect(await v.check('+6581234567', '123456', signal)).toBe(false);
	});
});

describe('Twilio Messages', () => {
	it('sends through the account\'s Messaging Service when it has one, discovered once', async () => {
		const { f, calls } = fake((url) => url.startsWith('https://messaging.twilio.com') ? Response.json({ services: [{ sid: 'MG1' }] })
			: Response.json({ sid: 'SM1' }, { status: 201 }));
		const sms = twilioMessages({ accountSid: 'AC123', authToken: 'secret', fetch: f });
		expect(await sms.send('sms', { to: '+6581234567', text: 'You are invited.' }, signal)).toEqual({ providerId: 'SM1' });
		await sms.send('sms', { to: '+6581234567', text: 'Again.' }, signal);
		expect(calls.map((c) => c.url)).toEqual(['https://messaging.twilio.com/v1/Services?PageSize=1',
			'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json', 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json']);
		expect(calls[1]!.headers['authorization']).toBe(basic);
		expect(form(calls[1]!)).toEqual({ To: '+6581234567', Body: 'You are invited.', MessagingServiceSid: 'MG1' });
	});

	it('else from the first SMS-capable number; none is a failure; a malformed number never reaches Twilio', async () => {
		const numbers = [{ phone_number: '+15550000001', capabilities: { sms: false } }, { phone_number: '+15550000002', capabilities: { sms: true } }];
		const { f, calls } = fake((url) => url.startsWith('https://messaging.twilio.com') ? Response.json({ services: [] })
			: url.includes('IncomingPhoneNumbers') ? Response.json({ incoming_phone_numbers: numbers })
				: Response.json({ code: 21211, message: "The 'To' number is not valid" }, { status: 400 }));
		const sms = twilioMessages({ accountSid: 'AC123', authToken: 'secret', fetch: f });
		await expect(sms.send('sms', { to: '81234567', text: 'x' }, signal)).rejects.toMatchObject({ kind: 'invalid' });
		expect(calls).toEqual([]);
		await expect(sms.send('sms', { to: '+6581234567', text: 'x' }, signal)).rejects.toMatchObject({ kind: 'invalid', status: 400 });
		expect(calls[1]!.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/IncomingPhoneNumbers.json?PageSize=1000');
		expect(form(calls[2]!)).toEqual({ To: '+6581234567', Body: 'x', From: '+15550000002' });
		numbers.length = 0;
		const none = twilioMessages({ accountSid: 'AC123', authToken: 'secret', fetch: f });
		await expect(none.send('sms', { to: '+6581234567', text: 'x' }, signal)).rejects.toThrow(/no Messaging Service and no SMS-capable number/);
	});
});

describe('Resend emails', () => {
	it('posts one email: from, to, cc, subject, text, html, threading headers', async () => {
		const { f, calls } = fake(() => Response.json({ id: 're-1' }));
		const mail = resendMail({ key: 're_k', from: 'noreply@acme.example', fetch: f });
		expect(await mail.send('support', { to: ['a@x.test'], cc: ['b@x.test'], subject: 'Hi', text: 'plain', html: '<p>html</p>', thread: 't1',
			inReplyTo: '<m1@x>', references: ['<m0@x>', '<m1@x>'] }, signal)).toEqual({ providerId: 're-1' });
		expect(calls[0]!.url).toBe('https://api.resend.com/emails');
		expect(calls[0]!.headers['authorization']).toBe('Bearer re_k');
		expect(JSON.parse(calls[0]!.body)).toEqual({ from: 'noreply@acme.example', to: ['a@x.test'], cc: ['b@x.test'], subject: 'Hi', text: 'plain', html: '<p>html</p>',
			headers: { 'X-Bolt-Thread': 't1', 'In-Reply-To': '<m1@x>', References: '<m0@x> <m1@x>' } });
	});

	it('a single address; a refusal throws its FacilityError kind; a malformed message never leaves', async () => {
		const { f, calls } = fake(() => Response.json({ statusCode: 403, name: 'validation_error', message: 'The acme.example domain is not verified.' }, { status: 403 }));
		const mail = resendMail({ key: 're_k', from: 'Norbital <noreply@acme.example>', fetch: f });
		await expect(mail.send('email', { to: 'a@x.test', subject: 'Code', text: 'Your sign-in code is 123456.' }, signal))
			.rejects.toMatchObject({ kind: 'invalid', status: 403, message: 'resend 403: The acme.example domain is not verified.' });
		expect(JSON.parse(calls[0]!.body)).toEqual({ from: 'Norbital <noreply@acme.example>', to: ['a@x.test'], subject: 'Code', text: 'Your sign-in code is 123456.' });
		await expect(mail.send('email', { subject: 'x', text: 'y' }, signal)).rejects.toMatchObject({ kind: 'invalid' });
		await expect(mail.send('email', { to: 'a@x.test', subject: 'x' }, signal)).rejects.toMatchObject({ kind: 'invalid' });
		expect(calls.length).toBe(1);
		const busy = resendMail({ key: 're_k', from: 'n@a.example', fetch: fake(() => Response.json({ message: 'Too many requests' }, { status: 429 })).f });
		await expect(busy.send('email', { to: 'a@x.test', subject: 'x', text: 'y' }, signal)).rejects.toMatchObject({ kind: 'rateLimited' });
		const down = resendMail({ key: 're_k', from: 'n@a.example', fetch: fake(() => new Response('oops', { status: 500 })).f });
		await expect(down.send('email', { to: 'a@x.test', subject: 'x', text: 'y' }, signal)).rejects.toMatchObject({ kind: 'upstream', status: 500 });
	});
});

describe('Sinch', () => {
	it('mails through Mailgun from noreply@<domain>', async () => {
		const { f, calls } = fake(() => Response.json({ id: '<m1@mg.acme.example>', message: 'Queued. Thank you.' }));
		const mail = sinchMail({ key: 'mg-key', domain: 'mg.acme.example', fetch: f });
		expect(await mail.send('support', { to: ['a@x.test', 'b@x.test'], subject: 'Hi', text: 'plain', html: '<p>h</p>', inReplyTo: '<m0@x>', references: ['<m0@x>'] }, signal))
			.toEqual({ providerId: '<m1@mg.acme.example>' });
		expect(calls[0]!.url).toBe('https://api.mailgun.net/v3/mg.acme.example/messages');
		expect(calls[0]!.headers['authorization']).toBe(`Basic ${Buffer.from('api:mg-key').toString('base64')}`);
		const body = new URLSearchParams(calls[0]!.body);
		expect(body.getAll('to')).toEqual(['a@x.test', 'b@x.test']);
		expect(Object.fromEntries([...body].filter(([k]) => k !== 'to'))).toEqual({ from: 'noreply@mg.acme.example', subject: 'Hi', text: 'plain', html: '<p>h</p>',
			'h:In-Reply-To': '<m0@x>', 'h:References': '<m0@x>' });
		await expect(mail.send('email', { subject: 'x', text: 'y' }, signal)).rejects.toMatchObject({ kind: 'invalid' });
		const refused = sinchMail({ key: 'k', domain: 'mg.acme.example', fetch: fake(() => Response.json({ message: 'Domain not found' }, { status: 404 })).f });
		await expect(refused.send('email', { to: 'a@x.test', subject: 'x', text: 'y' }, signal)).rejects.toMatchObject({ kind: 'invalid', message: 'mailgun 404: Domain not found' });
	});

	it('texts through the service plan as a batch of one', async () => {
		const { f, calls } = fake(() => Response.json({ id: 'batch-1' }, { status: 201 }));
		const sms = sinchSms({ planId: 'plan1', token: 'tok', from: '+15550001111', fetch: f });
		expect(await sms.send('sms', { to: '+6581234567', text: 'You are invited.' }, signal)).toEqual({ providerId: 'batch-1' });
		expect(calls[0]!.url).toBe('https://us.sms.api.sinch.com/xms/v1/plan1/batches');
		expect(calls[0]!.headers['authorization']).toBe('Bearer tok');
		expect(JSON.parse(calls[0]!.body)).toEqual({ from: '+15550001111', to: ['+6581234567'], body: 'You are invited.' });
		await expect(sms.send('sms', { to: '81234567', text: 'x' }, signal)).rejects.toMatchObject({ kind: 'invalid' });
		const busy = sinchSms({ planId: 'p', token: 't', from: '+15550001111', fetch: fake(() => Response.json({ text: 'Too many requests' }, { status: 429 })).f });
		await expect(busy.send('sms', { to: '+6581234567', text: 'x' }, signal)).rejects.toMatchObject({ kind: 'rateLimited' });
	});

	it('mails and texts on the region\'s hosts: Mailgun has only US and EU, SMS one per region', async () => {
		const hosts = async (region: SinchRegion) => {
			const { f, calls } = fake(() => Response.json({ id: 'x' }));
			const p = transactional({ email: { provider: 'sinch', region, key: 'k', domain: 'mg.acme.example' },
				phone: { provider: 'sinch', region, verification: { key: 'a', secret: 's' }, sms: { planId: 'p', token: 't', from: '+15550001111' } } }, { fetch: f });
			await p.email!.send('email', { to: 'a@x.test', subject: 'x', text: 'y' }, signal);
			await p.sms!.send('sms', { to: '+6581234567', text: 'x' }, signal);
			return calls.map((c) => new URL(c.url).host);
		};
		expect(await Promise.all(SINCH_REGIONS.map(hosts))).toEqual([
			['api.mailgun.net', 'us.sms.api.sinch.com'], ['api.eu.mailgun.net', 'eu.sms.api.sinch.com'], ['api.mailgun.net', 'au.sms.api.sinch.com'],
			['api.mailgun.net', 'br.sms.api.sinch.com'], ['api.mailgun.net', 'ca.sms.api.sinch.com']]);
	});

	it('verifies by SMS or WhatsApp and reports the code by the method it went by; no pending verification is a wrong code', async () => {
		let status = 'SUCCESSFUL';
		const { f, calls } = fake((_url, method) => method === 'POST' ? Response.json({ id: 'v1', method: 'whatsapp' })
			: status === 'none' ? Response.json({ errorCode: 40400, message: 'Verification not found' }, { status: 404 }) : Response.json({ id: 'v1', status }));
		const v = sinchVerification({ key: 'app', secret: 'sec', fetch: f });
		expect(v.via).toEqual(['sms', 'whatsapp']);
		await v.start('+6581234567', 'whatsapp', signal);
		expect(calls[0]!.url).toBe('https://verification.api.sinch.com/verification/v1/verifications');
		expect(calls[0]!.headers['authorization']).toBe(`Basic ${Buffer.from('app:sec').toString('base64')}`);
		expect(JSON.parse(calls[0]!.body)).toEqual({ identity: { type: 'number', endpoint: '+6581234567' }, method: 'whatsapp' });
		status = 'FAIL';
		expect(await v.check('+6581234567', '000000', signal)).toBe(false);
		status = 'SUCCESSFUL';
		expect(await v.check('+6581234567', '424242', signal)).toBe(true);
		expect(calls[2]!).toMatchObject({ method: 'PUT', url: 'https://verification.api.sinch.com/verification/v1/verifications/number/%2B6581234567' });
		expect(JSON.parse(calls[2]!.body)).toEqual({ method: 'whatsapp', whatsapp: { code: '424242' } });
		await v.start('+6581234567', 'sms', signal);
		status = 'none';
		expect(await v.check('+6581234567', '424242', signal)).toBe(false);
		expect(JSON.parse(calls.at(-1)!.body)).toEqual({ method: 'sms', sms: { code: '424242' } });
	});
});

describe('transactional', () => {
	it('email and phone chosen apart; each part only when configured', () => {
		expect(Object.keys(transactional({}))).toEqual([]);
		expect(Object.keys(transactional({ email: { provider: 'resend', key: 're_k', from: 'noreply@acme.example' } }))).toEqual(['email']);
		const twilio = transactional({ email: { provider: 'resend', key: 're_k', from: 'noreply@acme.example' }, phone: { provider: 'twilio', accountSid: 'AC1', authToken: 't' } });
		expect(Object.keys(twilio).sort()).toEqual(['email', 'phone', 'sms']);
		expect(twilio.phone?.via).toEqual(['sms', 'whatsapp']);
		expect(Object.keys(transactional({ phone: { provider: 'twilio', accountSid: 'AC1', authToken: 't' } })).sort()).toEqual(['phone', 'sms']);
		expect(Object.keys(transactional({ email: { provider: 'sinch', key: 'k', domain: 'd' }, phone: { provider: 'sinch', verification: { key: 'a', secret: 's' } } })).sort())
			.toEqual(['email', 'phone']);
	});
});
