// The mailbox email link against local fake IMAP and SMTP servers (never a real mailbox): reading DSNs and NDRs,
// submit codes and the DSN request, watching the folder (its cursor in the `state` credential, moved only past what
// the engine stored), the open pixel, and the instance's own OAuth (authorize URL, state refusals, code exchange with
// PKCE and sealing, refresh on use, a revoked refresh flipping the instance to error).
import { describe, expect, it } from '@effect/vitest';
import { vi } from 'vitest';
import type { Socket as NetSocket } from 'node:net';
import { Clock, Effect, Exit, Fiber, Option, Schedule, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { ProviderUnavailable } from '../src/errors.ts';
import type { LinkDef } from '../src/abi.ts';
import { Cursor } from '../src/imap-smtp/model.ts';
import { mailbox } from '../src/imap-smtp/index.ts';
import { readMail } from '../src/imap-smtp/reports.ts';
import {
	fakeFetch,
	HOOK,
	host,
	json,
	messagesOf,
	REDIRECT,
	until,
	type Host,
	type HostOptions
} from './kit.ts';
import { fakeImap, fakeSmtp } from './mail-servers.ts';

// These protocol fixtures own real loopback servers. Production destination policy is tested separately.
vi.mock('@norbital-ai/bolt/node', async (original) => {
	const actual = await original<typeof import('@norbital-ai/bolt/node')>();
	const { Effect } = await import('effect');
	const { Socket } = await import('node:net');
	return {
		...actual,
		publicDestination: (hostname: string, port: number) =>
			hostname !== '127.0.0.1'
				? actual.publicDestination(hostname, port)
				: Effect.succeed({
						hostname,
						port,
						address: { address: hostname, family: 4 },
						addresses: [{ address: hostname, family: 4 }]
					}),
		connectPublic: (hostname: string, port: number) =>
			hostname !== '127.0.0.1'
				? actual.connectPublic(hostname, port)
				: Effect.gen(function* () {
						const socket = yield* Effect.acquireRelease(
							Effect.sync(() => new Socket()),
							(socket) =>
								Effect.sync(() => {
									socket.destroy();
								})
						);
						return yield* Effect.callback<NetSocket, Error>((resume) => {
							const ready = () => resume(Effect.succeed(socket));
							const failed = (error: Error) => resume(Effect.fail(error));
							socket.once('connect', ready);
							socket.once('error', failed);
							socket.connect(port, hostname);
							return Effect.sync(() => {
								socket.removeListener('connect', ready);
								socket.removeListener('error', failed);
							});
						});
					})
	};
});

const cursorOf = (h: Host) =>
	Option.getOrUndefined(Schema.decodeUnknownOption(Cursor)(h.values.get('state')));
const fixture = <A>(read: () => Promise<A>) =>
	Effect.tryPromise({
		try: read,
		catch: (error) =>
			new ProviderUnavailable({ message: error instanceof Error ? error.message : String(error) })
	});
const mail = (headers: string, body = 'hello') =>
	`${headers}\nMIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\n\n${body}\n`;
const dsn = (
	action: string,
	status: string,
	diagnostic: string,
	envid = 'm-1'
) => `From: Mail Delivery System <MAILER-DAEMON@mx.example>
To: desk@acme.example
Subject: Delivery Status Notification
Message-ID: <r-${status}@mx.example>
MIME-Version: 1.0
Content-Type: multipart/report; report-type=delivery-status; boundary="B"

--B
Content-Type: text/plain

Your message could not be delivered.
--B
Content-Type: message/delivery-status

Reporting-MTA: dns; mx.example
Original-Envelope-Id: ${envid}

Final-Recipient: rfc822; carol@else.example
Action: ${action}
Status: ${status}
${diagnostic === '' ? '' : `Diagnostic-Code: smtp; ${diagnostic}\n`}
--B
Content-Type: text/rfc822-headers

Message-ID: <m-1@acme.example>
Subject: hello

--B--
`;

describe('reading the watched folder', () => {
	it.effect(
		'an RFC 3464 DSN is a report on the message its envelope id names: bounced, deferred, delivered',
		() =>
			Effect.gen(function* () {
				expect(
					yield* readMail(
						dsn('failed', '5.1.1', '550 5.1.1 <carol@else.example>: Recipient address rejected'),
						'acme.example',
						'x'
					)
				).toEqual({
					kind: 'report',
					ids: ['<m-1@acme.example>'],
					report: {
						kind: 'bounced',
						permanent: true,
						code: '550 5.1.1',
						reason: '550 5.1.1 <carol@else.example>: Recipient address rejected'
					}
				});
				expect(yield* readMail(dsn('delayed', '4.4.7', ''), 'acme.example', 'x')).toMatchObject({
					report: { kind: 'deferred', permanent: false, code: '4.4.7' }
				});
				expect(
					yield* readMail(dsn('delivered', '2.0.0', '250 2.0.0 OK'), 'acme.example', 'x')
				).toMatchObject({ report: { kind: 'delivered', code: '250 2.0.0' } });
				expect(yield* readMail(dsn('relayed', '2.0.0', ''), 'acme.example', 'x')).toMatchObject({
					report: { kind: 'delivered', presumed: true }
				});
				// a report about someone else's message names none of ours
				expect(
					yield* readMail(
						dsn('failed', '5.1.1', '', '<other@elsewhere.example>'),
						'elsewhere.example',
						'x'
					)
				).toMatchObject({ ids: ['<other@elsewhere.example>'] });
			})
	);
	it.effect('preserves delivery reports as ordinary message evidence for personal sync', () =>
		Effect.gen(function* () {
			expect(
				yield* readMail(dsn('failed', '5.1.1', '550 rejected'), 'acme.example', 'x', false)
			).toMatchObject({
				kind: 'mail',
				message: {
					subject: 'Delivery Status Notification',
					text: expect.stringContaining('could not be delivered')
				}
			});
		})
	);

	it.effect(
		"a legacy NDR in prose (qmail) is a bounce on the quoted Message-ID; Exchange's In-Reply-To also names it",
		() =>
			Effect.gen(function* () {
				const qmail = mail(
					'From: MAILER-DAEMON@mx.example\nTo: desk@acme.example\nSubject: failure notice\nMessage-ID: <q1@mx.example>',
					"Hi. This is the qmail-send program at mx.example.\nI'm afraid I wasn't able to deliver your message to the following addresses.\n\n<carol@else.example>:\n" +
						'Remote host said: 550 5.7.1 Relaying denied\n\n--- Below this line is a copy of the message.\n\nMessage-ID: <m-9@acme.example>\nSubject: hi\n'
				);
				expect(yield* readMail(qmail, 'acme.example', 'x')).toEqual({
					kind: 'report',
					ids: ['<m-9@acme.example>'],
					report: {
						kind: 'bounced',
						permanent: true,
						code: '550 5.7.1',
						reason: 'Remote host said: 550 5.7.1 Relaying denied'
					}
				});
				const delayed = mail(
					'From: postmaster@outlook.example\nTo: desk@acme.example\nSubject: Delivery delayed: hello\nIn-Reply-To: <m-2@acme.example>',
					'Delivery has been delayed. The server will keep trying. 451 4.4.0 DNS query failed'
				);
				expect(yield* readMail(delayed, 'acme.example', 'x')).toMatchObject({
					ids: ['<m-2@acme.example>'],
					report: { kind: 'deferred', permanent: false, code: '451 4.4.0' }
				});
			})
	);
	it.effect(
		'anything else is inbound mail with its headers (an auto-reply included: bolt tells it from a person)',
		() =>
			Effect.gen(function* () {
				const r = yield* readMail(
					mail(
						'From: Carol <Carol@else.example>\nTo: desk@acme.example\nSubject: Automatic reply: hello\nAuto-Submitted: auto-replied\n' +
							'Message-ID: <c1@else.example>\nIn-Reply-To: <m-1@acme.example>\nDate: Wed, 30 Sep 2026 10:00:00 +0000',
						'I am away'
					),
					'acme.example',
					'x'
				);
				expect(r).toMatchObject({
					kind: 'mail',
					from: 'carol@else.example',
					message: {
						id: '<c1@else.example>',
						subject: 'Automatic reply: hello',
						text: 'I am away\n',
						from: { address: 'carol@else.example', name: 'Carol' },
						sentAt: '2026-09-30T10:00:00.000Z',
						headers: { 'auto-submitted': 'auto-replied', 'in-reply-to': '<m-1@acme.example>' }
					}
				});
			})
	);
});

describe('the mailbox link (password)', () => {
	const setup = Effect.fn('MailboxTest.password')(function* (
		tracking = 'off',
		emit?: () => Promise<void>
	) {
		const imap = yield* Effect.acquireRelease(
			fixture(() => fakeImap({ accept: (u, s) => u === 'desk@acme.example' && s.pass === 'pw' })),
			(server) => Effect.promise(() => server.close())
		);
		const smtp = yield* Effect.acquireRelease(
			fixture(() => fakeSmtp({ accept: (_u, p) => p === 'pw' })),
			(server) => Effect.promise(() => server.close())
		);
		imap.deliver(mail('From: old@else.example\nSubject: before\nMessage-ID: <old@else.example>')); // history: never replayed
		const provider = mailbox({ plain: true }).find((p) => p.id === 'imap')!;
		const h = yield* host(provider, fakeFetch([]), {}, emit === undefined ? {} : { emit });
		yield* Effect.addFinalizer(() => h.link.close ?? Effect.void);
		const input = {
			address: 'Desk@Acme.example',
			password: 'pw',
			imapHost: '127.0.0.1',
			imapPort: String(imap.port),
			smtpHost: '127.0.0.1',
			smtpPort: String(smtp.port),
			fromName: 'Acme Desk',
			tracking
		};
		return { imap, smtp, h, input };
	});

	it.live(
		'a wrong password keeps nothing; a right one connects and watches from the next message',
		() =>
			Effect.gen(function* () {
				const { h, input, imap } = yield* setup();
				expect(yield* Effect.flip(h.link.pair!({ ...input, password: 'nope' }))).toMatchObject({
					message: expect.stringMatching(/IMAP 127.0.0.1/)
				});
				expect(h.writes).toEqual([]);
				expect(yield* Effect.flip(h.link.pair!({ ...input, imapPort: 'x' }))).toMatchObject({
					message: expect.stringMatching(/IMAP port is not a port number/)
				});
				yield* h.link.pair!(input);
				yield* until(() => h.status?.state === 'connected');
				expect(h.status).toMatchObject({
					account: 'desk@acme.example',
					about: { address: 'desk@acme.example', folder: 'INBOX', openTracking: 'off' }
				});
				expect(h.values.get('credential')).toMatchObject({
					method: 'password',
					address: 'desk@acme.example',
					password: 'pw'
				});
				expect(cursorOf(h)).toEqual({ validity: '7', uid: 1 });
				imap.deliver(
					mail(
						'From: Carol <carol@else.example>\nTo: desk@acme.example\nSubject: Re: quote\nMessage-ID: <c2@else.example>\nIn-Reply-To: <m-1@acme.example>',
						'yes'
					)
				);
				imap.deliver(dsn('failed', '5.1.1', '550 5.1.1 unknown user'));
				imap.deliver(
					mail('From: desk@acme.example\nSubject: our own copy\nMessage-ID: <self@acme.example>')
				);
				yield* until(() => h.events.length >= 2);
				yield* Effect.sleep('200 millis');
				expect(h.events).toHaveLength(2);
				expect(h.events[0]).toMatchObject({
					kind: 'messages',
					messages: [
						{
							id: '<c2@else.example>',
							text: 'yes\n',
							headers: { 'in-reply-to': '<m-1@acme.example>' }
						}
					]
				});
				expect(h.events[1]).toMatchObject({
					kind: 'delivery',
					providerId: '<m-1@acme.example>',
					report: { kind: 'bounced', code: '550 5.1.1', provider: 'imap', permanent: true }
				});
				yield* until(() => cursorOf(h)?.uid === 4);
			})
	);

	it.effect(
		'the cursor moves only past what the engine stored: a refused message is read again, never skipped',
		() =>
			Effect.gen(function* () {
				let refuse = true;
				const { h, input, imap } = yield* setup('off', async () => {
					if (refuse) throw new Error('database unavailable');
				});
				yield* h.link.pair!(input);
				yield* TestClock.withLive(until(() => h.status?.state === 'connected'));
				imap.deliver(
					mail('From: carol@else.example\nSubject: one\nMessage-ID: <one@else.example>')
				);
				yield* TestClock.withLive(until(() => h.status?.state === 'reconnecting'));
				expect(cursorOf(h)).toEqual({ validity: '7', uid: 1 });
				refuse = false;
				imap.deliver(
					mail('From: carol@else.example\nSubject: two\nMessage-ID: <two@else.example>')
				);
				// The supervised reconnect re-reads the refused message at its unchanged cursor.
				yield* TestClock.adjust('5 seconds');
				yield* TestClock.withLive(until(() => cursorOf(h)?.uid === 3));
				expect(
					messagesOf(h.events).map(
						(m) => Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(m).id
					)
				).toEqual(['<one@else.example>', '<two@else.example>']);
			})
	);

	it.live('backfills personal mailbox history in bounded batches with saved progress', () =>
		Effect.gen(function* () {
			const { imap, smtp, h, input } = yield* setup();
			yield* h.link.close ?? Effect.void;
			yield* Effect.promise(() => smtp.close());
			for (let i = 0; i < 60; i++)
				imap.deliver(mail(`From: customer@else.example\nMessage-ID: <history-${i}@else.example>`));
			const provider = mailbox({ plain: true }).find((p) => p.id === 'imap')!;
			const personal = yield* host(provider, fakeFetch([]), {}, { personal: true });
			yield* Effect.addFinalizer(() => personal.link.close ?? Effect.void);
			const { smtpHost: _host, smtpPort: _port, ...readOnly } = input;
			yield* personal.link.pair!(readOnly);
			expect(
				yield* Effect.flip(personal.link.send!({ id: 'never-send', text: 'hi' }, undefined))
			).toMatchObject({ message: expect.stringMatching(/only synchronizes/) });
			expect(yield* Effect.flip(personal.link.test!({}))).toMatchObject({
				message: expect.stringMatching(/only synchronizes/)
			});
			expect(
				provider.describe!({
					personal: true,
					definition: { description: 'Mail', driver: 'email' }
				}).setup.fields?.map((f) => f.name)
			).not.toEqual(expect.arrayContaining(['smtpHost', 'smtpPort', 'tracking', 'quietHours']));
			yield* until(
				() => cursorOf(personal)?.uid === 61 && cursorOf(personal)?.backfill === undefined
			);
			expect(
				new Set(
					messagesOf(personal.events).map(
						(message) => Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(message).id
					)
				).size
			).toBe(61);
			expect(imap.fetches).toEqual([25, 25, 25, 11]);
			expect(
				personal.writes.some(
					(w) =>
						Option.getOrUndefined(Schema.decodeUnknownOption(Cursor)(w.get('state')))?.backfill ===
						25
				)
			).toBe(true);
		})
	);

	it.live(
		'sends as the mailbox with a DSN request; 4xx is a retryable refusal, 5xx a permanent one, both with their codes',
		() =>
			Effect.gen(function* () {
				const { h, input, smtp } = yield* setup();
				yield* h.link.pair!(input);
				const sent = yield* h.link.send!(
					{
						id: 'm-5',
						to: ['carol@else.example'],
						subject: 'Quote',
						text: 'Attached',
						html: '<p>Attached</p>',
						inReplyTo: '<c2@else.example>',
						references: ['<c2@else.example>']
					},
					undefined
				);
				expect(sent).toEqual({ providerId: '<m-5@acme.example>', presumeAfterMs: 24 * 3_600_000 });
				const got = smtp.sent.at(-1)!;
				expect(got.mailFrom).toMatch(/^MAIL FROM:<desk@acme\.example>.*RET=HDRS ENVID=m-5/);
				expect(got.rcpts[0]).toMatch(/RCPT TO:<carol@else\.example> NOTIFY=SUCCESS,FAILURE,DELAY/);
				expect(got.data).toMatch(/Message-ID: <m-5@acme\.example>/i);
				expect(got.data).toMatch(/In-Reply-To: <c2@else\.example>/i);
				expect(got.data).toMatch(/From: Acme Desk <desk@acme\.example>/);
				expect(got.data).not.toContain('/open/');
				const refusal = (to: string) =>
					Effect.flip(h.link.send!({ id: 'm-6', to: [to], subject: 's', text: 't' }, undefined));
				expect(yield* refusal('full@else.example')).toMatchObject({
					_tag: 'ProviderRefused',
					permanent: false,
					code: '452 4.2.2'
				});
				expect(yield* refusal('nobody@else.example')).toMatchObject({
					_tag: 'ProviderRefused',
					permanent: true,
					code: '550 5.1.1'
				});
			})
	);

	it.live(
		'attaches what bolt read for the message: each file its own MIME part with its name and content type',
		() =>
			Effect.gen(function* () {
				const { h, input, smtp } = yield* setup();
				yield* h.link.pair!(input);
				const file = (id: string, name: string, text: string) => ({
					id,
					name,
					mime: 'application/pdf',
					bytes: new TextEncoder().encode(text),
					url: async () => 'unused'
				});
				yield* h.link.send!(
					{
						id: 'm-8',
						to: ['carol@else.example'],
						subject: 'Notice',
						html: '<p>The attached report</p>',
						attachments: [{ id: 'f1' }, { id: 'f2' }]
					},
					[file('f1', 'PCN report.pdf', '%PDF report'), file('f2', 'datasheet.pdf', '%PDF sheet')]
				);
				const data = smtp.sent.at(-1)!.data;
				expect(data).toMatch(/Content-Type: multipart\/mixed/i);
				for (const [name, text] of [
					['PCN report.pdf', '%PDF report'],
					['datasheet.pdf', '%PDF sheet']
				] as const) {
					expect(data).toMatch(new RegExp(`Content-Type: application/pdf; name="?${name}"?`, 'i'));
					expect(data).toMatch(
						new RegExp(`Content-Disposition: attachment; filename="?${name}"?`, 'i')
					);
					expect(data).toContain(Buffer.from(text).toString('base64'));
				}
			})
	);

	it.live(
		'open tracking: a pixel in HTML mail; its hit is an approximate open; a forged one is answered the same and reported nowhere',
		() =>
			Effect.gen(function* () {
				const { h, input, smtp } = yield* setup('on');
				yield* h.link.pair!(input);
				yield* h.link.send!(
					{ id: 'm-7', to: ['carol@else.example'], subject: 's', html: '<p>hi</p>' },
					undefined
				);
				const pixel = /src=3D"([^"]+)"|src="([^"]+)"/.exec(
					smtp.sent.at(-1)!.data.replace(/=\r\n/g, '')
				);
				const url = (pixel?.[1] ?? pixel?.[2])!.replace(/=3D/g, '=');
				expect(url).toMatch(new RegExp(`^${HOOK}/open/m-7\\.[\\w-]{22}\\.gif$`));
				const forged = yield* h.link.webhook!(
					new Request(url.replace(/\.[\w-]{22}\.gif$/, '.AAAAAAAAAAAAAAAAAAAAAA.gif'))
				);
				expect(forged.headers.get('content-type')).toBe('image/gif');
				expect(h.events).toEqual([]);
				const hit = yield* h.link.webhook!(new Request(url));
				expect(hit.status).toBe(200);
				expect(h.events).toEqual([
					{
						kind: 'delivery',
						providerId: '<m-7@acme.example>',
						report: expect.objectContaining({ kind: 'opened', approximate: true, provider: 'imap' })
					}
				]);
			})
	);

	it.live(
		'the test sends to the mailbox itself and finds it in the folder; the copy is not inbound',
		() =>
			Effect.gen(function* () {
				const { h, input, smtp, imap } = yield* setup();
				yield* h.link.pair!(input);
				yield* until(() => h.status?.state === 'connected');
				const loop = yield* Effect.sync(() => {
					const m = smtp.sent.shift();
					if (m !== undefined) imap.deliver(m.data);
				}).pipe(Effect.repeat({ schedule: Schedule.spaced('20 millis') }), Effect.forkChild); // the server delivers it back
				yield* h.link.test!({}).pipe(Effect.ensuring(Fiber.interrupt(loop)));
				yield* Effect.sleep('200 millis');
				expect(h.events).toEqual([]);
			})
	);
});

describe("the mailbox link (the instance's own OAuth)", () => {
	const setup = Effect.fn('MailboxTest.oauth')(function* (
		tokenRoute: (body: URLSearchParams) => Response,
		personal = false
	) {
		yield* TestClock.setTime(1_800_000_000_000);
		const imap = yield* Effect.acquireRelease(
			fixture(() =>
				fakeImap({
					accept: (u, s) => u === 'desk@acme.example' && (s.token === 'at-1' || s.token === 'at-2')
				})
			),
			(server) => Effect.promise(() => server.close())
		);
		const smtp = yield* Effect.acquireRelease(
			fixture(() => fakeSmtp({ accept: (_u, token) => token === 'at-1' || token === 'at-2' })),
			(server) => Effect.promise(() => server.close())
		);
		const f = fakeFetch([
			(c) =>
				c.url.endsWith('/oauth2/v2.0/token') ? tokenRoute(new URLSearchParams(c.body)) : undefined
		]);
		const servers = {
			imap: { host: '127.0.0.1', port: imap.port },
			smtp: { host: '127.0.0.1', port: smtp.port }
		};
		const provider = mailbox({ plain: true, servers: { microsoft: servers } }).find(
			(p) => p.id === 'microsoft'
		)!;
		const h = yield* host(provider, f, {}, { personal });
		yield* Effect.addFinalizer(() => h.link.close ?? Effect.void);
		return {
			h,
			f,
			imap,
			advance: (ms: number) =>
				Clock.currentTimeMillis.pipe(Effect.flatMap((now) => TestClock.setTime(now + ms)))
		};
	});
	const input = {
		address: 'desk@acme.example',
		tenant: 'contoso-id',
		clientId: 'app-1',
		clientSecret: 'shh'
	};
	const callback = (link: LinkDef, q: string) => link.webhook!(new Request(`${REDIRECT}?${q}`));
	const authorize = (h: Host) => new URL(h.pairing!.value!);

	it.effect(
		"publishes an authorize URL for the popup: the tenant's app, PKCE, the host's one redirect URI, the mailbox scopes",
		() =>
			Effect.gen(function* () {
				const { h } = yield* setup(() => json({}));
				yield* h.link.pair!(input);
				expect(h.status).toEqual({ state: 'pairing' });
				expect(h.pairing).toMatchObject({ kind: 'oauth', label: 'Sign in with Microsoft' });
				const url = authorize(h);
				expect(`${url.origin}${url.pathname}`).toBe(
					'https://login.microsoftonline.com/contoso-id/oauth2/v2.0/authorize'
				);
				expect(Object.fromEntries(url.searchParams)).toMatchObject({
					response_type: 'code',
					client_id: 'app-1',
					redirect_uri: REDIRECT,
					code_challenge_method: 'S256',
					login_hint: 'desk@acme.example',
					scope:
						'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access'
				});
				// the host's state: random, and naming the instance its callback is routed to
				expect(url.searchParams.get('state')).toMatch(/^[\w-]{36}\.desk$/);
				expect(h.writes).toEqual([]); // nothing is kept before the sign-in
			})
	);

	it.effect(
		'requests IMAP and refresh permissions without SMTP.Send for personal synchronization',
		() =>
			Effect.gen(function* () {
				const { h } = yield* setup(() => json({}), true);
				yield* h.link.pair!(input);
				expect(authorize(h).searchParams.get('scope')).toBe(
					'https://outlook.office.com/IMAP.AccessAsUser.All offline_access'
				);
			})
	);

	it.effect(
		'refuses a callback with a wrong or expired state; a good one exchanges the code with the verifier and seals the tokens',
		() =>
			Effect.gen(function* () {
				let exchanged: URLSearchParams | null = null;
				const { h, advance } = yield* setup((b) => {
					exchanged = b;
					return json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
				});
				yield* h.link.pair!(input);
				const state = authorize(h).searchParams.get('state')!;
				expect((yield* callback(h.link, 'state=forged&code=c1')).status).toBe(400);
				expect(exchanged).toBeNull();
				const res = yield* callback(h.link, `state=${state}&code=c1`);
				expect(yield* fixture(() => res.text())).toContain('Connected as desk@acme.example');
				expect(Object.fromEntries(exchanged!)).toMatchObject({
					grant_type: 'authorization_code',
					code: 'c1',
					redirect_uri: REDIRECT,
					client_id: 'app-1',
					client_secret: 'shh',
					code_verifier: expect.stringMatching(/^[\w-]{43}$/)
				});
				expect(h.values.get('credential')).toMatchObject({
					method: 'microsoft',
					oauth: { clientId: 'app-1', clientSecret: 'shh', tenant: 'contoso-id' }
				});
				expect(h.values.get('token')).toMatchObject({ access: 'at-1', refresh: 'rt-1' });
				yield* TestClock.withLive(until(() => h.status?.state === 'connected'));
				// Used codes are never exchanged again, but revisiting their callback still shows success.
				const again = yield* callback(h.link, `state=${state}&code=c1`);
				expect(again.status).toBe(200);
				expect(yield* fixture(() => again.text())).toContain('Connected as desk@acme.example');
				// an attempt left for longer than ten minutes is refused
				yield* h.link.pair!(input);
				const late = authorize(h).searchParams.get('state')!;
				yield* advance(11 * 60_000);
				expect((yield* callback(h.link, `state=${late}&code=c2`)).status).toBe(400);
			})
	);

	it.effect(
		'refreshes an expired token on use and seals the rotation; a revoked refresh flips the instance to error',
		() =>
			Effect.gen(function* () {
				let mode: 'first' | 'refresh' | 'revoked' = 'first';
				const grants: string[] = [];
				const { h, advance } = yield* setup((b) => {
					grants.push(b.get('grant_type')!);
					if (mode === 'revoked')
						return json(
							{ error: 'invalid_grant', error_description: 'AADSTS50173: the grant was revoked' },
							400
						);
					return mode === 'first'
						? json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 })
						: json({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 });
				});
				yield* h.link.pair!(input);
				yield* callback(h.link, `state=${authorize(h).searchParams.get('state')}&code=c1`);
				mode = 'refresh';
				yield* advance(2 * 3_600_000);
				yield* h.link.send!(
					{ id: 'm-1', to: ['carol@else.example'], subject: 's', text: 't' },
					undefined
				);
				expect(grants).toEqual(['authorization_code', 'refresh_token']);
				expect(h.values.get('token')).toMatchObject({ access: 'at-2', refresh: 'rt-2' });
				mode = 'revoked';
				yield* advance(2 * 3_600_000);
				const e = yield* Effect.flip(
					h.link.send!(
						{ id: 'm-2', to: ['carol@else.example'], subject: 's', text: 't' },
						undefined
					)
				);
				expect(e).toMatchObject({ _tag: 'OAuthRefused', revoked: true });
				expect(h.status).toMatchObject({
					state: 'error',
					error: expect.stringMatching(/revoked or has expired.*sign in again/)
				});
			})
	);
});

