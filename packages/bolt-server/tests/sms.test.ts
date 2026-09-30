// The SMS port (§5.11.2): `BOLT_SMS` parsing, a Twilio send as Twilio's API takes it, a refusal surfaced, and the log sink.
import { describe, expect, it } from 'vitest';
import { parseSms, smsTransport } from '../src/sms.ts';

const signal = new AbortController().signal;

describe('BOLT_SMS', () => {
	it('reads twilio:<sid>:<token>:<from> and log; anything else is refused with the format', () => {
		expect(parseSms('twilio:AC123:secret:+15551234567')).toEqual({ provider: 'twilio', sid: 'AC123', token: 'secret', from: '+15551234567' });
		expect(parseSms('twilio:AC123:secret:MG999')).toMatchObject({ from: 'MG999' });
		expect(parseSms('log')).toEqual({ provider: 'log' });
		expect(() => parseSms('twilio:AC123:secret:5551234567')).toThrow(/twilio:<account sid/);
		expect(() => parseSms('vonage:x')).toThrow();
	});

	it('posts one message to Twilio with basic auth; a messaging service is named as such', async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const f = (async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return Response.json({ sid: 'SM1' }, { status: 201 });
		}) as unknown as typeof fetch;
		const sms = smsTransport('twilio:AC123:secret:MG999', () => {}, f);
		expect(await sms.send('sms', { to: '+6581234567', text: 'Your sign-in code is 123456.' }, signal)).toEqual({ providerId: 'SM1' });
		expect(calls[0]!.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
		expect((calls[0]!.init.headers as Record<string, string>)['authorization']).toBe(`Basic ${Buffer.from('AC123:secret').toString('base64')}`);
		expect(Object.fromEntries(calls[0]!.init.body as URLSearchParams)).toEqual({ To: '+6581234567', Body: 'Your sign-in code is 123456.', MessagingServiceSid: 'MG999' });
	});

	it('a refused text throws with Twilio\'s reason; a malformed number never reaches Twilio', async () => {
		let reached = false;
		const f = (async () => { reached = true; return Response.json({ message: 'The number is unverified' }, { status: 400 }); }) as unknown as typeof fetch;
		const sms = smsTransport('twilio:AC123:secret:+15551234567', () => {}, f);
		await expect(sms.send('sms', { to: '81234567', text: 'x' }, signal)).rejects.toThrow(/`to`/);
		expect(reached).toBe(false);
		await expect(sms.send('sms', { to: '+6581234567', text: 'x' }, signal)).rejects.toThrow('twilio 400: The number is unverified');
	});

	it('the log sink prints the text and sends nothing', async () => {
		const lines: string[] = [];
		await smsTransport('log', (l) => lines.push(l)).send('sms', { to: '+6581234567', text: 'Your sign-in code is 654321.' }, signal);
		expect(lines).toEqual(['sms → +6581234567: Your sign-in code is 654321.']);
	});
});
