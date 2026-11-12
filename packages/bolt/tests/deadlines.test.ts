import { describe, expect, it } from '@effect/vitest';
import { Clock, Deferred, Duration, Effect, Exit, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { DeadlineTimer, type DeadlineCompletion, type DeadlineEntry } from '../src/engine/runs/deadlines.ts';

const idle: DeadlineCompletion = { callbackAtEpochMs: null, mergeAnnouncements: true };

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
			const timer = yield* DeadlineTimer.make<string>({
				wake: () => Effect.sync(() => { due++; return idle; }),
				pulse: () => Effect.succeed(false)
			}).pipe(Effect.provideService(Clock.Clock, owned));
			yield* timer.announce('a', 'a', 10);
			yield* TestClock.adjust(10);
			expect(sleeps).toEqual([10]);
			expect(due).toBe(1);
		})
	);
	it.effect('dispatches independent lanes and fences retired callbacks from newer announcements', () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(100);
			const a = yield* Deferred.make<DeadlineCompletion>();
			const b = yield* Deferred.make<DeadlineCompletion>();
			const wakes: DeadlineEntry<string>[] = [];
			const timer = yield* DeadlineTimer.make<string>({
				wake: (entry) => Effect.gen(function* () {
					wakes.push(entry);
					if (entry.subject === 'old-a') return yield* Deferred.await(a);
					if (entry.subject === 'old-b') return yield* Deferred.await(b);
					return idle;
				}),
				pulse: () => Effect.succeed(false)
			});
			yield* timer.announce('a', 'old-a', 110);
			yield* timer.announce('b', 'old-b', 115);
			yield* TestClock.adjust(15);
			expect(wakes).toEqual([
				{ key: 'a', subject: 'old-a', at: 110 },
				{ key: 'b', subject: 'old-b', at: 115 }
			]);
			expect(yield* timer.retire('a')).toBe(false);
			expect(yield* timer.retire('b')).toBe(false);
			yield* timer.announce('a', 'new-a', 130);
			yield* Deferred.succeed(a, { callbackAtEpochMs: 500, mergeAnnouncements: false });
			yield* Deferred.succeed(b, { callbackAtEpochMs: 101, mergeAnnouncements: true });
			yield* TestClock.adjust(15);
			expect(wakes).toEqual([
				{ key: 'a', subject: 'old-a', at: 110 },
				{ key: 'b', subject: 'old-b', at: 115 },
				{ key: 'a', subject: 'new-a', at: 130 }
			]);
			expect(yield* timer.armedFor).toBeUndefined();
		})
	);
	it.effect('settle replaces the pending instant and null cancels it', () =>
		Effect.gen(function* () {
			const wakes: string[] = [];
			const timer = yield* DeadlineTimer.make<string>({
				wake: (entry) => Effect.sync(() => { wakes.push(entry.key); return idle; }),
				pulse: () => Effect.succeed(false)
			});
			expect(yield* timer.announce('a', 'a', 10)).toBe(true);
			expect(yield* timer.announce('a', 'a', 20)).toBe(false);
			yield* timer.settle('a', 'a', 30);
			expect(yield* timer.armedFor).toBe(30);
			yield* TestClock.adjust(20);
			expect(wakes).toEqual([]);
			yield* timer.settle('a', 'a', null);
			yield* TestClock.adjust(20);
			expect(wakes).toEqual([]);
			expect(yield* timer.armedFor).toBeUndefined();
		})
	);
	it.effect('pulses an active wake without admitting another, then uses its returned deadline', () =>
		Effect.gen(function* () {
			const finish = yield* Deferred.make<DeadlineCompletion>();
			const wakes: DeadlineEntry<string>[] = [];
			const pulses: DeadlineEntry<string>[] = [];
			const timer = yield* DeadlineTimer.make<string>({
				wake: (entry) => Effect.gen(function* () {
					wakes.push(entry);
					return wakes.length === 1 ? yield* Deferred.await(finish) : idle;
				}),
				pulse: (entry) => Effect.sync(() => { pulses.push(entry); return true; })
			});
			yield* timer.announce('a', 'owner', 10);
			yield* TestClock.adjust(10);
			yield* timer.announce('a', 'later', 20);
			yield* TestClock.adjust(10);
			expect(wakes).toEqual([{ key: 'a', subject: 'owner', at: 10 }]);
			expect(pulses).toEqual([{ key: 'a', subject: 'owner', at: 20 }]);
			yield* Deferred.succeed(finish, { callbackAtEpochMs: 100, mergeAnnouncements: true });
			yield* TestClock.adjust(79);
			expect(wakes).toHaveLength(1);
			yield* TestClock.adjust(1);
			expect(wakes).toEqual([
				{ key: 'a', subject: 'owner', at: 10 },
				{ key: 'a', subject: 'owner', at: 100 }
			]);
			expect(pulses).toHaveLength(1);
			expect(yield* timer.armedFor).toBeUndefined();
		})
	);
	it.effect('a refused pulse defers without spinning until its wake closes', () =>
		Effect.gen(function* () {
			const finish = yield* Deferred.make<DeadlineCompletion>();
			const wakes: DeadlineEntry<string>[] = [];
			let pulses = 0;
			const timer = yield* DeadlineTimer.make<string>({
				wake: (entry) => Effect.gen(function* () {
					wakes.push(entry);
					return wakes.length === 1 ? yield* Deferred.await(finish) : idle;
				}),
				pulse: () => Effect.sync(() => { pulses++; return false; })
			});
			yield* timer.announce('a', 'a', 10);
			yield* TestClock.adjust(10);
			yield* timer.announce('a', 'a', 20);
			yield* TestClock.adjust(10);
			expect(pulses).toBe(1);
			expect(yield* timer.armedFor).toBeUndefined();
			yield* TestClock.adjust(100);
			expect(wakes).toHaveLength(1);
			expect(pulses).toBe(1);
			yield* Deferred.succeed(finish, idle);
			yield* TestClock.adjust(0);
			expect(wakes).toEqual([
				{ key: 'a', subject: 'a', at: 10 },
				{ key: 'a', subject: 'a', at: 20 }
			]);
			expect(pulses).toBe(1);
			expect(yield* timer.armedFor).toBeUndefined();
		})
	);
	it.effect('retains a late refused pulse after its wake has already closed', () =>
		Effect.gen(function* () {
			const finish = yield* Deferred.make<DeadlineCompletion>();
			const accept = yield* Deferred.make<boolean>();
			const wakes: number[] = [];
			const timer = yield* DeadlineTimer.make<string>({
				wake: (entry) => Effect.gen(function* () {
					wakes.push(entry.at);
					return wakes.length === 1 ? yield* Deferred.await(finish) : idle;
				}),
				pulse: () => Deferred.await(accept)
			});
			yield* timer.announce('a', 'a', 10);
			yield* TestClock.adjust(10);
			yield* timer.announce('a', 'a', 20);
			yield* TestClock.adjust(10);
			yield* Deferred.succeed(finish, idle);
			yield* TestClock.adjust(0);
			expect(wakes).toEqual([10]);
			yield* Deferred.succeed(accept, false);
			yield* TestClock.adjust(0);
			expect(wakes).toEqual([10, 20]);
			expect(yield* timer.armedFor).toBeUndefined();
		})
	);
	it.effect('a failed callback backs off instead of spinning on an announcement made during the wake', () =>
		Effect.gen(function* () {
			const finish = yield* Deferred.make<void>();
			const wakes: number[] = [];
			let pulses = 0;
			const timer = yield* DeadlineTimer.make<string>({
				wake: () => Effect.gen(function* () {
					wakes.push(yield* Clock.currentTimeMillis);
					if (wakes.length === 1) {
						yield* Deferred.await(finish);
						return yield* Effect.die(new Error('deadline callback failed'));
					}
					return idle;
				}),
				pulse: () => Effect.sync(() => { pulses++; return true; })
			});
			yield* timer.announce('a', 'a', 10);
			yield* TestClock.adjust(10);
			yield* timer.announce('a', 'a', 20);
			yield* Deferred.succeed(finish, undefined);
			yield* TestClock.adjust(10);
			expect(wakes).toEqual([10]);
			expect(pulses).toBe(0);
			expect(yield* timer.armedFor).toBe(60_010);
			yield* TestClock.adjust(59_990);
			expect(wakes).toEqual([10, 60_010]);
			expect(yield* timer.armedFor).toBeUndefined();
		})
	);
	it.effect('clamps long timers and stops without a recurring wake', () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(0);
			const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
				Scope.close(scope, Exit.void)
			);
			let due = 0;
			const timer = yield* DeadlineTimer.make<string>({
				wake: () => Effect.sync(() => { due++; return idle; }),
				pulse: () => Effect.succeed(false)
			}).pipe(Effect.provideService(Scope.Scope, scope));
			yield* timer.announce('a', 'a', 2_147_483_647 + 10);
			yield* TestClock.adjust(2_147_483_647);
			expect(due).toBe(0);
			yield* TestClock.adjust(10);
			expect(due).toBe(1);
			yield* timer.announce('b', 'b', 2_147_483_647 + 20);
			yield* Scope.close(scope, Exit.void);
			expect(yield* timer.armedFor).toBeUndefined();
			expect(yield* timer.announce('closed', 'closed', 2_147_483_647 + 30)).toBe(false);
			yield* timer.settle('closed', 'closed', 2_147_483_647 + 40);
			yield* TestClock.adjust(2_147_483_647);
			expect(due).toBe(1);
		})
	);
});