describe('Gmail: one click, signed in with the host’s Google client', () => {
	const setup = Effect.fn('MailboxTest.gmail')(function* (
		google = true,
		token: () => Response | Promise<Response> = () =>
			json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }),
		write?: HostOptions['write']
	) {
		const imap = yield* Effect.acquireRelease(
			fixture(() =>
				fakeImap({ accept: (u, s) => u === 'desk@acme.example' && s.token === 'at-1' })
			),
			(server) => Effect.promise(() => server.close())
		);
		let exchanged: URLSearchParams | null = null;
		const f = fakeFetch([
			(c) => {
				if (c.url !== 'https://oauth2.googleapis.com/token') return undefined;
				exchanged = new URLSearchParams(c.body);
				return token();
			},
			(c) =>
				c.url === 'https://openidconnect.googleapis.com/v1/userinfo' &&
				c.headers['authorization'] === 'Bearer at-1'
					? json({ email: 'Desk@acme.example' })
					: undefined
		]);
		const servers = {
			imap: { host: '127.0.0.1', port: imap.port },
			smtp: { host: '127.0.0.1', port: 1 }
		};
		const provider = mailbox({ plain: true, servers: { google: servers } }).find(
			(p) => p.id === 'google'
		)!;
		const h = yield* host(
			provider,
			f,
			{},
			{
				personal: true,
				...(write === undefined ? {} : { write }),
				...(google ? { google: { id: 'host-client', secret: 'host-secret' } } : {})
			}
		);
		yield* Effect.addFinalizer(() => h.link.close ?? Effect.void);
		return { h, provider, fetch: f, exchanged: () => exchanged };
	});

	it.effect(
		'asks for nothing: Connect publishes the sign-in with the host client and the openid scopes',
		() =>
			Effect.gen(function* () {
				const { h, provider } = yield* setup();
				expect(provider).toMatchObject({ oauth: 'google', setup: { kind: 'oauth', steps: [] } });
				yield* h.link.pair!({});
				expect(h.pairing).toMatchObject({ kind: 'oauth', label: 'Sign in with Google' });
				const url = new URL(h.pairing!.value!);
				expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
				expect(url.searchParams.get('client_id')).toBe('host-client');
				expect(url.searchParams.get('scope')).toBe('https://mail.google.com/ openid email');
				expect(url.searchParams.has('login_hint')).toBe(false);
			})
	);
	it.effect(
		'completes concurrent and consumed Gmail callbacks once, then forgets a replaced attempt',
		() =>
			Effect.gen(function* () {
				const entered = Promise.withResolvers<void>(),
					allow = Promise.withResolvers<void>();
				yield* Effect.addFinalizer(() => Effect.sync(() => allow.resolve()));
				const { h, fetch } = yield* setup(true, () => {
					entered.resolve();
					return allow.promise.then(() => json({ access_token: 'at-1', refresh_token: 'rt-1' }));
				});
				yield* h.link.pair!({});
				const state = new URL(h.pairing!.value!).searchParams.get('state')!;
				const callback = (nonce = state) =>
					h.link.webhook!(new Request(`${REDIRECT}?state=${nonce}&code=c1`));
				const running = yield* Effect.forkChild(
					Effect.all([callback(), callback()], { concurrency: 2 })
				);
				yield* Effect.promise(() => entered.promise);
				expect(fetch.calls.filter((call) => call.url.endsWith('/token'))).toHaveLength(1);
				allow.resolve();
				const responses = yield* Fiber.join(running);
				const bodies = yield* fixture(() => Promise.all(responses.map((r) => r.text())));
				expect(responses.map((r) => r.status)).toEqual([200, 200]);
				expect(bodies[0]).toContain('Connected as desk@acme.example');
				expect(bodies[1]).toBe(bodies[0]);
				const repeated = yield* callback();
				expect(yield* fixture(() => repeated.text())).toBe(bodies[0]);
				expect(h.writes.filter((write) => write.has('token'))).toHaveLength(1);
				yield* TestClock.withLive(until(() => h.status?.state === 'connected'));
				expect((yield* callback('forged')).status).toBe(400);
				const sealed = h.values.get('token');
				yield* h.link.pair!({});
				const next = new URL(h.pairing!.value!).searchParams.get('state')!;
				expect((yield* callback()).status).toBe(400);
				expect(h.values.get('token')).toEqual(sealed);
				yield* h.link.unpair!();
				expect((yield* callback(next)).status).toBe(400);
				expect(fetch.calls.filter((call) => call.url.endsWith('/token'))).toHaveLength(1);
			})
	);

	it.effect('learns the mailbox from the sign-in and keeps no client of its own', () =>
		Effect.gen(function* () {
			const { h, exchanged } = yield* setup();
			yield* h.link.pair!({});
			const state = new URL(h.pairing!.value!).searchParams.get('state')!;
			const res = yield* h.link.webhook!(new Request(`${REDIRECT}?state=${state}&code=c1`));
			expect(yield* fixture(() => res.text())).toContain('Connected as desk@acme.example');
			expect(Object.fromEntries(exchanged()!)).toMatchObject({
				client_id: 'host-client',
				client_secret: 'host-secret'
			});
			const credential = h.values.get('credential');
			expect(credential).toMatchObject({ method: 'google', address: 'desk@acme.example' });
			expect(credential).not.toHaveProperty('oauth');
		})
	);

	it.effect('unpair revokes the Google grant before the tokens are dropped', () =>
		Effect.gen(function* () {
			const { h, fetch } = yield* setup();
			yield* h.link.pair!({});
			const state = new URL(h.pairing!.value!).searchParams.get('state')!;
			yield* h.link.webhook!(new Request(`${REDIRECT}?state=${state}&code=c1`));
			yield* h.link.unpair!();
			const revoked = fetch.calls.filter(
				(call) => call.url === 'https://oauth2.googleapis.com/revoke'
			);
			expect(revoked).toHaveLength(1);
			expect(new URLSearchParams(revoked[0]!.body).get('token')).toBe('rt-1');
		})
	);

	it.effect(
		'disconnect waits for an irreversible Gmail credential write before wiping its keys',
		() =>
			Effect.gen(function* () {
				const entered = Promise.withResolvers<void>(),
					allow = Promise.withResolvers<void>();
				yield* Effect.addFinalizer(() => Effect.sync(() => allow.resolve()));
				const { h } = yield* setup(true, undefined, async (changes) => {
					if (!changes.has('credential')) return;
					entered.resolve();
					await allow.promise;
				});
				yield* h.link.pair!({});
				const state = new URL(h.pairing!.value!).searchParams.get('state')!;
				const callback = () => h.link.webhook!(new Request(`${REDIRECT}?state=${state}&code=c1`));
				const signingIn = yield* Effect.forkChild(callback());
				yield* Effect.promise(() => entered.promise);
				let disconnected = false;
				const wiped: string[] = [];
				const disconnecting = yield* Effect.forkChild(
					h.link.unpair!().pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								// The host wipes the keys known after the provider's unpair completes.
								wiped.push(...h.values.keys());
								h.values.clear();
								disconnected = true;
							})
						)
					),
					{ startImmediately: true }
				);
				yield* Effect.yieldNow;
				expect(disconnected).toBe(false);
				allow.resolve();
				yield* Fiber.join(disconnecting);
				expect(Exit.isFailure(yield* Fiber.await(signingIn))).toBe(true);
				yield* until(() => h.writes.some((changes) => changes.has('credential')));
				expect(wiped).toEqual(expect.arrayContaining(['credential', 'token']));
				expect([...h.values]).toEqual([]);
				const statuses = h.statuses.length;
				expect((yield* callback()).status).toBe(400);
				expect(h.statuses).toHaveLength(statuses);
			})
	);

	it.effect('refuses to pair where the host has no Google client', () =>
		Effect.gen(function* () {
			const { h } = yield* setup(false);
			expect(yield* Effect.flip(h.link.pair!({}))).toBeInstanceOf(ProviderUnavailable);
		})
	);
});
