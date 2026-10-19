import { expect, it } from '@effect/vitest';
import { Deferred, Effect } from 'effect';
import { jobs } from '../src/engine/agent/tools.ts';

it.effect('closing a turn scope interrupts every admitted job', () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>(),
			released = yield* Deferred.make<void>();
		yield* Effect.scoped(
			Effect.gen(function* () {
				const turnJobs = yield* jobs();
				yield* turnJobs.add(
					'in-flight model tool',
					Effect.scoped(
						Effect.gen(function* () {
							yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
							yield* Deferred.succeed(started, undefined);
							return yield* Effect.never;
						})
					)
				);
				yield* Deferred.await(started);
			})
		);
		expect(yield* Deferred.isDone(released)).toBe(true);
	})
);
