import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Schema } from 'effect';
import { vi } from 'vitest';
import { ProviderUnavailable, type ProviderFailure } from '../src/errors.ts';
import { mailboxWatch } from '../src/imap-smtp/mailbox-watch.ts';
import { type Cursor, Mailbox } from '../src/imap-smtp/model.ts';
import { fakeImap } from './mail-servers.ts';
import { until } from './kit.ts';

vi.mock('@norbital-ai/bolt/engine', async (original) => {
	const actual = await original<typeof import('@norbital-ai/bolt/engine')>();
	const { Effect } = await import('effect');
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
					})
	};
});

const range = (first: number, last: number) =>
	Array.from({ length: last - first + 1 }, (_, index) => first + index);

const fixture = Effect.fn('MailboxBackfill.fixture')(function* (
	initial: Cursor | null = null,
	personal = true,
	after?: string
) {
	const server = yield* Effect.acquireRelease(
		Effect.tryPromise({
			try: () => fakeImap({ accept: (_user, secret) => secret.pass === 'pw' }),
			catch: (error) => new ProviderUnavailable({ message: String(error) })
		}),
		(server) => Effect.promise(() => server.close())
	);
	const box = Schema.decodeUnknownSync(Mailbox)({
		address: 'desk@example.test',
		user: 'desk@example.test',
		method: 'password',
		password: 'pw',
		fromName: null,
		folder: 'INBOX',
		tracking: false,
		quietHours: 24,
		imap: { host: '127.0.0.1', port: server.port },
		pixelKey: 'unused'
	});
	let cursor = initial,
		sent = 0;
	let beforeDeliver: (uid: number) => Effect.Effect<void, ProviderFailure> = () => Effect.void;
	const accepted = new Set<number>(),
		attempts: number[] = [],
		advances: Cursor[] = [];
	return {
		server,
		accepted,
		attempts,
		advances,
		cursor: () => cursor,
		append: (count: number, receivedAt?: Date) => {
			for (let index = 0; index < count; index++) {
				const uid = ++sent;
				server.deliver(
					`From: customer@example.test\nMessage-ID: <mail-${uid}@example.test>\nSubject: Mail ${uid}\n\nBody ${uid}\n`,
					receivedAt
				);
			}
		},
		beforeDeliver: (handler: typeof beforeDeliver) => {
			beforeDeliver = handler;
		},
		watch: () =>
			mailboxWatch({
				box,
				personal,
				after,
				plain: true,
				login: () => Effect.succeed({ user: box.user, pass: 'pw' }),
				cursor: () => cursor,
				advance: (next) =>
					Effect.sync(() => {
						cursor = { ...next };
						advances.push(cursor);
					}),
				deliver: (_source, fallback) =>
					Effect.gen(function* () {
						const uid = Number(fallback.slice(fallback.lastIndexOf('-') + 1));
						if (!Number.isSafeInteger(uid))
							return yield* Effect.fail(
								new ProviderUnavailable({ message: 'Invalid message UID' })
							);
						attempts.push(uid);
						yield* beforeDeliver(uid);
						accepted.add(uid);
					}),
				connected: Effect.void
			})
	};
});

