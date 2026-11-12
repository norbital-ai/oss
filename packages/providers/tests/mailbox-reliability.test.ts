// The mailbox link's recovery against the fake server: a new UIDVALIDITY, unparsable and oversized mail, one message
// held at a time, and deletes, live under QRESYNC and by reconcile everywhere.
import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, Option, Schema } from 'effect';
import { loopback_tcp_port } from '@norbital-ai/bolt/node';
import { ProviderUnavailable } from '../src/errors.ts';
import { mailbox } from '../src/imap-smtp/index.ts';
import { mailboxWatch, type Reconcile } from '../src/imap-smtp/mailbox-watch.ts';
import { Cursor, Mailbox } from '../src/imap-smtp/model.ts';
import { readMail } from '../src/imap-smtp/reports.ts';
import { required, fakeFetch, host, messagesOf, until, type Host } from './kit.ts';
import { fakeImap } from './mail-servers.ts';

const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const message = (id: string, headers = '') =>
	`From: customer@example.test\nMessage-ID: <${id}@example.test>\n${headers}Subject: ${id}\n\nbody of ${id}\n`;
const cursor = (h: Host) =>
	Option.getOrNull(Schema.decodeUnknownOption(Cursor)(h.values.get('state')));
const Wire = Schema.Struct({
	id: Schema.String,
	text: Schema.optionalKey(Schema.String),
	deleted: Schema.optionalKey(Schema.Boolean)
});
const ids = (messages: readonly unknown[]) =>
	messages.map((value) => Schema.decodeUnknownSync(Wire)(value).id);
const box = (port: number) => ({
	method: 'password',
	address: 'desk@example.test',
	user: 'desk@example.test',
	password: 'pw',
	fromName: null,
	folder: 'INBOX',
	tracking: false,
	quietHours: 24,
	imap: { host: '127.0.0.1', port },
	pixelKey: 'unused'
});
const fixture = Effect.fn('MailboxReliability.fixture')(function* (qresync = false) {
	const server = yield* Effect.acquireRelease(
		Effect.tryPromise({
			try: () => fakeImap({ accept: (_user, secret) => secret.pass === 'pw', qresync }),
			catch: (error) => new ProviderUnavailable({ message: String(error) })
		}),
		(running) => Effect.promise(() => running.close())
	);
	const open = Effect.fn('MailboxReliability.open')(function* (
		state: { readonly validity: string; readonly uid: number; readonly began?: string },
		personal = false,
		settings: { readonly authServer?: string } = {}
	) {
		const provider = required(mailbox({ plain: true }).find((p) => p.id === 'imap'));
		const h = yield* host(
			provider,
			fakeFetch([]),
			{ credential: { ...box(server.port), ...settings }, state },
			{ personal }
		);
		yield* Effect.addFinalizer(() => h.link.close ?? Effect.void);
		yield* until(() => h.status?.state === 'connected');
		return h;
	});
	return { server, open };
});

describe('a mailbox that names its mail server', () => {
	it.live('marks only the mail that server vouched for', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture();
				const verdict = 'Authentication-Results: mx.test; dmarc=pass header.from=example.test\n';
				f.server.deliver(message('proved', verdict), ago(60_000));
				f.server.deliver(message('claimed'), ago(60_000));
				const h = yield* f.open({ validity: '6', uid: 999 }, false, { authServer: 'mx.test' });
				yield* until(() => cursor(h)?.uid === 2);
				expect(messagesOf(h.events)).toMatchObject([
					{ id: '<proved@example.test>', authenticated: true },
					{ id: '<claimed@example.test>' }
				]);
				expect(messagesOf(h.events)[1]).not.toHaveProperty('authenticated');
			})
		)
	);
});

describe('a new UIDVALIDITY', () => {
	it.live(
		'recovers the bounded window, as history once nobody is waiting, instead of skipping it',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture();
					f.server.deliver(message('long-gone'), ago(30 * DAY));
					f.server.deliver(message('unread'), ago(2 * DAY));
					f.server.deliver(message('just-now'), ago(60_000));
					const h = yield* f.open({ validity: '6', uid: 999 });
					yield* until(() => cursor(h)?.uid === 3);
					expect(ids(messagesOf(h.events))).toEqual([
						'<unread@example.test>',
						'<just-now@example.test>'
					]);
					expect(h.events).toMatchObject([
						{ kind: 'messages', history: true },
						{ kind: 'messages' }
					]);
					expect(h.events[1]).not.toHaveProperty('history');
					expect(cursor(h)).toMatchObject({ validity: '7', began: expect.any(String) });
				})
			)
	);
	it.live('a refused recovery search keeps the old cursor, and never jumps past the mail', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture();
				f.server.deliver(message('unread'), ago(DAY));
				f.server.refuseSearches();
				const provider = required(mailbox({ plain: true }).find((p) => p.id === 'imap'));
				const h = yield* host(provider, fakeFetch([]), {
					credential: box(f.server.port),
					state: { validity: '6', uid: 999 }
				});
				yield* Effect.addFinalizer(() => h.link.close ?? Effect.void);
				yield* until(() => h.status?.state === 'reconnecting');
				expect(cursor(h)).toEqual({ validity: '6', uid: 999 });
			})
		)
	);
});

