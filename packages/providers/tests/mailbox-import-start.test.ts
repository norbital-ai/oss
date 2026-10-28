import { describe, expect, it } from '@effect/vitest';
import { Effect, Option, Schema } from 'effect';
import type { DriverOpen } from '@norbital-ai/bolt/engine';
import { mailbox } from '../src/imap-smtp/index.ts';
import { Cursor } from '../src/imap-smtp/model.ts';
import { ProviderUnavailable } from '../src/errors.ts';
import { fakeFetch, host, messagesOf, until, type Host } from './kit.ts';
import { fakeImap, loopback } from './mail-servers.ts';

const after = '2026-10-20T16:00:00.000Z';
const since = { kind: 'since', at: after, zone: 'Asia/Singapore', origin: 'date' } as const;
const message = (id: string, date?: string) =>
	`From: customer@example.test\nMessage-ID: <${id}@example.test>\n${date === undefined ? '' : `Date: ${date}\n`}Subject: ${id}\n\n${id}\n`;
const cursor = (h: Host) =>
	Option.getOrNull(Schema.decodeUnknownOption(Cursor)(h.values.get('state')));
const ids = (h: Host) =>
	messagesOf(h.events).map(
		(value) => Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(value).id
	);
const fixture = Effect.fn('MailboxImportStart.fixture')(function* () {
	const server = yield* Effect.acquireRelease(
		Effect.tryPromise({
			try: () => fakeImap({ accept: (_user, secret) => secret.pass === 'pw' }),
			catch: (error) => new ProviderUnavailable({ message: String(error) })
		}),
		(server) => Effect.promise(() => server.close())
	);
	const provider = mailbox({ net: loopback }).find((provider) => provider.id === 'imap');
	if (provider === undefined) return yield* Effect.die('The mailbox provider is missing');
	const open = Effect.fn('MailboxImportStart.open')(function* (
		start: DriverOpen['importStart'],
		stored: ReadonlyMap<string, typeof Schema.Json.Type> = new Map()
	) {
		const h = yield* host(provider, fakeFetch([]), Object.fromEntries(stored), {
			personal: true,
			...(start === undefined ? {} : { importStart: start })
		});
		yield* Effect.addFinalizer(() => h.link.close ?? Effect.void);
		return h;
	});
	const pair = (h: Host) =>
		h.link.pair?.({
			address: 'desk@example.test',
			user: 'desk@example.test',
			password: 'pw',
			imapHost: '127.0.0.1',
			imapPort: String(server.port),
			folder: 'INBOX'
		}) ?? Effect.die('The mailbox cannot pair');
	return { server, provider, open, pair };
});

