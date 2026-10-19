// The host's messaging from `BOLT_TRANSACTIONAL_EMAIL` and `BOLT_TRANSACTIONAL_PHONE` (§5.11.2): the keys checked at
// start, the providers they wire (Resend or Sinch mail; Twilio Verify + Messages or Sinch Verification + SMS), and a
// local host without them printing to its log.
import { describe, expect, it } from '@effect/vitest';
import { ConfigProvider, Effect, Layer, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { BoltError, DbError, type Sql } from '@norbital-ai/bolt/engine';
import { BoltConfig } from '../src/config.ts';
import { messaging } from '../src/mail.ts';
import { generateKeyPairSync, verify } from 'node:crypto';
import { apns, push, type ApnsRequest } from '../src/push.ts';

const config = (over: { [k: string]: string } = {}) =>
	BoltConfig().pipe(
		Effect.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					BOLT_ARTIFACT: '/a',
					BOLT_PGLITE_DIR: '/d',
					BOLT_PUBLIC_URL: 'https://acme.example',
					...over
				})
			)
		)
	);
const client = (fetch: typeof globalThis.fetch = globalThis.fetch) =>
	FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)));
const resend = { BOLT_TRANSACTIONAL_EMAIL: 'resend', BOLT_RESEND_API_KEY: 're_key' };
const twilio = {
	BOLT_TRANSACTIONAL_PHONE: 'twilio',
	BOLT_TWILIO_ACC_SID: 'AC123',
	BOLT_TWILIO_AUTH_TOKEN: 'secret'
};
const sinch = {
	BOLT_TRANSACTIONAL_EMAIL: 'sinch',
	BOLT_TRANSACTIONAL_PHONE: 'sinch',
	BOLT_SINCH_MAILGUN_KEY: 'mg',
	BOLT_SINCH_MAILGUN_DOMAIN: 'mg.acme.example',
	BOLT_SINCH_SMS_PLAN_ID: 'plan',
	BOLT_SINCH_SMS_TOKEN: 'tok',
	BOLT_SINCH_SMS_FROM: '+15550001111',
	BOLT_SINCH_VERIFICATION_KEY: 'app',
	BOLT_SINCH_VERIFICATION_SECRET: 'sec'
};

const pushMessage = {
	_tag: 'Push',
	subscription: {
		kind: 'web',
		endpoint: 'https://push.example/subscription',
		keys: { p256dh: 'public-key', auth: 'auth-key' }
	},
	title: 'New notice',
	body: null,
	path: '/inbox',
	link: null
} satisfies Parameters<ReturnType<typeof push>['send']>[0];

describe('web push subscription cleanup', () => {
	it.effect('removes expired subscriptions for both provider expiry statuses', () =>
		Effect.gen(function* () {
			for (const statusCode of [404, 410]) {
				const writes: Sql[] = [];
				const transport = push(
					{
						write: (statement) =>
							Effect.sync(() => {
								writes.push(statement);
								return { rows: [], affected: 1 };
							})
					},
					{ publicKey: 'public', privateKey: 'private' },
					'mailto:push@example.com',
					() => Promise.reject({ statusCode })
				);
				const failure = yield* Effect.flip(transport.send(pushMessage));
				expect(writes).toEqual([
					{
						text: 'DELETE FROM bolt_push_subscriptions WHERE endpoint = $1',
						params: [pushMessage.subscription.endpoint]
					}
				]);
				expect(failure).toMatchObject({ _tag: 'FacilityFailure', kind: 'upstream' });
			}
		})
	);
	it.effect('retains the typed transport failure for native and bridged database failures', () =>
		Effect.gen(function* () {
			const original = new Error('the pinned database write was interrupted');
			for (const failure of [
				DbError.make('57014', 'database write was cancelled'),
				BoltError.make('upstream', 'facility', original.message, original)
			]) {
				let writes = 0;
				const transport = push(
					{
						write: () =>
							Effect.sync(() => {
								writes++;
							}).pipe(Effect.andThen(Effect.fail(failure)))
					},
					{ publicKey: 'public', privateKey: 'private' },
					'mailto:push@example.com',
					() => Promise.reject({ statusCode: 410 })
				);
				expect(yield* Effect.flip(transport.send(pushMessage))).toMatchObject({
					_tag: 'FacilityFailure',
					kind: 'upstream',
					message: failure.message
				});
				expect(writes).toBe(1);
			}
		})
	);
});