describe('mail that cannot be read whole', () => {
	it.live(
		'an unparsable mail is stored from its headers with its source, and the cursor moves on',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture();
					const h = yield* f.open({ validity: '7', uid: 0 });
					// PostalMime refuses headers over 2 MiB
					f.server.deliver(message('bomb', `X-Pad: ${'x'.repeat(2.5 * 1024 * 1024)}\n`));
					f.server.deliver(message('after'));
					yield* until(() => cursor(h)?.uid === 2);
					expect(messagesOf(h.events)).toMatchObject([
						{
							id: '<bomb@example.test>',
							from: { address: 'customer@example.test' },
							subject: 'bomb',
							text: expect.stringContaining('could not be read'),
							attachments: [{ name: 'message.eml', mime: 'message/rfc822', bin: 0 }]
						},
						{ id: '<after@example.test>', text: 'body of after\n' }
					]);
					expect(h.events[0]).toMatchObject({ bins: [expect.any(Uint8Array)] });
				})
			)
	);
	it.effect('an empty source, or one with no sender, is still a message the engine can store', () =>
		Effect.gen(function* () {
			expect(yield* readMail(new Uint8Array(0), 'example.test', '<x@example.test>')).toMatchObject({
				id: '<x@example.test>',
				message: {
					from: { address: 'unknown@invalid' },
					text: expect.stringContaining('raw source')
				}
			});
			expect(
				yield* readMail('Subject: hi\n\nhello\n', 'example.test', '<y@example.test>')
			).toMatchObject({
				message: { from: { address: 'unknown@invalid' }, text: 'hello\n' }
			});
		})
	);
	it.live(
		'reads one capped message at a time; an oversized one keeps its text and names its files',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture();
					const h = yield* f.open({ validity: '7', uid: 0 });
					f.server.deliver(message('small'));
					f.server.deliver(
						`${message('huge')}${'x'.repeat(32 * 1024 * 1024)}\n`,
						new Date(),
						'(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 40 2)("APPLICATION" "PDF" ("NAME" "scan.pdf") NIL NIL "BASE64" 90000000) "MIXED")'
					);
					yield* until(() => cursor(h)?.uid === 2);
					expect(f.server.fetches).toEqual([1, 1]);
					expect(f.server.commands.every((c) => c.includes('BODY.PEEK[]<0.33554432>'))).toBe(true);
					expect(messagesOf(h.events)[1]).toMatchObject({
						attachments: [{ name: 'scan.pdf', mime: 'application/pdf', bytes: 90_000_000 }]
					});
					expect(h.events[1]).not.toHaveProperty('bins');
				})
			)
	);
	it.effect('a Date header cannot place a mail after its arrival', () =>
		Effect.gen(function* () {
			expect(
				yield* readMail(
					'From: a@b.example\nDate: Fri, 01 Jan 2100 00:00:00 +0000\n\nhi\n',
					'b.example',
					'<z@b.example>',
					true,
					'2026-11-01T00:00:00.000Z'
				)
			).toMatchObject({ message: { sent_at: '2026-11-01T00:00:00.000Z' } });
		})
	);
});

