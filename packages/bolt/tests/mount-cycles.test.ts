import { Effect, Layer, ManagedRuntime, Schema } from 'effect';
import { expect, it } from '@effect/vitest';
import { fork, mountEdge, runningFibers } from '@norbital-ai/ui/effect';
class DisposeFailed extends Schema.TaggedError<DisposeFailed>()('DisposeFailed', {}) {}

it.live('fifty mount/unmount cycles leave no running UI fibers', () =>
	Effect.gen(function* () {
		for (let cycle = 0; cycle < 50; cycle++) {
			const dispose = mountEdge(ManagedRuntime.make(Layer.empty));
			fork(Effect.never);
			expect(runningFibers()).toBe(1);
			yield* Effect.tryPromise({ try: dispose, catch: () => new DisposeFailed() });
			expect(runningFibers()).toBe(0);
		}
	})
);
