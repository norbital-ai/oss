// SMS through Twilio: signed form posts, TwiML answers, and the REST API behind `fetch`.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider } from '../../src/chat/adapter.ts';
import { twilioSms } from '../../src/chat/twilio-sms/index.ts';
import { file, HOOK, host } from '../kit.ts';
import { connected, json, platformApi, type Call } from './kit.ts';

const SID = `AC${'1'.repeat(32)}`;
const settings = { accountSid: SID, authToken: 'auth-token', phoneNumber: '+15550000001' };
const answer = (call: Call) =>
	call.url.endsWith(`/Accounts/${SID}.json`)
		? json({ friendly_name: 'Acme' })
		: call.url.includes('/Media/')
			? new Response('photo-bytes')
			: call.url.includes('/Messages.json?')
				? json({
						messages: [
							{
								sid: 'SM3',
								body: 'newest',
								direction: 'inbound',
								date_sent: 'Sat, 03 Oct 2026 10:00:00 +0000'
							},
							{
								sid: 'SM1',
								body: 'too old',
								direction: 'inbound',
								date_sent: 'Tue, 01 Sep 2026 10:00:00 +0000'
							}
						]
					})
				: call.url.endsWith('/Messages.json')
					? json({ sid: 'SMout' }, 201)
					: json({});
const inbound = (extra: Record<string, string> = {}) => ({
	MessageSid: 'SM1',
	AccountSid: SID,
	From: '+15551234567',
	To: '+15550000001',
	Body: 'hello',
	NumMedia: '0',
	...extra
});
/** What Twilio computes: base64 HMAC-SHA1 over the URL and the sorted parameters. */
const request = (params: Record<string, string>, token = 'auth-token') => {
	const base = Object.keys(params)
		.sort()
		.reduce((so, name) => `${so}${name}${params[name]}`, HOOK);
	return new Request('https://hook.test/', {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			'x-twilio-signature': createHmac('sha1', token).update(base).digest('base64')
		},
		body: new URLSearchParams(params)
	});
};

