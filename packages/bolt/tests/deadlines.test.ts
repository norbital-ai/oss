import { describe, expect, it } from '@effect/vitest';
import { Clock, Duration, Effect, Exit, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { DeadlineTimer } from '../src/engine/runs/deadlines.ts';

describe('shared deadline state', () => {
	it.effect('retains its owning clock when a later caller arms the timer', () =>
		Effect.gen(function* () {
			const clock = yield* Clock.Clock;
			const sleeps: number[] = [];
			const owned: Clock.Clock = {
				currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
				currentTimeMillis: clock.currentTimeMillis,
				currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
				currentTimeNanos: clock.currentTimeNanos,
				monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
				monotonicTimeNanos: clock.monotonicTimeNanos,
				sleep: (duration) =>
					Effect.sync(() => sleeps.push(Duration.toMillis(duration))).pipe(
						Effect.andThen(clock.sleep(duration))
					)
			};
			let due = 0;
			const timer = yield* DeadlineTimer.make<string>(
				Effect.sync(() => {
					due++;
				})
			).pipe(Effect.provideService(Clock.Clock, owned));
			yield* timer.announce('a', 'a', 10);
			yield* TestClock.adjust(10);
			expect(sleeps).toEqual([10]);
			expect(due).toBe(1);
		})
	);
	it.effect('isolates callback lanes and fences retirement and failure announcements', () =>
		Effect.scoped(
			Effect.gen(function* () {
				yield* TestClock.setTime(100);
				const timer = yield* DeadlineTimer.make<string>(Effect.void);
				yield* timer.announce('a', 'a', 90);
				yield* timer.announce('b', 'b', 95);
				expect((yield* timer.takeDue)?.key).toBe('a');
				expect((yield* timer.takeDue)?.key).toBe('b');
				yield* timer.announce('a', 'a', 99);
				expect(yield* timer.takeDue).toBeUndefined();
				expect(
					yield* timer.complete('a', { callbackAtEpochMs: 200, mergeAnnouncements: false })
				).toMatchObject({ at: 200, stale: false });
				yield* timer.retire('b');
				expect(
					(yield* timer.complete('b', { callbackAtEpochMs: 101, mergeAnnouncements: true })).stale
				).toBe(true);
			})
		)
	);
	it.effect('clamps long timers and stops without a recurring wake', () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(0);
			const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
				Scope.close(scope, Exit.void)
			);
			let due = 0;
			const timer = yield* DeadlineTimer.make<string>(
				Effect.sync(() => {
					due++;
				})
			).pipe(Effect.provideService(Scope.Scope, scope));
			yield* timer.announce('a', 'a', 2_147_483_647 + 10);
			yield* TestClock.adjust(2_147_483_647);
			expect(due).toBe(0);
			yield* TestClock.adjust(10);
			expect(due).toBe(1);
			yield* Scope.close(scope, Exit.void);
			expect(yield* timer.armedFor).toBeUndefined();
			yield* TestClock.adjust(2_147_483_647);
			expect(due).toBe(1);
		})
	);
});
