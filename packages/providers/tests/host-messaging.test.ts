import { Effect, Schema } from 'effect';
import { HttpClientRequest } from 'effect/http';
import { withFetch } from '../src/util.ts';
import { jsonApi, providerJson } from '../src/transport.ts';
import { fakeFetch } from './kit.ts';
// The host's transactional providers against a fake fetch: Twilio Verify (service by friendly name, start by SMS or
// WhatsApp, check), Twilio Messages (sender discovery, the send), Resend emails, Sinch (Mailgun mail, SMS,
// Verification) and the `transactional` factory; refusals as FacilityError kinds.
import { describe, expect, it } from '@effect/vitest';
import {
	SINCH_REGIONS,
	resendMail,
	sinchMail,
	sinchSms,
	sinchVerification,
	transactional,
	twilioMessages,
	twilioVerify,
	type SinchRegion
} from '../src/index.ts';

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
/** A fetch that records each call and answers from `answer(url, method)`. */
function fake(answer: (url: string, method: string) => Response) {
	const f = fakeFetch([(call) => answer(call.url, call.method)]);
	return { f, calls: f.calls };
}
const form = (c: Call) => Object.fromEntries(new URLSearchParams(c.body));
const basic = `Basic ${Buffer.from('AC123:secret').toString('base64')}`;

it.effect('preserves transactional and API error details through the shared JSON executor', () =>
	Effect.gen(function* () {
		const body = { message: 'x'.repeat(600) };
		const limited = {
			fetch: fake(() => Response.json(body, { status: 429, headers: { 'retry-after': '2' } })).f
		};
		const send = providerJson(
			'fixture',
			Schema.String,
			HttpClientRequest.get('https://provider.example/models')
		);
		const api = jsonApi('https://provider.example', {})(Schema.String, 'GET', '/models');
		expect(yield* Effect.flip(withFetch(limited, send))).toMatchObject({
			message: `fixture 429: ${body.message}`,
			status: 429,
			retryAfterMs: undefined
		});
		expect(yield* Effect.flip(withFetch(limited, api))).toMatchObject({
			message: `GET /models answered 429: ${JSON.stringify(body).slice(0, 500)}`,
			status: 429,
			retryAfterMs: 2000
		});
		const invalid = { fetch: fake(() => Response.json({})).f };
		expect(yield* Effect.flip(withFetch(invalid, send))).toMatchObject({
			message: 'fixture: response failed validation',
			status: 200
		});
		const invalidApi = yield* Effect.flip(withFetch(invalid, api));
		expect(invalidApi).toMatchObject({
			_tag: 'ProviderUnavailable',
			message: 'GET /models answered something that is not its result'
		});
		if (invalidApi._tag === 'ProviderUnavailable') expect(invalidApi.status).toBeUndefined();
	})
);