describe('APNs notices', () => {
	const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
	const keys = {
		TEAM123456: {
			keyId: 'KEY1234567',
			key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
		}
	};
	const notice = {
		_tag: 'Push',
		subscription: {
			kind: 'apns',
			endpoint: 'ab'.repeat(32),
			keys: { topic: 'ai.norbital.app', environment: 'production', teamId: 'TEAM123456' }
		},
		title: 'New notice',
		body: 'Shift tomorrow',
		path: '/inbox?record=jobs/1',
		link: { collection: 'jobs', id: '1' }
	} satisfies Parameters<ReturnType<typeof apns>['send']>[0];
	const recorder = (status: number, body = '') => {
		const calls: { origin: string; headers: { readonly [name: string]: string }; body: string }[] =
			[];
		const request: ApnsRequest = (origin, headers, payload) =>
			Effect.sync(() => {
				calls.push({ origin, headers, body: payload });
				return { status, body };
			});
		return { calls, request };
	};
	const noWrites = {
		write: () => Effect.die('no subscription is deleted')
	};
	const segment = (part: string | undefined): unknown =>
		JSON.parse(Buffer.from(part ?? '', 'base64url').toString());

	it.effect('signs an ES256 provider token and posts the alert to the production host', () =>
		Effect.gen(function* () {
			const { calls, request } = recorder(200);
			const transport = apns(noWrites, keys, request);
			expect(yield* transport.send(notice)).toEqual({ providerId: 'apns:200' });
			yield* transport.send(notice);
			const [call, again] = calls;
			expect(call?.origin).toBe('https://api.push.apple.com');
			expect(call?.headers).toMatchObject({
				':path': `/3/device/${'ab'.repeat(32)}`,
				'apns-topic': 'ai.norbital.app',
				'apns-push-type': 'alert'
			});
			expect(JSON.parse(call?.body ?? '')).toEqual({
				aps: { alert: { title: 'New notice', body: 'Shift tomorrow' }, sound: 'default' },
				path: '/inbox?record=jobs/1'
			});
			const jwt = (call?.headers['authorization'] ?? '').replace(/^bearer /, '');
			const [header, claims, signature] = jwt.split('.');
			expect(segment(header)).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
			expect(segment(claims)).toEqual({ iss: 'TEAM123456', iat: expect.any(Number) });
			expect(
				verify(
					'sha256',
					Buffer.from(`${header}.${claims}`),
					{ key: publicKey, dsaEncoding: 'ieee-p1363' },
					Buffer.from(signature ?? '', 'base64url')
				)
			).toBe(true);
			// the token is reused within its 50 minutes
			expect(again?.headers['authorization']).toBe(call?.headers['authorization']);
		})
	);
	it.effect('targets the sandbox host for a development device', () =>
		Effect.gen(function* () {
			const { calls, request } = recorder(200);
			yield* apns(noWrites, keys, request).send({
				...notice,
				subscription: {
					...notice.subscription,
					keys: { ...notice.subscription.keys, environment: 'development' }
				}
			});
			expect(calls[0]?.origin).toBe('https://api.sandbox.push.apple.com');
		})
	);
	it.effect('deletes a device APNs reports gone, and keeps one it refuses for another reason', () =>
		Effect.gen(function* () {
			for (const [status, reason, deleted] of [
				[410, 'Unregistered', true],
				[400, 'BadDeviceToken', true],
				[429, 'TooManyRequests', false]
			] as const) {
				const writes: Sql[] = [];
				const { request } = recorder(status, JSON.stringify({ reason }));
				const transport = apns(
					{
						write: (statement) =>
							Effect.sync(() => {
								writes.push(statement);
								return { rows: [], affected: 1 };
							})
					},
					keys,
					request
				);
				expect(yield* Effect.flip(transport.send(notice))).toMatchObject({
					_tag: 'FacilityFailure',
					kind: 'upstream'
				});
				expect(writes).toEqual(
					deleted
						? [
								{
									text: 'DELETE FROM bolt_push_subscriptions WHERE endpoint = $1',
									params: [notice.subscription.endpoint]
								}
							]
						: []
				);
			}
		})
	);
	it.effect('answers Unavailable for a team without a configured key', () =>
		Effect.gen(function* () {
			const { calls, request } = recorder(200);
			expect(yield* Effect.flip(apns(noWrites, {}, request).send(notice))).toMatchObject({
				_tag: 'Unavailable',
				facility: 'push'
			});
			expect(calls).toEqual([]);
		})
	);
});

