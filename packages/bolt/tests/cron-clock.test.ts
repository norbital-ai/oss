// The in-process cron clock on the TestClock: each slot fires once at its minute, in its zone; one run per id at a
// time, keeping only the latest slot that waited; a restart starts from now.
import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Queue } from 'effect';
import { TestClock } from 'effect/testing';
import type { CronEntry } from '../src/engine/contracts.ts';
import { cronClock } from '../src/node/cron-clock.ts';

const clock = (
	crons: readonly CronEntry[],
	onFire: (id: string, slot: string) => Effect.Effect<void>
) =>
	cronClock({
		crons: Effect.succeed(crons),
		fire: (id, slot) => onFire(id, slot).pipe(Effect.as({ ran: true }))
	});
/** Fires reach the queue from the clock's own fibers: taking waits for them. */
const takes = (fired: Queue.Queue<string>, n: number) =>
	Effect.forEach(Array.from({ length: n }), () => Queue.take(fired));

describe('cronClock', () => {
	it.effect('fires each slot once at its minute, in its zone', () =>
		Effect.scoped(
			Effect.gen(function* () {
				yield* TestClock.setTime(Date.parse('2026-09-25T21:58:30Z'));
				const fired = yield* Queue.unbounded<string>();
				yield* clock(
					[
						{ id: 'pulse', cron: '*/5 * * * *', zone: 'UTC' },
						{ id: 'six', cron: '0 6 * * *', zone: 'Asia/Singapore' }
					],
					(id, slot) => Queue.offer(fired, `${id}@${slot}`).pipe(Effect.asVoid)
				);
				yield* TestClock.adjust('12 minutes');
				expect((yield* takes(fired, 4)).sort()).toEqual([
					'pulse@2026-09-25T22:00:00.000Z',
					'pulse@2026-09-25T22:05:00.000Z',
					'pulse@2026-09-25T22:10:00.000Z',
					'six@2026-09-25T22:00:00.000Z'
				]);
			})
		)
	);

	it.effect('a restart starts from now: a slot before it never fires', () =>
		Effect.scoped(
			Effect.gen(function* () {
				yield* TestClock.setTime(Date.parse('2026-09-25T22:00:30Z'));
				const fired = yield* Queue.unbounded<string>();
				yield* clock([{ id: 'hourly', cron: '0 * * * *', zone: 'UTC' }], (_, slot) =>
					Queue.offer(fired, slot).pipe(Effect.asVoid)
				);
				yield* TestClock.adjust('1 hour');
				expect(yield* takes(fired, 1)).toEqual(['2026-09-25T23:00:00.000Z']);
				expect(yield* Queue.size(fired)).toBe(0);
			})
		)
	);

	it.effect('runs one slot per id at a time and keeps only the latest that waited', () =>
		Effect.scoped(
			Effect.gen(function* () {
				yield* TestClock.setTime(Date.parse('2026-09-25T22:00:30Z'));
				const release = yield* Deferred.make<void>(),
					fired = yield* Queue.unbounded<string>();
				let first = true;
				yield* clock([{ id: 'every', cron: '* * * * *', zone: 'UTC' }], (_, slot) =>
					Effect.gen(function* () {
						yield* Queue.offer(fired, slot);
						if (first) {
							first = false;
							yield* Deferred.await(release);
						}
					})
				);
				yield* TestClock.adjust('3 minutes');
				expect(yield* Queue.take(fired)).toBe('2026-09-25T22:01:00.000Z');
				expect(yield* Queue.size(fired)).toBe(0);
				yield* Deferred.succeed(release, undefined);
				expect(yield* Queue.take(fired)).toBe('2026-09-25T22:03:00.000Z');
				yield* TestClock.adjust('1 minute');
				expect(yield* Queue.take(fired)).toBe('2026-09-25T22:04:00.000Z');
				expect(yield* Queue.size(fired)).toBe(0);
			})
		)
	);
});
