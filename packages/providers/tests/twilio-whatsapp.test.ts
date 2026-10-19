import { Effect } from 'effect';
// WhatsApp via Twilio: the instance's own account validated at setup, X-Twilio-Signature refusal over the public URL,
// inbound with media, status callbacks as delivery events, and the Messages API send shape.
import { describe, expect, it } from '@effect/vitest';
import { twilioSignature, twilioWhatsapp } from '../src/twilio/whatsapp.ts';
import { fakeFetch, file, host, json, signal } from './kit.ts';

const SID = `AC${'1'.repeat(32)}`,
	TOKEN = 'f'.repeat(32),
	URL_ = 'https://ws.example/acme/hooks/integration/desk';
const CRED = { accountSid: SID, authToken: TOKEN, from: '+6580000000', account: 'Acme' },
	STORED = { credential: CRED };
const api = () =>
	fakeFetch([
		(c) => (c.url.endsWith(`/Accounts/${SID}.json`) ? json({ friendly_name: 'Acme' }) : undefined),
		(c) => (c.url.endsWith('/Messages.json') ? json({ sid: 'SM1' }, 201) : undefined),
		(c) =>
			c.url.startsWith('https://media.example/') ? new Response(new Uint8Array([9, 9])) : undefined
	]);
const form = (params: { [k: string]: string }, token = TOKEN) =>
	new Request('http://10.0.0.1/hooks/integration/desk', {
		method: 'POST',
		headers: {
			'x-twilio-signature': twilioSignature(token, URL_, params),
			'content-type': 'application/x-www-form-urlencoded'
		},
		body: new URLSearchParams(params)
	});