/** A fetch answering every provider's happy path, recording URLs. */
function fake() {
	const urls: string[] = [],
		bodies: string[] = [];
	const f: typeof fetch = async (input, init) => {
		const request = new Request(input, init),
			url = request.url;
		urls.push(url);
		bodies.push(await request.text());
		if (url.endsWith('PageSize=1000'))
			return Response.json({ services: [{ sid: 'VA1', friendly_name: 'Norbital' }] });
		if (url.startsWith('https://messaging.twilio.com'))
			return Response.json({ services: [{ sid: 'MG1' }] });
		return Response.json({ id: 'x', sid: 'X1', status: 'pending' }, { status: 201 });
	};
	return { f, urls, bodies };
}

describe('BOLT_TRANSACTIONAL_EMAIL and BOLT_TRANSACTIONAL_PHONE', () => {
	it.effect(
		'reads each selection and its keys; a selected provider needs its keys, and a key no selection uses refuses',
		() =>
			Effect.gen(function* () {
				expect((yield* config()).transactional).toBeNull();
				expect((yield* config({ ...resend, ...twilio })).transactional).toEqual({
					email: { provider: 'resend', key: 're_key', from: 'noreply@acme.example' },
					phone: { provider: 'twilio', accountSid: 'AC123', authToken: 'secret' }
				});
				expect(
					(yield* config({ ...resend, BOLT_RESEND_FROM: 'Acme <hi@acme.example>' })).transactional
				).toEqual({ email: { provider: 'resend', key: 're_key', from: 'Acme <hi@acme.example>' } });
				expect((yield* config(twilio)).transactional).toEqual({
					phone: { provider: 'twilio', accountSid: 'AC123', authToken: 'secret' }
				});
				expect(
					(yield* config({ ...resend, BOLT_TRANSACTIONAL_PHONE: 'none' })).transactional
				).toEqual({ email: { provider: 'resend', key: 're_key', from: 'noreply@acme.example' } });
				expect((yield* config(sinch)).transactional).toMatchObject({
					email: { provider: 'sinch', key: 'mg', domain: 'mg.acme.example', region: 'us' },
					phone: { provider: 'sinch', sms: { planId: 'plan' }, verification: { key: 'app' } }
				});
				expect(yield* Effect.flip(config({ BOLT_TRANSACTIONAL_EMAIL: 'resend' }))).toMatchObject({
					message: expect.stringMatching(
						/BOLT_TRANSACTIONAL_EMAIL=resend needs BOLT_RESEND_API_KEY/
					)
				});
				expect(yield* Effect.flip(config({ BOLT_TRANSACTIONAL_EMAIL: 'sinch' }))).toMatchObject({
					message: expect.stringMatching(/BOLT_SINCH_MAILGUN_KEY/)
				});
				expect(yield* Effect.flip(config({ BOLT_TRANSACTIONAL_PHONE: 'twilio' }))).toMatchObject({
					message: expect.stringMatching(/BOLT_TWILIO_ACC_SID/)
				});
				expect(yield* Effect.flip(config({ BOLT_TRANSACTIONAL_PHONE: 'sinch' }))).toMatchObject({
					message: expect.stringMatching(/BOLT_SINCH_VERIFICATION_KEY/)
				});
				expect(yield* Effect.flip(config({ ...twilio, BOLT_TWILIO_AUTH_TOKEN: '' }))).toMatchObject(
					{ message: expect.stringMatching(/BOLT_TWILIO_AUTH_TOKEN/) }
				);
				expect(yield* Effect.flip(config({ ...twilio, BOLT_TWILIO_ACC_SID: 'XX1' }))).toMatchObject(
					{ message: expect.stringMatching(/AC…/) }
				);
				expect(yield* Effect.flip(config({ ...sinch, BOLT_SINCH_SMS_FROM: '' }))).toMatchObject({
					message: expect.stringMatching(/Sinch SMS needs/)
				});
				expect((yield* config({ ...sinch, BOLT_SINCH_REGION: 'eu' })).transactional).toMatchObject({
					email: { region: 'eu' },
					phone: { region: 'eu' }
				});
				expect(yield* Effect.flip(config({ ...sinch, BOLT_SINCH_REGION: 'sg' }))).toMatchObject({
					message: expect.stringMatching(/BOLT_SINCH_REGION is one of us, eu, au, br, ca/)
				});
				expect(yield* Effect.flip(config({ ...sinch, BOLT_TWILIO_ACC_SID: 'AC1' }))).toMatchObject({
					message: expect.stringMatching(
						/BOLT_TWILIO_ACC_SID is set but no selection uses it \(BOLT_TRANSACTIONAL_PHONE=twilio\)/
					)
				});
				expect(
					yield* Effect.flip(config({ ...resend, ...twilio, BOLT_SINCH_MAILGUN_KEY: 'mg' }))
				).toMatchObject({
					message: expect.stringMatching(/BOLT_SINCH_MAILGUN_KEY is set but no selection uses it/)
				});
				expect(yield* Effect.flip(config({ ...resend, BOLT_SINCH_REGION: 'eu' }))).toMatchObject({
					message: expect.stringMatching(
						/BOLT_TRANSACTIONAL_EMAIL=sinch or BOLT_TRANSACTIONAL_PHONE=sinch/
					)
				});
				expect(yield* Effect.flip(config({ BOLT_RESEND_API_KEY: 're' }))).toMatchObject({
					message: expect.stringMatching(/BOLT_TRANSACTIONAL_EMAIL=resend/)
				});
				expect(yield* Effect.flip(config({ BOLT_TRANSACTIONAL_EMAIL: 'sendgrid' }))).toMatchObject({
					message: expect.stringMatching(/resend or sinch, not 'sendgrid'/)
				});
				expect(yield* Effect.flip(config({ BOLT_TRANSACTIONAL_PHONE: 'vonage' }))).toMatchObject({
					message: expect.stringMatching(/twilio, sinch or none/)
				});
				expect(yield* Effect.flip(config({ BOLT_TRANSACTIONAL_PROVIDER: 'twilio' }))).toMatchObject(
					{ message: expect.stringMatching(/unknown configuration: BOLT_TRANSACTIONAL_PROVIDER/) }
				);
				expect(yield* Effect.flip(config({ BOLT_MAIL: 'smtp://127.0.0.1:2525' }))).toMatchObject({
					message: expect.stringMatching(/unknown configuration: BOLT_MAIL/)
				});
				expect((yield* config()).mode).toBe('production');
				expect((yield* config({ BOLT_PUBLIC_URL: 'http://localhost:3100' })).mode).toBe('local');
				expect(
					(yield* config({
						BOLT_PUBLIC_URL: 'http://localhost:3100',
						BOLT_ENVIRONMENT: 'production'
					})).mode
				).toBe('production');
			})
	);

	it.effect(
		'resend + twilio wires Resend from noreply@<public host>, Verify and Messages to the one account',
		() =>
			Effect.gen(function* () {
				const { f, urls, bodies } = fake();
				const m = yield* messaging(yield* config({ ...resend, ...twilio }), () => {}).pipe(
					Effect.provide(client(f))
				);
				yield* m.email!.send({
					_tag: 'Mail',
					to: 'a@x.test',
					subject: 'Code',
					text: 'Your sign-in code is 123456.'
				});
				expect(
					Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(bodies[0]!)
				).toMatchObject({ from: 'noreply@acme.example', to: ['a@x.test'] });
				yield* m.phone!.start('+6581234567', 'whatsapp');
				yield* m.sms!.send({ _tag: 'Sms', to: '+6581234567', text: 'You are invited.' });
				expect(urls).toEqual([
					'https://api.resend.com/emails',
					'https://verify.twilio.com/v2/Services?PageSize=1000',
					'https://verify.twilio.com/v2/Services/VA1/Verifications',
					'https://messaging.twilio.com/v1/Services?PageSize=1',
					'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json'
				]);
			})
	);

	it.effect('sinch wires Mailgun, SMS and Verification; without phone numbers cannot sign in', () =>
		Effect.gen(function* () {
			const { f, urls } = fake();
			const m = yield* messaging(yield* config(sinch), () => {}).pipe(Effect.provide(client(f)));
			yield* m.email!.send({ _tag: 'Mail', to: 'a@x.test', subject: 'Code', text: 'x' });
			yield* m.phone!.start('+6581234567', 'sms');
			yield* m.sms!.send({ _tag: 'Sms', to: '+6581234567', text: 'You are invited.' });
			expect(urls).toEqual([
				'https://api.mailgun.net/v3/mg.acme.example/messages',
				'https://verification.api.sinch.com/verification/v1/verifications',
				'https://us.sms.api.sinch.com/xms/v1/plan/batches'
			]);
			const emailOnly = yield* messaging(
				yield* config({
					BOLT_TRANSACTIONAL_EMAIL: 'sinch',
					BOLT_SINCH_MAILGUN_KEY: 'mg',
					BOLT_SINCH_MAILGUN_DOMAIN: 'd'
				}),
				() => {}
			).pipe(Effect.provide(client(f)));
			expect(
				Object.entries(emailOnly)
					.filter(([, service]) => service !== undefined)
					.map(([name]) => name)
			).toEqual(['email']);
		})
	);

	it.effect(
		'a local host without a provider prints mail, texts and phone codes as `(sign-in code …)`; a deployed one gets nothing',
		() =>
			Effect.gen(function* () {
				const lines: string[] = [];
				const local = yield* messaging(
					yield* config({ BOLT_PUBLIC_URL: 'http://localhost:3100' }),
					(l) => lines.push(l)
				).pipe(Effect.provide(client()));
				yield* local.email!.send({
					_tag: 'Mail',
					to: 'a@x.test',
					subject: 'Your sign-in code',
					text: 'Your sign-in code is 654321.'
				});
				yield* local.sms!.send({
					_tag: 'Sms',
					to: '+6581234567',
					text: 'You are invited: https://acme.example/invite/1'
				});
				yield* local.phone!.start('+6581234567', 'whatsapp');
				expect(lines.slice(0, 2)).toEqual([
					'mail → a@x.test: Your sign-in code (sign-in code 654321)',
					'sms → +6581234567: You are invited: https://acme.example/invite/1'
				]);
				const code = /sign-in code (\d{6})\)/.exec(lines[2]!)?.[1];
				expect(lines[2]).toMatch(/^whatsapp → \+6581234567: /);
				expect(yield* local.phone!.check('+6581234567', code!)).toBe(true);
				expect(yield* local.phone!.check('+6581234567', code!)).toBe(false); // single use
				expect(yield* messaging(yield* config(), () => {}).pipe(Effect.provide(client()))).toEqual({
					email: undefined,
					sms: undefined,
					phone: undefined
				});
				// a local host with only phone configured still prints its mail
				const phoneOnly = yield* messaging(
					yield* config({ BOLT_PUBLIC_URL: 'http://localhost:3100', ...twilio }),
					() => lines.push('printed')
				).pipe(Effect.provide(client(fake().f)));
				yield* phoneOnly.email!.send({ _tag: 'Mail', to: 'a@x.test', subject: 'x', text: 'y' });
				expect(lines.at(-1)).toBe('printed');
			})
	);
});