describe('Twilio Verify', () => {
	it.effect('finds the Norbital service once, starts by SMS or WhatsApp, and checks the code', () =>
		Effect.gen(function* () {
			const { f, calls } = fake((url, method) =>
				url.endsWith('Services?PageSize=1000')
					? Response.json({
							services: [
								{ sid: 'VA0', friendly_name: 'Other' },
								{ sid: 'VA1', friendly_name: 'Norbital' }
							]
						})
					: url.endsWith('/Verifications')
						? Response.json({ sid: 'VE1', status: 'pending' }, { status: 201 })
						: Response.json({
								status:
									method === 'POST' && calls.at(-1)!.body.includes('Code=424242')
										? 'approved'
										: 'pending'
							})
			);
			const v = yield* twilioVerify({ accountSid: 'AC123', authToken: 'secret' });
			yield* withFetch({ fetch: f }, v.start('+6581234567', 'sms'));
			yield* withFetch({ fetch: f }, v.start('+6581234567', 'whatsapp'));
			expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
				'GET https://verify.twilio.com/v2/Services?PageSize=1000',
				'POST https://verify.twilio.com/v2/Services/VA1/Verifications',
				'POST https://verify.twilio.com/v2/Services/VA1/Verifications'
			]);
			expect(calls[1]!.headers['authorization']).toBe(basic);
			expect(calls[1]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
			expect(form(calls[1]!)).toEqual({ To: '+6581234567', Channel: 'sms' });
			expect(form(calls[2]!)).toEqual({ To: '+6581234567', Channel: 'whatsapp' });
			expect(yield* withFetch({ fetch: f }, v.check('+6581234567', '424242'))).toBe(true);
			expect(calls.at(-1)!.url).toBe('https://verify.twilio.com/v2/Services/VA1/VerificationCheck');
			expect(form(calls.at(-1)!)).toEqual({ To: '+6581234567', Code: '424242' });
			expect(yield* withFetch({ fetch: f }, v.check('+6581234567', '000000'))).toBe(false);
		})
	);

	it.effect('creates the service when the account has none by that name', () =>
		Effect.gen(function* () {
			const { f, calls } = fake((url, method) =>
				method === 'GET'
					? Response.json({ services: [] })
					: url.endsWith('/v2/Services')
						? Response.json({ sid: 'VA9' }, { status: 201 })
						: Response.json({ status: 'pending' }, { status: 201 })
			);
			yield* withFetch(
				{ fetch: f },
				Effect.flatMap(twilioVerify({ accountSid: 'AC123', authToken: 'secret' }), (v) =>
					v.start('+6581234567', 'sms')
				)
			);
			expect(form(calls[1]!)).toEqual({ FriendlyName: 'Norbital' });
			expect(calls[2]!.url).toBe('https://verify.twilio.com/v2/Services/VA9/Verifications');
		})
	);

	it.effect(
		'no pending verification (404) is a wrong code; a refusal throws its FacilityError kind; a failed lookup is retried',
		() =>
			Effect.gen(function* () {
				let listFails = true;
				const { f } = fake((url) =>
					url.includes('PageSize')
						? listFails
							? new Response('down', { status: 503 })
							: Response.json({ services: [{ sid: 'VA1', friendly_name: 'Norbital' }] })
						: url.endsWith('VerificationCheck')
							? Response.json(
									{ code: 20404, message: 'The requested resource was not found' },
									{ status: 404 }
								)
							: Response.json(
									{ code: 60203, message: 'Max send attempts reached' },
									{ status: 429 }
								)
				);
				const v = yield* twilioVerify({ accountSid: 'AC123', authToken: 'secret' });
				expect(
					yield* Effect.flip(withFetch({ fetch: f }, v.start('+6581234567', 'sms')))
				).toMatchObject({ _tag: 'ProviderUnavailable', status: 503 });
				listFails = false;
				expect(
					yield* Effect.flip(withFetch({ fetch: f }, v.start('+6581234567', 'sms')))
				).toMatchObject({
					_tag: 'ProviderUnavailable',
					status: 429,
					message: 'twilio 429: Max send attempts reached'
				});
				expect(yield* withFetch({ fetch: f }, v.check('+6581234567', '123456'))).toBe(false);
			})
	);
});

describe('Twilio Messages', () => {
	it.effect("sends through the account's Messaging Service when it has one, discovered once", () =>
		Effect.gen(function* () {
			const { f, calls } = fake((url) =>
				url.startsWith('https://messaging.twilio.com')
					? Response.json({ services: [{ sid: 'MG1' }] })
					: Response.json({ sid: 'SM1' }, { status: 201 })
			);
			const sms = yield* twilioMessages({ accountSid: 'AC123', authToken: 'secret' });
			expect(
				yield* withFetch({ fetch: f }, sms.send({ to: '+6581234567', text: 'You are invited.' }))
			).toEqual({ providerId: 'SM1' });
			yield* withFetch({ fetch: f }, sms.send({ to: '+6581234567', text: 'Again.' }));
			expect(calls.map((c) => c.url)).toEqual([
				'https://messaging.twilio.com/v1/Services?PageSize=1',
				'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json',
				'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json'
			]);
			expect(calls[1]!.headers['authorization']).toBe(basic);
			expect(form(calls[1]!)).toEqual({
				To: '+6581234567',
				Body: 'You are invited.',
				MessagingServiceSid: 'MG1'
			});
		})
	);

	it.effect(
		'else from the first SMS-capable number; none is a failure; a malformed number never reaches Twilio',
		() =>
			Effect.gen(function* () {
				const numbers = [
					{ phone_number: '+15550000001', capabilities: { sms: false } },
					{ phone_number: '+15550000002', capabilities: { sms: true } }
				];
				const { f, calls } = fake((url) =>
					url.startsWith('https://messaging.twilio.com')
						? Response.json({ services: [] })
						: url.includes('IncomingPhoneNumbers')
							? Response.json({ incoming_phone_numbers: numbers })
							: Response.json(
									{ code: 21211, message: "The 'To' number is not valid" },
									{ status: 400 }
								)
				);
				const sms = yield* twilioMessages({ accountSid: 'AC123', authToken: 'secret' });
				expect(
					yield* Effect.flip(withFetch({ fetch: f }, sms.send({ to: '81234567', text: 'x' })))
				).toMatchObject({ _tag: 'ProviderRefused', permanent: true });
				expect(calls).toEqual([]);
				expect(
					yield* Effect.flip(withFetch({ fetch: f }, sms.send({ to: '+6581234567', text: 'x' })))
				).toMatchObject({ _tag: 'ProviderRefused', code: '400', permanent: true });
				expect(calls[1]!.url).toBe(
					'https://api.twilio.com/2010-04-01/Accounts/AC123/IncomingPhoneNumbers.json?PageSize=1000'
				);
				expect(form(calls[2]!)).toEqual({ To: '+6581234567', Body: 'x', From: '+15550000002' });
				numbers.length = 0;
				const none = yield* twilioMessages({ accountSid: 'AC123', authToken: 'secret' });
				expect(
					(yield* Effect.flip(withFetch({ fetch: f }, none.send({ to: '+6581234567', text: 'x' }))))
						.message
				).toMatch(/no Messaging Service and no SMS-capable number/);
			})
	);
});