describe('mailbox import start', () => {
	it.live(
		'enforces authoritative INTERNALDATE and rejects unknown source times before storing mail',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture();
					f.server.deliver(
						message('old', 'Wed, 21 Oct 2026 01:00:00 +0000'),
						new Date('2026-10-20T15:59:59Z')
					);
					f.server.deliver(message('equal', 'Wed, 21 Oct 2026 00:00:00 +0800'), new Date(after));
					f.server.deliver(
						message('new', 'Wed, 21 Oct 2026 00:00:01 +0800'),
						new Date('2026-10-20T16:00:01Z')
					);
					f.server.deliver(message('undated-old'), new Date('2026-10-20T15:59:59Z'));
					f.server.deliver(message('invalid-old', 'not a date'), new Date('2026-10-20T15:59:59Z'));
					f.server.deliver(message('undated-new'), new Date('2026-10-20T16:00:01Z'));
					f.server.deliver(
						message('old-header-new', 'Tue, 20 Oct 2026 15:59:59 +0000'),
						new Date('2026-10-20T16:00:02Z')
					);
					f.server.deliver(message('unknown', 'Wed, 21 Oct 2026 00:00:01 +0800'), null);
					const h = yield* f.open(since);
					yield* f.pair(h);
					yield* until(() => cursor(h)?.uid === 8);
					expect(ids(h)).toEqual([
						'<equal@example.test>',
						'<new@example.test>',
						'<undated-new@example.test>',
						'<old-header-new@example.test>'
					]);
					expect(cursor(h)).toEqual({ validity: '7', uid: 8, after });
					expect(f.server.searches.some((query) => /SINCE/i.test(query))).toBe(true);
					expect(
						messagesOf(h.events).map(
							(value) =>
								Schema.decodeUnknownSync(Schema.Struct({ sourceAt: Schema.String }))(value).sourceAt
						)
					).toEqual([
						after,
						'2026-10-20T16:00:01.000Z',
						'2026-10-20T16:00:01.000Z',
						'2026-10-20T16:00:02.000Z'
					]);
					expect(f.provider.importStart).toEqual({ kind: 'timestamp', precision: 'second' });
				})
			)
	);
	it.live('includes the whole starting second of a frozen From now import', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture();
				const at = '2026-10-21T01:40:12.000Z';
				f.server.deliver(message('previous-second'), new Date('2026-10-21T01:40:11Z'));
				f.server.deliver(message('same-second'), new Date(at));
				f.server.deliver(message('next-second'), new Date('2026-10-21T01:40:13Z'));
				const h = yield* f.open({ kind: 'since', origin: 'now', at, zone: 'Asia/Singapore' });
				yield* f.pair(h);
				yield* until(() => cursor(h)?.uid === 3);
				expect(ids(h)).toEqual(['<same-second@example.test>', '<next-second@example.test>']);
				expect(cursor(h)).toEqual({ validity: '7', uid: 3, after: at });
			})
		)
	);

	it.live('changes import scope and resumes matching history without changing credentials', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture();
				f.server.deliver(
					message('old', 'Tue, 20 Oct 2026 15:59:59 +0000'),
					new Date('2026-10-20T15:59:59Z')
				);
				for (let index = 0; index < 60; index++)
					f.server.deliver(
						message(`new-${index}`, 'Wed, 21 Oct 2026 01:00:00 +0800'),
						new Date('2026-10-20T17:00:00Z')
					);
				const original = yield* f.open(null);
				yield* f.pair(original);
				yield* until(
					() => cursor(original)?.uid === 61 && cursor(original)?.backfill === undefined
				);
				const credential = original.values.get('credential');
				yield* original.link.close ?? Effect.void;
				const filtered = yield* f.open(since, original.values);
				yield* until(
					() =>
						cursor(filtered)?.uid === 61 &&
						cursor(filtered)?.backfill === undefined &&
						cursor(filtered)?.after === after
				);
				expect(new Set(ids(filtered)).size).toBe(60);
				expect(ids(filtered)).not.toContain('<old@example.test>');
				expect(filtered.values.get('credential')).toEqual(credential);
				expect(
					filtered.writes.some(
						(changes) =>
							Option.getOrNull(Schema.decodeUnknownOption(Cursor)(changes.get('state')))
								?.backfill !== undefined
					)
				).toBe(true);
				yield* filtered.link.close ?? Effect.void;
				f.server.deliver(
					message('fresh', 'Wed, 21 Oct 2026 02:00:00 +0800'),
					new Date('2026-10-20T18:00:00Z')
				);
				const resumed = yield* f.open(since, filtered.values);
				yield* until(() => cursor(resumed)?.uid === 62);
				expect(ids(resumed)).toEqual(['<fresh@example.test>']);
				yield* resumed.link.close ?? Effect.void;
				const earlierAt = '2026-10-19T16:00:00.000Z';
				const earlier = yield* f.open({ ...since, at: earlierAt }, resumed.values);
				yield* until(
					() =>
						cursor(earlier)?.uid === 62 &&
						cursor(earlier)?.backfill === undefined &&
						cursor(earlier)?.after === earlierAt
				);
				expect(new Set(ids(earlier)).size).toBe(62);
				expect(ids(earlier)).toContain('<old@example.test>');
				expect(earlier.values.get('credential')).toEqual(credential);
				yield* earlier.link.close ?? Effect.void;
				const all = yield* f.open({ kind: 'all' }, earlier.values);
				yield* until(
					() =>
						cursor(all)?.uid === 62 &&
						cursor(all)?.backfill === undefined &&
						cursor(all)?.after === undefined
				);
				expect(new Set(ids(all)).size).toBe(62);
				expect(ids(all)).toContain('<old@example.test>');
				expect(all.values.get('credential')).toEqual(credential);
				expect(f.server.fetches.every((size) => size > 0 && size <= 25)).toBe(true);
			})
		)
	);
});
