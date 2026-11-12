import { Effect, Layer, ManagedRuntime, Schema } from 'effect';
import { expect, it } from '@effect/vitest';
import { fork, mount_edge, running_fibers } from '@norbital-ai/ui/effect';
class DisposeFailed extends Schema.TaggedError<DisposeFailed>()('DisposeFailed', {}) {}

it.live('fifty mount/unmount cycles leave no running UI fibers', () =>
	Effect.gen(function* () {
		for (let cycle = 0; cycle < 50; cycle++) {
			const dispose = mount_edge(ManagedRuntime.make(Layer.empty));
			fork(Effect.never);
			expect(running_fibers()).toBe(1);
			yield* Effect.tryPromise({ try: dispose, catch: () => new DisposeFailed() });
			expect(running_fibers()).toBe(0);
		}
	})
);
