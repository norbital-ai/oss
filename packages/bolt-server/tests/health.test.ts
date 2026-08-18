import { assert, it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { AdmissionStopped, ServerHealth, layer } from '../src/health.js';

it.layer(layer)('ServerHealth', (it) => {
	it.effect('stops admission and drains admitted work', () =>
		Effect.gen(function* () {
			const health = yield* ServerHealth;
			const entered = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			const running = yield* health
				.admit(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
				.pipe(Effect.forkChild);

			yield* Deferred.await(entered);
			assert.deepStrictEqual(yield* health.snapshot(), {
				ready: false,
				accepting: true,
				inFlight: 1,
				finalized: false
			});

			const draining = yield* health.drain(1_000).pipe(Effect.forkChild);
			yield* Effect.yieldNow;
			const stopped = yield* Effect.flip(health.admit(Effect.void));
			assert.instanceOf(stopped, AdmissionStopped);

			yield* Deferred.succeed(release, undefined);
			yield* Fiber.join(running);
			const drained = yield* Fiber.join(draining);
			assert.strictEqual(drained.accepting, false);
			assert.strictEqual(drained.inFlight, 0);
		})
	);

	it.effect('reports readiness and finalization', () =>
		Effect.gen(function* () {
			const health = yield* ServerHealth;
			yield* health.markReady();
			assert.strictEqual((yield* health.snapshot()).ready, true);
			yield* health.markFinalized();
			assert.deepStrictEqual(yield* health.snapshot(), {
				ready: false,
				accepting: false,
				inFlight: 0,
				finalized: true
			});
		})
	);
});