describe('Resend emails', () => {
	it.effect('posts one email: from, to, cc, subject, text, html, threading headers', () =>
		Effect.gen(function* () {
			const { f, calls } = fake(() => Response.json({ id: 're-1' }));
			const mail = resendMail({ key: 're_k', from: 'noreply@acme.example' });
			expect(
				yield* withFetch(
					{ fetch: f },
					mail.send({
						to: ['a@x.test'],
						cc: ['b@x.test'],
						subject: 'Hi',
						text: 'plain',
						html: '<p>html</p>',
						thread: 't1',
						inReplyTo: '<m1@x>',
						references: ['<m0@x>', '<m1@x>']
					})
				)
			).toEqual({ providerId: 're-1' });
			expect(calls[0]!.url).toBe('https://api.resend.com/emails');
			expect(calls[0]!.headers['authorization']).toBe('Bearer re_k');
			expect(JSON.parse(calls[0]!.body)).toEqual({
				from: 'noreply@acme.example',
				to: ['a@x.test'],
				cc: ['b@x.test'],
				subject: 'Hi',
				text: 'plain',
				html: '<p>html</p>',
				headers: { 'X-Bolt-Thread': 't1', 'In-Reply-To': '<m1@x>', References: '<m0@x> <m1@x>' }
			});
		})
	);

	it.effect(
		'a single address; a refusal throws its FacilityError kind; a malformed message never leaves',
		() =>
			Effect.gen(function* () {
				const { f, calls } = fake(() =>
					Response.json(
						{
							statusCode: 403,
							name: 'validation_error',
							message: 'The acme.example domain is not verified.'
						},
						{ status: 403 }
					)
				);
				const mail = resendMail({ key: 're_k', from: 'Norbital <noreply@acme.example>' });
				expect(
					yield* Effect.flip(
						withFetch(
							{ fetch: f },
							mail.send({ to: 'a@x.test', subject: 'Code', text: 'Your sign-in code is 123456.' })
						)
					)
				).toMatchObject({
					_tag: 'ProviderRefused',
					code: '403',
					permanent: true,
					message: 'resend 403: The acme.example domain is not verified.'
				});
				expect(JSON.parse(calls[0]!.body)).toEqual({
					from: 'Norbital <noreply@acme.example>',
					to: ['a@x.test'],
					subject: 'Code',
					text: 'Your sign-in code is 123456.'
				});
				expect(
					yield* Effect.flip(withFetch({ fetch: f }, mail.send({ subject: 'x', text: 'y' })))
				).toMatchObject({ _tag: 'ProviderRefused', permanent: true });
				expect(
					yield* Effect.flip(withFetch({ fetch: f }, mail.send({ to: 'a@x.test', subject: 'x' })))
				).toMatchObject({ _tag: 'ProviderRefused', permanent: true });
				expect(calls.length).toBe(1);
				const busy = resendMail({ key: 're_k', from: 'n@a.example' });
				expect(
					yield* Effect.flip(
						withFetch(
							{
								fetch: fake(() => Response.json({ message: 'Too many requests' }, { status: 429 }))
									.f
							},
							busy.send({ to: 'a@x.test', subject: 'x', text: 'y' })
						)
					)
				).toMatchObject({ _tag: 'ProviderUnavailable', status: 429 });
				const down = resendMail({ key: 're_k', from: 'n@a.example' });
				expect(
					yield* Effect.flip(
						withFetch(
							{ fetch: fake(() => new Response('oops', { status: 500 })).f },
							down.send({ to: 'a@x.test', subject: 'x', text: 'y' })
						)
					)
				).toMatchObject({ _tag: 'ProviderUnavailable', status: 500 });
			})
	);
});

