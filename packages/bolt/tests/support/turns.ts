// Waiting on host work that has no event of its own: turn the event loop, read no clock.
import { Effect, Fiber } from 'effect';

/** One turn of the event loop: I/O and timers due now run first. */
export const turn = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
/** Turns the event loop until `done` holds; a mechanism that never gets there fails the test by its own timeout. */
export const until = <E, R>(done: Effect.Effect<boolean, E, R>) =>
	Effect.gen(function* () {
		while (!(yield* done)) yield* turn;
	});
/** Runs `effect` while the kit clock steps `by` each event-loop turn: the engine's own waits on kit time (a stream wall, a poll) pass. */
export const stepping =
	(clock: { advance(value: string): void }, by: string) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) =>
		Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(effect);
			while (fiber.pollUnsafe() === undefined) {
				clock.advance(by);
				yield* turn;
			}
			return yield* Fiber.join(fiber);
		});