describe('SMS (Twilio)', () => {
	it.live('stores a signed message and answers TwiML', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(twilioSms, settings);
			expect(h.status).toMatchObject({ state: 'connected', account: '+15550000001' });
			const answered = yield* h.link.webhook!(request(inbound()));
			expect(answered.status).toBe(200);
			expect(answered.headers.get('content-type')).toContain('text/xml');
			expect(yield* Effect.promise(() => answered.text())).toBe('<Response/>');
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				messages: [
					{
						id: 'SM1',
						thread: '+15551234567',
						text: 'hello',
						from: { handle: '+15551234567' },
						group: false,
						invocation: 'direct'
					}
				]
			});
		})
	);
	it.live('fetches an MMS file with the account, even with no text', () =>
		Effect.gen(function* () {
			const url = `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages/MM1/Media/ME1`;
			const api = yield* platformApi(answer);
			const h = yield* connected(twilioSms, settings);
			yield* h.link.webhook!(
				request(
					inbound({
						MessageSid: 'MM1',
						Body: '',
						NumMedia: '1',
						MediaUrl0: url,
						MediaContentType0: 'image/jpeg'
					})
				)
			);
			const event = h.events[0];
			expect(event).toMatchObject({
				messages: [{ id: 'MM1', attachments: [{ mime: 'image/jpeg', bin: 0 }] }]
			});
			expect(event?.kind === 'messages' ? new TextDecoder().decode(event.bins?.[0]) : '').toBe(
				'photo-bytes'
			);
			expect(api.calls.at(-1)?.headers.get('authorization')).toBe(
				`Basic ${Buffer.from(`${SID}:auth-token`).toString('base64')}`
			);
		})
	);
	it.live('never sends the account credentials to a media URL off Twilio', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(twilioSms, settings),
				before = api.calls.length;
			yield* h.link.webhook!(
				request(
					inbound({
						NumMedia: '1',
						MediaUrl0: 'https://evil.example/x',
						MediaContentType0: 'image/jpeg'
					})
				)
			);
			expect(api.calls).toHaveLength(before);
			expect(h.events[0]).toMatchObject({ messages: [{ attachments: [{ mime: 'image/jpeg' }] }] });
			expect(JSON.stringify(h.events[0])).not.toContain('"bin"');
		})
	);
	it.live('a status callback stores nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(twilioSms, settings);
			const answered = yield* h.link.webhook!(
				request({ MessageSid: 'SM1', MessageStatus: 'delivered', From: '+15550000001' })
			);
			expect(answered.status).toBe(200);
			expect(h.events).toEqual([]);
		})
	);
	it.live('refuses a bad signature and stores nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(twilioSms, settings);
			expect((yield* h.link.webhook!(request(inbound(), 'wrong-token'))).status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a message the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(twilioSms, settings, {
				emit: () => Promise.reject(new Error('the store refused'))
			});
			expect((yield* h.link.webhook!(request(inbound()))).status).toBe(500);
		})
	);
	it.live('sends from the number with a link to each file', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(twilioSms, settings);
			expect(
				yield* h.link.send!({ to: '+15551234567', text: 'Hello' }, [
					file('a.png', 'image/png', 'bytes')
				])
			).toMatchObject({ providerId: 'SMout' });
			const call = api.calls.at(-1),
				form = new URLSearchParams(call?.body);
			expect(call?.url).toBe(
				`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`
			);
			expect(Object.fromEntries(form)).toEqual({
				To: '+15551234567',
				Body: 'Hello',
				From: '+15550000001',
				MediaUrl: 'https://host.example/files/a.png?sig=x'
			});
		})
	);
	it.live('sends through a Messaging Service when one is set', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(twilioSms, {
				accountSid: SID,
				authToken: 'auth-token',
				messagingServiceSid: 'MG1'
			});
			yield* h.link.send!({ to: '+15551234567', text: 'Hello' }, []);
			expect(Object.fromEntries(new URLSearchParams(api.calls.at(-1)?.body))).toEqual({
				To: '+15551234567',
				Body: 'Hello',
				MessagingServiceSid: 'MG1'
			});
		})
	);
	it.live('a token Twilio refuses keeps nothing, and neither does no sender', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ code: 20003, message: 'Authenticate' }, 401));
			const h = yield* host(chatProvider(twilioSms), fetch);
			yield* Effect.flip(h.link.pair!(settings));
			yield* Effect.flip(h.link.pair!({ accountSid: SID, authToken: 'auth-token' }));
			expect(h.values.size).toBe(0);
		})
	);
	it.live('reads a thread back: inbound only, and whole once the page passes the window', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const connection = yield* Effect.promise(() =>
				twilioSms.connect(settings, {
					fetch,
					webhookUrl: HOOK,
					receive: async () => {}
				})
			);
			const read = yield* Effect.promise(() =>
				connection.history!('+15551234567', '2026-09-15T00:00:00.000Z')
			);
			const query = new URL(api.calls.at(-1)?.url ?? '').searchParams;
			expect(query.get('From')).toBe('+15551234567');
			expect(query.get('To')).toBe('+15550000001');
			expect(read.complete).toBe(true);
			expect(read.messages).toHaveLength(1);
			expect(read.messages[0]).toMatchObject({
				id: 'SM3',
				thread: '+15551234567',
				text: 'newest',
				sentAt: '2026-10-03T10:00:00.000Z'
			});
		})
	);
	it.live('a full page that does not reach the window is not whole', () =>
		Effect.gen(function* () {
			yield* platformApi((call) =>
				call.url.includes('/Messages.json?')
					? json({
							messages: Array.from({ length: 100 }, (_, index) => ({
								sid: `SM${index}`,
								direction: 'inbound',
								date_sent: 'Sat, 03 Oct 2026 10:00:00 +0000'
							}))
						})
					: answer(call)
			);
			const connection = yield* Effect.promise(() =>
				twilioSms.connect(settings, { fetch, webhookUrl: HOOK, receive: async () => {} })
			);
			const read = yield* Effect.promise(() =>
				connection.history!('+15551234567', '2026-09-15T00:00:00.000Z')
			);
			expect(read.complete).toBe(false);
		})
	);
});
