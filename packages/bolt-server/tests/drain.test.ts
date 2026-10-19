import { createHook } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { setImmediate as turn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { within } from '../src/drain.ts';

class CleanupFailed extends Schema.TaggedError<CleanupFailed>()('CleanupFailed', {
	message: Schema.String
}) {}

it.effect('returns settled work and preserves a rejected cleanup as a typed failure', () =>
	Effect.gen(function* () {
		expect(yield* within(10_000, Effect.succeed(42))).toEqual(Option.some(42));
		const error = new CleanupFailed({ message: 'cleanup failed' });
		expect(yield* Effect.flip(within(10_000, Effect.fail(error)))).toBe(error);
	})
);

it.effect('ends at the deadline and interrupts pending work before returning', () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>();
		let released = false;
		const pending = yield* within(
			1,
			Deferred.succeed(started, undefined).pipe(
				Effect.andThen(Effect.never),
				Effect.ensuring(
					Effect.sync(() => {
						released = true;
					})
				)
			)
		).pipe(Effect.forkChild);
		yield* Deferred.await(started);
		yield* TestClock.adjust('1 millis');
		expect(yield* Fiber.join(pending)).toEqual(Option.none());
		expect(released).toBe(true);
	})
);

it.live('cancels losing native timeout handles after early completion', () =>
	Effect.gen(function* () {
		const timers = new Set<number>();
		const hook = yield* Effect.acquireRelease(
			Effect.sync(() =>
				createHook({
					init(id, type) {
						if (type === 'Timeout') timers.add(id);
					},
					destroy(id) {
						timers.delete(id);
					}
				}).enable()
			),
			(hook) =>
				Effect.sync(() => {
					hook.disable();
				})
		);
		yield* within(10_000, Effect.succeed(42));
		yield* Effect.promise(() => turn());
		hook.disable();
		expect(timers.size).toBe(0);
	})
);

it('does not retain a child process after its shutdown scope is interrupted', () => {
	const module = new URL('../src/drain.ts', import.meta.url).href;
	const child = spawnSync(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`import { Effect, Fiber } from 'effect'; import { within } from ${JSON.stringify(module)}; await Effect.runPromise(Effect.scoped(Effect.gen(function* () { console.log('started'); const work = yield* within(10000, Effect.never).pipe(Effect.forkScoped); yield* Fiber.interrupt(work); })));`
		],
		{ cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 3000 }
	);
	expect(child.error).toBeUndefined();
	expect(child.status).toBe(0);
	expect(child.stdout.trim()).toBe('started');
});