describe('Sinch', () => {
	it.effect('mails through Mailgun from noreply@<domain>', () =>
		Effect.gen(function* () {
			const { f, calls } = fake(() =>
				Response.json({ id: '<m1@mg.acme.example>', message: 'Queued. Thank you.' })
			);
			const mail = sinchMail({ key: 'mg-key', domain: 'mg.acme.example' });
			expect(
				yield* withFetch(
					{ fetch: f },
					mail.send({
						to: ['a@x.test', 'b@x.test'],
						subject: 'Hi',
						text: 'plain',
						html: '<p>h</p>',
						inReplyTo: '<m0@x>',
						references: ['<m0@x>']
					})
				)
			).toEqual({ providerId: '<m1@mg.acme.example>' });
			expect(calls[0]!.url).toBe('https://api.mailgun.net/v3/mg.acme.example/messages');
			expect(calls[0]!.headers['authorization']).toBe(
				`Basic ${Buffer.from('api:mg-key').toString('base64')}`
			);
			const body = new URLSearchParams(calls[0]!.body);
			expect(body.getAll('to')).toEqual(['a@x.test', 'b@x.test']);
			expect(Object.fromEntries([...body].filter(([k]) => k !== 'to'))).toEqual({
				from: 'noreply@mg.acme.example',
				subject: 'Hi',
				text: 'plain',
				html: '<p>h</p>',
				'h:In-Reply-To': '<m0@x>',
				'h:References': '<m0@x>'
			});
			expect(
				yield* Effect.flip(withFetch({ fetch: f }, mail.send({ subject: 'x', text: 'y' })))
			).toMatchObject({ _tag: 'ProviderRefused', permanent: true });
			const refused = sinchMail({ key: 'k', domain: 'mg.acme.example' });
			expect(
				yield* Effect.flip(
					withFetch(
						{
							fetch: fake(() => Response.json({ message: 'Domain not found' }, { status: 404 })).f
						},
						refused.send({ to: 'a@x.test', subject: 'x', text: 'y' })
					)
				)
			).toMatchObject({
				_tag: 'ProviderRefused',
				permanent: true,
				message: 'mailgun 404: Domain not found'
			});
		})
	);

	it.effect('texts through the service plan as a batch of one', () =>
		Effect.gen(function* () {
			const { f, calls } = fake(() => Response.json({ id: 'batch-1' }, { status: 201 }));
			const sms = sinchSms({ planId: 'plan1', token: 'tok', from: '+15550001111' });
			expect(
				yield* withFetch({ fetch: f }, sms.send({ to: '+6581234567', text: 'You are invited.' }))
			).toEqual({ providerId: 'batch-1' });
			expect(calls[0]!.url).toBe('https://us.sms.api.sinch.com/xms/v1/plan1/batches');
			expect(calls[0]!.headers['authorization']).toBe('Bearer tok');
			expect(JSON.parse(calls[0]!.body)).toEqual({
				from: '+15550001111',
				to: ['+6581234567'],
				body: 'You are invited.'
			});
			expect(
				yield* Effect.flip(withFetch({ fetch: f }, sms.send({ to: '81234567', text: 'x' })))
			).toMatchObject({ _tag: 'ProviderRefused', permanent: true });
			const busy = sinchSms({ planId: 'p', token: 't', from: '+15550001111' });
			expect(
				yield* Effect.flip(
					withFetch(
						{ fetch: fake(() => Response.json({ text: 'Too many requests' }, { status: 429 })).f },
						busy.send({ to: '+6581234567', text: 'x' })
					)
				)
			).toMatchObject({ _tag: 'ProviderUnavailable', status: 429 });
		})
	);

	it.effect(
		"mails and texts on the region's hosts: Mailgun has only US and EU, SMS one per region",
		() =>
			Effect.gen(function* () {
				const hosts = (region: SinchRegion) =>
					Effect.gen(function* () {
						const { f, calls } = fake(() => Response.json({ id: 'x' }));
						const p = yield* transactional({
							email: { provider: 'sinch', region, key: 'k', domain: 'mg.acme.example' },
							phone: {
								provider: 'sinch',
								region,
								verification: { key: 'a', secret: 's' },
								sms: { planId: 'p', token: 't', from: '+15550001111' }
							}
						});
						yield* withFetch(
							{ fetch: f },
							p.email!.send({ to: 'a@x.test', subject: 'x', text: 'y' })
						);
						yield* withFetch({ fetch: f }, p.sms!.send({ to: '+6581234567', text: 'x' }));
						return calls.map((c) => new URL(c.url).host);
					});
				expect(yield* Effect.all(SINCH_REGIONS.map(hosts))).toEqual([
					['api.mailgun.net', 'us.sms.api.sinch.com'],
					['api.eu.mailgun.net', 'eu.sms.api.sinch.com'],
					['api.mailgun.net', 'au.sms.api.sinch.com'],
					['api.mailgun.net', 'br.sms.api.sinch.com'],
					['api.mailgun.net', 'ca.sms.api.sinch.com']
				]);
			})
	);

	it.effect(
		'verifies by SMS or WhatsApp and reports the code by the method it went by; no pending verification is a wrong code',
		() =>
			Effect.gen(function* () {
				let status = 'SUCCESSFUL';
				const { f, calls } = fake((_url, method) =>
					method === 'POST'
						? Response.json({ id: 'v1', method: 'whatsapp' })
						: status === 'none'
							? Response.json(
									{ errorCode: 40400, message: 'Verification not found' },
									{ status: 404 }
								)
							: Response.json({ id: 'v1', status })
				);
				const v = sinchVerification({ key: 'app', secret: 'sec' });
				expect(v.via).toEqual(['sms', 'whatsapp']);
				yield* withFetch({ fetch: f }, v.start('+6581234567', 'whatsapp'));
				expect(calls[0]!.url).toBe(
					'https://verification.api.sinch.com/verification/v1/verifications'
				);
				expect(calls[0]!.headers['authorization']).toBe(
					`Basic ${Buffer.from('app:sec').toString('base64')}`
				);
				expect(JSON.parse(calls[0]!.body)).toEqual({
					identity: { type: 'number', endpoint: '+6581234567' },
					method: 'whatsapp'
				});
				status = 'FAIL';
				expect(yield* withFetch({ fetch: f }, v.check('+6581234567', '000000'))).toBe(false);
				status = 'SUCCESSFUL';
				expect(yield* withFetch({ fetch: f }, v.check('+6581234567', '424242'))).toBe(true);
				expect(calls[2]!).toMatchObject({
					method: 'PUT',
					url: 'https://verification.api.sinch.com/verification/v1/verifications/number/%2B6581234567'
				});
				expect(JSON.parse(calls[2]!.body)).toEqual({
					method: 'whatsapp',
					whatsapp: { code: '424242' }
				});
				yield* withFetch({ fetch: f }, v.start('+6581234567', 'sms'));
				status = 'none';
				expect(yield* withFetch({ fetch: f }, v.check('+6581234567', '424242'))).toBe(false);
				expect(JSON.parse(calls.at(-1)!.body)).toEqual({ method: 'sms', sms: { code: '424242' } });
			})
	);
});

describe('transactional', () => {
	it.effect('email and phone chosen apart; each part only when configured', () =>
		Effect.gen(function* () {
			expect(Object.keys(yield* transactional({}))).toEqual([]);
			expect(
				Object.keys(
					yield* transactional({
						email: { provider: 'resend', key: 're_k', from: 'noreply@acme.example' }
					})
				)
			).toEqual(['email']);
			const twilio = yield* transactional({
				email: { provider: 'resend', key: 're_k', from: 'noreply@acme.example' },
				phone: { provider: 'twilio', accountSid: 'AC1', authToken: 't' }
			});
			expect(Object.keys(twilio).sort()).toEqual(['email', 'phone', 'sms']);
			expect(twilio.phone?.via).toEqual(['sms', 'whatsapp']);
			expect(
				Object.keys(
					yield* transactional({ phone: { provider: 'twilio', accountSid: 'AC1', authToken: 't' } })
				).sort()
			).toEqual(['phone', 'sms']);
			expect(
				Object.keys(
					yield* transactional({
						email: { provider: 'sinch', key: 'k', domain: 'd' },
						phone: { provider: 'sinch', verification: { key: 'a', secret: 's' } }
					})
				).sort()
			).toEqual(['email', 'phone']);
		})
	);
});
