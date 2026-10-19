import { Clock, Duration, Effect, Exit, Option, Queue, Scheduler, Schema } from 'effect';
import { TestClock } from 'effect/testing';

class ClockProbeExpired extends Schema.TaggedError<ClockProbeExpired>()('ClockProbeExpired', {
	deadline: Schema.Number,
	next: Schema.Number
}) {}

/** Advance actual registered native sleeps until the operation settles, within the scenario's existing budget. */
export const clockProbe = <A, E, R>(operation: Effect.Effect<A, E, R>, millis: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const clock = yield* Clock.Clock,
				deadline = (yield* clock.currentTimeMillis) + millis;
			const scheduler = yield* Scheduler.Scheduler;
			const dispatcher = scheduler.makeDispatcher();
			const observedScheduler: Scheduler.Scheduler = {
				executionMode: scheduler.executionMode,
				shouldYield: (fiber) => scheduler.shouldYield(fiber),
				makeDispatcher: () => dispatcher
			};
			type Observation =
				{ readonly _tag: 'Changed' } | { readonly _tag: 'Settled'; readonly exit: Exit.Exit<A, E> };
			const observations = yield* Effect.acquireRelease(Queue.unbounded<Observation>(), (queue) =>
				Queue.shutdown(queue)
			);
			const pending = new Map<number, number>();
			let sequence = 0;
			const observed: Clock.Clock = {
				...clock,
				sleep: (duration) =>
					Effect.gen(function* () {
						const id = sequence++,
							at = (yield* clock.currentTimeMillis) + Duration.toMillis(duration);
						pending.set(id, at);
						yield* Queue.offer(observations, { _tag: 'Changed' });
						yield* clock.sleep(duration).pipe(
							Effect.ensuring(
								Effect.sync(() => {
									pending.delete(id);
								}).pipe(Effect.andThen(Queue.offer(observations, { _tag: 'Changed' })))
							)
						);
					})
			};
			yield* operation.pipe(
				Effect.provideService(Clock.Clock, observed),
				Effect.provideService(Scheduler.Scheduler, observedScheduler),
				Effect.exit,
				Effect.flatMap((exit) => Queue.offer(observations, { _tag: 'Settled', exit })),
				Effect.forkChild({ startImmediately: true })
			);
			for (;;) {
				let observation = yield* Queue.take(observations);
				// A completed sleep can wake this observer before the stream handles its token.
				// Drain runnable native fibers before choosing another timer to advance.
				yield* Effect.sync(() => dispatcher.flush());
				for (;;) {
					if (observation._tag === 'Settled')
						return yield* Exit.match(observation.exit, {
							onSuccess: Effect.succeed,
							onFailure: Effect.failCause
						});
					const next = yield* Queue.poll(observations);
					if (Option.isNone(next)) break;
					observation = next.value;
				}
				const next = Math.min(...pending.values());
				if (!Number.isFinite(next)) continue;
				if (next > deadline) return yield* Effect.fail(new ClockProbeExpired({ deadline, next }));
				yield* TestClock.setTime(next);
			}
		})
	);