describe('mailbox history checkpoints', { timeout: 15_000 }, () => {
	it.live(
		'retains a workspace mailbox’s unconsumed checkpoint backlog when its boundary changes',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const after = '2026-10-20T16:00:00.000Z';
					const f = yield* fixture({ validity: '7', uid: 40 }, false, after);
					f.append(50, new Date('2026-10-20T17:00:00.000Z'));
					const watching = yield* Effect.forkScoped(f.watch());
					yield* until(() => f.cursor()?.uid === 50);
					expect(f.advances[0]).toEqual({ validity: '7', uid: 40, after });
					expect(f.attempts).toEqual(range(41, 50));
					expect([...f.accepted]).toEqual(range(41, 50));
					expect(f.cursor()).toEqual({ validity: '7', uid: 50, after });
					yield* Fiber.interrupt(watching);
				})
			)
	);

	it.live('checks new mail before every history batch and retains overlapping newer gaps', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture();
				const firstHistory = yield* Deferred.make<void>(),
					resumeFirst = yield* Deferred.make<void>(),
					secondHistory = yield* Deferred.make<void>(),
					resumeSecond = yield* Deferred.make<void>();
				f.append(80);
				f.beforeDeliver((uid) =>
					uid === 1
						? Deferred.succeed(firstHistory, undefined).pipe(
								Effect.andThen(Deferred.await(resumeFirst))
							)
						: uid === 26
							? Deferred.succeed(secondHistory, undefined).pipe(
									Effect.andThen(Deferred.await(resumeSecond))
								)
							: Effect.void
				);
				const watching = yield* Effect.forkScoped(f.watch());
				yield* Deferred.await(firstHistory);
				expect([...f.attempts.slice(0, 25)].sort((left, right) => left - right)).toEqual(
					range(56, 80)
				);
				f.append(1);
				yield* Deferred.succeed(resumeFirst, undefined);
				yield* Deferred.await(secondHistory);
				expect(f.accepted.has(81)).toBe(true);
				expect(f.attempts.indexOf(81)).toBeLessThan(f.attempts.indexOf(26));
				f.append(40);
				yield* Deferred.succeed(resumeSecond, undefined);
				yield* until(() => f.accepted.size === 121 && f.cursor()?.backfill === undefined);
				expect(f.attempts.indexOf(121)).toBeLessThan(f.attempts.indexOf(51));
				expect([...f.accepted].sort((left, right) => left - right)).toEqual(range(1, 121));
				expect(f.cursor()).toEqual({ validity: '7', uid: 121 });
				expect(f.advances.some((cursor) => cursor.uid > 81 && cursor.backfill === 50)).toBe(true);
				expect(f.server.fetches.every((size) => size > 0 && size <= 25)).toBe(true);
				yield* Fiber.interrupt(watching);
			})
		)
	);

	it.live('restarts from acknowledged prefixes after failures in recent mail and history', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture();
				let refused: number | null = 60;
				f.append(80);
				f.beforeDeliver((uid) =>
					uid === refused
						? Effect.fail(new ProviderUnavailable({ message: 'The engine refused delivery' }))
						: Effect.void
				);
				const first = yield* Effect.forkScoped(f.watch());
				expect((yield* Fiber.await(first))._tag).toBe('Failure');
				expect([...f.accepted]).toEqual(range(56, 59));
				expect(f.cursor()).toEqual({ validity: '7', uid: 59, backfill: 0 });
				refused = 11;
				const second = yield* Effect.forkScoped(f.watch());
				expect((yield* Fiber.await(second))._tag).toBe('Failure');
				expect(f.accepted.has(60)).toBe(true);
				expect(f.accepted.has(11)).toBe(false);
				expect(f.cursor()).toEqual({ validity: '7', uid: 80, backfill: 10 });
				refused = null;
				const third = yield* Effect.forkScoped(f.watch());
				yield* until(() => f.accepted.size === 80 && f.cursor()?.backfill === undefined);
				expect([...f.accepted].sort((left, right) => left - right)).toEqual(range(1, 80));
				expect(f.cursor()).toEqual({ validity: '7', uid: 80 });
				expect(f.server.fetches.every((size) => size > 0 && size <= 25)).toBe(true);
				yield* Fiber.interrupt(third);
			})
		)
	);

	it.live('discards both cursor bounds when UIDVALIDITY changes', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture({ validity: 'old', uid: 1000, backfill: 900 });
				f.append(30);
				const watching = yield* Effect.forkScoped(f.watch());
				yield* until(() => f.accepted.size === 30 && f.cursor()?.backfill === undefined);
				expect(f.advances[0]).toEqual({ validity: '7', uid: 0 });
				expect([...f.attempts.slice(0, 25)].sort((left, right) => left - right)).toEqual(
					range(6, 30)
				);
				expect([...f.accepted].sort((left, right) => left - right)).toEqual(range(1, 30));
				expect(f.cursor()).toEqual({ validity: '7', uid: 30 });
				expect(f.server.fetches.every((size) => size > 0 && size <= 25)).toBe(true);
				yield* Fiber.interrupt(watching);
			})
		)
	);
});
