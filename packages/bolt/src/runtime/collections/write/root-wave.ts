/**
 * One preparation wave, run once per graph.
 *
 * Sibling roots of one declarative write share a single `before` hook wave. The seed that owns the
 * wave runs it and publishes the outcome through the gate; every other root awaits the gate. A
 * failure is published before it is raised, so no sibling waits on a wave that will never settle.
 */
import { Deferred, Effect, Result } from 'effect';

export const settleRootWave = <A, E, R>(
	gate: Deferred.Deferred<A, E>,
	owner: boolean,
	wave: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
	owner
		? Effect.gen(function* () {
				const attempted = yield* Effect.result(wave);
				if (Result.isFailure(attempted)) {
					yield* Deferred.fail(gate, attempted.failure);
					return yield* Effect.fail(attempted.failure);
				}
				yield* Deferred.succeed(gate, attempted.success);
				return attempted.success;
			})
		: Deferred.await(gate);