describe('deletes', () => {
	const thread = '<root@example.test>';
	const seeded = Effect.fn('MailboxReliability.seeded')(function* (qresync = false) {
		const f = yield* fixture(qresync);
		f.server.deliver(message('root'), ago(DAY));
		f.server.deliver(message('reply', `References: ${thread}\n`), ago(DAY));
		f.server.deliver(message('other'), ago(DAY));
		const h = yield* f.open({ validity: '7', uid: 3 });
		return { ...f, h };
	});
	const since = () => ago(7 * DAY).toISOString();

	it.live('reconcile compares a whole window of UIDs, so what left the folder is missing', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { h, server } = yield* seeded();
				const before = yield* required(h.link.reconcile)(thread, since());
				expect(ids(before.messages)).toEqual([thread, '<reply@example.test>']);
				expect(before.complete).toBe(true);
				server.expunge(2);
				const after = yield* required(h.link.reconcile)(thread, since());
				expect(ids(after.messages)).toEqual([thread]);
				expect(after.complete).toBe(true);
				// one fetch of the window's headers, then only what is new: a pass of many threads does not read it again
				expect(server.commands.filter((c) => /HEADER/.test(c))).toHaveLength(1);
			})
		)
	);
	it.live('reconcile names files by size and downloads none of their bytes', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture();
				f.server.deliver(
					message('files'),
					ago(DAY),
					'(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 10 1)("APPLICATION" "PDF" ("NAME" "scan.pdf") NIL NIL "BASE64" 4000) "MIXED")'
				);
				const h = yield* f.open({ validity: '7', uid: 1 });
				const page = yield* required(h.link.reconcile)('<files@example.test>', since());
				expect(page.messages).toMatchObject([
					{ attachments: [{ name: 'scan.pdf', mime: 'application/pdf', bytes: 4000 }] }
				]);
				expect(page).not.toHaveProperty('bins');
				expect(f.server.commands.at(-1)).toContain('BODY.PEEK[]<0.65536>');
			})
		)
	);
	it.live('a reconcile claims nothing about mail still draining', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture();
				f.server.deliver(message('root'), ago(DAY));
				f.server.deliver(message('late', `References: ${thread}\n`), ago(DAY));
				const state = { validity: '7', uid: 1 },
					mailbox_ = Schema.decodeUnknownSync(Mailbox)(box(f.server.port));
				let served: Reconcile | null = null;
				const watching = yield* Effect.forkScoped(
					mailboxWatch({
						box: mailbox_,
						personal: false,
						net: { tcp: loopback_tcp_port, plain: true },
						login: () => Effect.succeed({ user: mailbox_.user, pass: 'pw' }),
						// the cursor stays put: UID 2 is not stored yet
						cursor: () => state,
						advance: () => Effect.void,
						deliver: () => Effect.void,
						peek: (source, fallback, receivedAt, files) =>
							readMail(source, 'example.test', fallback, true, receivedAt, files).pipe(
								Effect.map((read) => (read.kind === 'report' ? null : read))
							),
						vanished: () => Effect.void,
						serve: (next) =>
							Effect.sync(() => {
								served = next;
							}),
						connected: Effect.void
					})
				);
				yield* until(() => served !== null);
				const page = yield* required<Reconcile>(served)(thread, since());
				expect(ids(page.messages)).toEqual([thread]);
				expect(page.complete).toBe(false);
				yield* Fiber.interrupt(watching);
			})
		)
	);
	it.live('a page starts where this view of the folder began', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture();
				f.server.deliver(message('root'), ago(DAY));
				const began = ago(1000).toISOString();
				const h = yield* f.open({ validity: '7', uid: 1, began });
				expect(yield* required(h.link.reconcile)(thread, since())).toMatchObject({ since: began });
			})
		)
	);
	it.live('a new pairing starts its own view, so rows of another folder are never compared', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture();
				const provider = required(mailbox({ plain: true }).find((p) => p.id === 'imap'));
				const h = yield* host(provider, fakeFetch([]), { credential: box(f.server.port) });
				yield* Effect.addFinalizer(() => h.link.close ?? Effect.void);
				yield* until(() => h.status?.state === 'connected');
				const page = yield* required(h.link.reconcile)(thread, since());
				expect(page.since).toBe(cursor(h)?.began);
				expect(page.since).toEqual(expect.any(String));
			})
		)
	);
	it.live('a refused window search fails, never reading as an emptied folder', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { h, server } = yield* seeded();
				server.refuseSearches();
				expect(yield* Effect.flip(required(h.link.reconcile)(thread, since()))).toMatchObject({
					_tag: 'ProviderUnavailable',
					message: expect.stringMatching(/refused the window search/)
				});
			})
		)
	);
	it.live(
		'under QRESYNC a known UID that vanishes is a delete at once; a plain EXPUNGE waits',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const live = yield* seeded(true);
					yield* required(live.h.link.reconcile)(thread, since());
					live.server.expunge(2);
					yield* until(() => live.h.events.length === 1);
					expect(messagesOf(live.h.events)).toEqual([
						{ id: '<reply@example.test>', deleted: true }
					]);
					live.server.deliver(message('fresh'));
					yield* until(() => live.h.events.length === 2);
					live.server.expunge(4);
					yield* until(() => live.h.events.length === 3);
					expect(messagesOf(live.h.events).at(-1)).toEqual({
						id: '<fresh@example.test>',
						deleted: true
					});
					const plain = yield* seeded();
					yield* required(plain.h.link.reconcile)(thread, since());
					plain.server.expunge(2);
					plain.server.deliver(message('next'));
					yield* until(() => plain.h.events.length === 1);
					expect(ids(messagesOf(plain.h.events))).toEqual(['<next@example.test>']);
				})
			)
	);
});