describe('WhatsApp via Twilio', () => {
	it.effect('a 4xx on send is a permanent refusal; a 5xx is retried', () =>
		Effect.gen(function* () {
			const answer = (status: number) =>
				fakeFetch([
					(c) =>
						c.url.endsWith('/Messages.json')
							? json({ message: 'nope', code: 21211 }, status)
							: undefined
				]);
			const refused = yield* host(twilioWhatsapp(), answer(400), STORED, { webhookUrl: URL_ });
			expect(
				yield* Effect.flip(refused.link.send!({ to: '+6591111111', text: 'hi' }, undefined))
			).toMatchObject({ _tag: 'ProviderRefused', permanent: true, code: '400' });
			const down = yield* host(twilioWhatsapp(), answer(503), STORED, { webhookUrl: URL_ });
			expect(
				yield* Effect.flip(down.link.send!({ to: '+6591111111', text: 'hi' }, undefined))
			).toMatchObject({ _tag: 'ProviderUnavailable' });
		})
	);
	it.effect('validates the SID, token and sender, then reads the account with them', () =>
		Effect.gen(function* () {
			const f = api(),
				h = yield* host(twilioWhatsapp(), f, {}, { webhookUrl: URL_ });
			expect(
				(yield* Effect.flip(
					h.link.pair!({ accountSid: 'nope', authToken: TOKEN, from: '+6580000000' })
				)).message
			).toMatch(/account SID/);
			expect(
				(yield* Effect.flip(h.link.pair!({ accountSid: SID, authToken: TOKEN }))).message
			).toMatch(/sender number is required/);
			expect(f.calls).toEqual([]);
			yield* h.link.pair!({ accountSid: SID, authToken: TOKEN, from: '6580000000' });
			expect(f.calls[0]!.headers['authorization']).toBe(
				`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`
			);
			expect(Object.fromEntries(h.values)).toEqual(STORED);
			expect(h.status).toEqual({
				state: 'connected',
				account: '+6580000000',
				about: { from: '+6580000000', account: 'Acme' }
			});
		})
	);
	it.effect('refuses a request signed with another token or for another URL', () =>
		Effect.gen(function* () {
			const h = yield* host(twilioWhatsapp(), api(), STORED, { webhookUrl: URL_ });
			const params = { MessageSid: 'SM9', From: 'whatsapp:+6591111111', Body: 'hi' };
			expect((yield* h.link.webhook!(form(params, '0'.repeat(32)))).status).toBe(403);
			const moved = form(params);
			const other = new Request('http://10.0.0.1/hooks/integration/desk?x=1', {
				method: 'POST',
				headers: moved.headers,
				body: new URLSearchParams(params)
			});
			expect((yield* h.link.webhook!(other)).status).toBe(403);
			expect(h.events).toEqual([]);
		})
	);
	it.effect(
		'decodes an inbound message with its media, and a status callback as a delivery event',
		() =>
			Effect.gen(function* () {
				const h = yield* host(twilioWhatsapp(), api(), STORED, { webhookUrl: URL_ });
				const r = yield* h.link.webhook!(
					form({
						MessageSid: 'SM9',
						From: 'whatsapp:+6591111111',
						ProfileName: 'Ben',
						Body: 'photo',
						NumMedia: '1',
						MediaUrl0: 'https://media.example/m0',
						MediaContentType0: 'image/jpeg'
					})
				);
				expect(r.headers.get('content-type')).toBe('text/xml');
				expect(h.events[0]).toMatchObject({
					kind: 'messages',
					messages: [
						{
							id: 'SM9',
							thread: 'whatsapp:+6591111111',
							from: { handle: 'whatsapp:+6591111111', name: 'Ben' },
							text: 'photo',
							attachments: [{ mime: 'image/jpeg', bytes: 2, bin: 0 }]
						}
					],
					bins: [new Uint8Array([9, 9])]
				});
				yield* h.link.webhook!(
					form({ MessageSid: 'SM1', MessageStatus: 'undelivered', ErrorCode: '63016' })
				);
				yield* h.link.webhook!(form({ MessageSid: 'SM1', MessageStatus: 'read' }));
				expect(h.events.slice(1)).toMatchObject([
					{
						kind: 'delivery',
						providerId: 'SM1',
						report: {
							kind: 'bounced',
							provider: 'twilio',
							code: '63016',
							reason: 'Twilio error 63016',
							permanent: true
						}
					},
					{ kind: 'delivery', providerId: 'SM1', report: { kind: 'read', provider: 'twilio' } }
				]);
			})
	);
	it.effect("sends from the account's own sender with this webhook as the status callback", () =>
		Effect.gen(function* () {
			const f = api(),
				h = yield* host(twilioWhatsapp(), f, STORED, { webhookUrl: URL_ });
			expect(
				yield* h.link.send!({ to: '6591111111@s.whatsapp.net', text: 'hi' }, undefined)
			).toEqual({ providerId: 'SM1' });
			const call = f.calls.at(-1)!;
			expect(call.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
			expect(Object.fromEntries(new URLSearchParams(call.body))).toEqual({
				From: 'whatsapp:+6580000000',
				To: 'whatsapp:+6591111111',
				Body: 'hi',
				StatusCallback: URL_
			});
		})
	);
	it.effect(
		"each attachment follows as a media message Twilio fetches from the host's signed link; with no link, nothing is sent",
		() =>
			Effect.gen(function* () {
				const f = api(),
					h = yield* host(twilioWhatsapp(), f, STORED, { webhookUrl: URL_ });
				yield* h.link.send!({ to: '+6591111111', text: 'hi' }, [
					file('report.pdf', 'application/pdf', '%PDF r')
				]);
				expect(
					f.calls.slice(-2).map((c) => Object.fromEntries(new URLSearchParams(c.body)))
				).toEqual([
					{
						From: 'whatsapp:+6580000000',
						To: 'whatsapp:+6591111111',
						Body: 'hi',
						StatusCallback: URL_
					},
					{
						From: 'whatsapp:+6580000000',
						To: 'whatsapp:+6591111111',
						MediaUrl: 'https://host.example/files/report.pdf?sig=x',
						StatusCallback: URL_
					}
				]);
				const before = f.calls.length;
				expect(
					yield* Effect.flip(
						h.link.send!({ to: '+6591111111', text: 'hi' }, [
							file('report.pdf', 'application/pdf', '%PDF r', null)
						])
					)
				).toMatchObject({ _tag: 'ProviderRefused', permanent: true });
				expect(f.calls).toHaveLength(before);
			})
	);
});
