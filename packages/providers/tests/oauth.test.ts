import { expect, it } from '@effect/vitest';
import { Clock, Effect, Exit, Fiber, Scope } from 'effect';
import { callbackCompletion } from '../src/oauth.ts';

it.effect(
	'publishes a shared completion even when its first waiter is interrupted as it starts',
	() =>
		Effect.gen(function* () {
			const completion = yield* callbackCompletion,
				scope = yield* Scope.Scope;
			let pending: { state: string; at: number } | null = {
				state: 'one-attempt',
				at: yield* Clock.currentTimeMillis
			};
			let first: Fiber.Fiber<unknown, unknown> | undefined;
			let runs = 0;
			const callback = () =>
				completion.run(
					'one-attempt',
					() => pending,
					() => new Response('expired', { status: 400 }),
					() =>
						Effect.gen(function* () {
							pending = null;
							runs++;
							if (first !== undefined)
								yield* Effect.forkIn(Fiber.interrupt(first), scope, { startImmediately: true });
							return new Response('completed');
						})
				);
			const abandoned = yield* Effect.forkChild(
				Effect.withFiber((fiber) => {
					first = fiber;
					return callback();
				})
			);
			expect(Exit.isFailure(yield* Fiber.await(abandoned))).toBe(true);
			const response = yield* callback();
			expect(response.status).toBe(200);
			expect(yield* Effect.promise(() => response.text())).toBe('completed');
			expect(runs).toBe(1);
		})
);
