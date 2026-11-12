// bolt-server's self-host adapters: FIFO admission.
import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { envelope } from '../src/envelope.ts';

class WorkFailed extends Schema.TaggedError<WorkFailed>()('WorkFailed', {
	message: Schema.String
}) {}

describe('the envelope', () => {
	it.effect('admits FIFO under the limit, request-path work ahead of automations', () =>
		Effect.gen(function* () {
			const admit = yield* envelope(1),
				release = yield* Deferred.make<void>(),
				entered = yield* Deferred.make<void>();
			const order: string[] = [];
			const first = yield* admit
				.admit(
					0,
					Effect.sync(() => {
						order.push('a');
					}).pipe(
						Effect.andThen(Deferred.succeed(entered, undefined)),
						Effect.andThen(Deferred.await(release))
					)
				)
				.pipe(Effect.forkChild);
			yield* Deferred.await(entered);
			const automation = yield* admit
				.admit(
					1,
					Effect.sync(() => {
						order.push('automation');
					})
				)
				.pipe(Effect.forkChild);
			const request = yield* admit
				.admit(
					0,
					Effect.sync(() => {
						order.push('request');
					})
				)
				.pipe(Effect.forkChild);
			yield* Effect.yieldNow;
			expect(order).toEqual(['a']);
			yield* Deferred.succeed(release, undefined);
			yield* Effect.all([Fiber.join(first), Fiber.join(automation), Fiber.join(request)]);
			expect(order).toEqual(['a', 'request', 'automation']);
		})
	);
	it.effect(
		'releases failed work with its original error and retains FIFO within both priority lanes',
		() =>
			Effect.gen(function* () {
				const admit = yield* envelope(1),
					first = yield* Deferred.make<void, WorkFailed>();
				const error = new WorkFailed({ message: 'native failure' }),
					order: string[] = [];
				const failed = yield* Effect.flip(admit.admit(0, Deferred.await(first))).pipe(
					Effect.forkChild
				);
				const tasks = yield* Effect.forEach(
					[
						{ lane: 1, name: 'automation 1' },
						{ lane: 0, name: 'request 1' },
						{ lane: 1, name: 'automation 2' },
						{ lane: 0, name: 'request 2' }
					] satisfies readonly { lane: 0 | 1; name: string }[],
					({ lane, name }) =>
						admit
							.admit(
								lane,
								Effect.sync(() => {
									order.push(name);
								})
							)
							.pipe(Effect.forkChild)
				);
				yield* Effect.yieldNow;
				yield* Deferred.fail(first, error);
				expect(yield* Fiber.join(failed)).toBe(error);
				yield* Effect.forEach(tasks, Fiber.join);
				expect(order).toEqual(['request 1', 'request 2', 'automation 1', 'automation 2']);
				expect(yield* admit.drain(100)).toBe(true);
			})
	);
	it.effect('sheds both lanes while draining all admitted slots', () =>
		Effect.gen(function* () {
			const admit = yield* envelope(2),
				a = yield* Deferred.make<void>(),
				b = yield* Deferred.make<void>();
			const active = yield* Effect.all([
				admit.admit(0, Deferred.await(a)).pipe(Effect.forkChild),
				admit.admit(1, Deferred.await(b)).pipe(Effect.forkChild)
			]);
			const request = yield* Effect.flip(admit.admit(0, Effect.succeed('queued'))).pipe(
				Effect.forkChild
			);
			const automation = yield* Effect.flip(admit.admit(1, Effect.succeed('queued'))).pipe(
				Effect.forkChild
			);
			yield* Effect.yieldNow;
			const drained = yield* admit.drain(1000).pipe(Effect.forkChild);
			expect(yield* Fiber.join(request)).toMatchObject({ code: 'busy' });
			expect(yield* Fiber.join(automation)).toMatchObject({ code: 'busy' });
			yield* Deferred.succeed(a, undefined);
			yield* Deferred.succeed(b, undefined);
			yield* Effect.forEach(active, Fiber.join);
			expect(yield* Fiber.join(drained)).toBe(true);
			expect(yield* admit.drain(1000)).toBe(true);
		})
	);
	it.effect('retains fractional and unbounded capacity while work is admitted', () =>
		Effect.gen(function* () {
			for (const max of [2.5, Infinity]) {
				const admit = yield* envelope(max),
					entered = yield* Deferred.make<void>(),
					release = yield* Deferred.make<void>();
				let running = 0;
				const tasks = yield* Effect.forEach([0, 1, 2], () =>
					admit
						.admit(
							0,
							Effect.gen(function* () {
								if (++running === 3) yield* Deferred.succeed(entered, undefined);
								yield* Deferred.await(release);
							})
						)
						.pipe(Effect.forkChild)
				);
				yield* Deferred.await(entered);
				expect(yield* admit.drain(0)).toBe(false);
				yield* Deferred.succeed(release, undefined);
				yield* Effect.forEach(tasks, Fiber.join);
				expect(yield* admit.drain(100)).toBe(true);
			}
		})
	);
	it.effect(
		'drains within its grace: admission closes, waiters are shed, a never-settling call cannot hold it',
		() =>
			Effect.gen(function* () {
				const admit = yield* envelope(1);
				const active = yield* admit.admit(1, Effect.never).pipe(Effect.forkChild);
				const shed = yield* Effect.flip(admit.admit(0, Effect.succeed('late'))).pipe(
					Effect.forkChild
				);
				yield* Effect.yieldNow;
				const drained = yield* admit.drain(50).pipe(Effect.forkChild);
				yield* TestClock.adjust('50 millis');
				expect(yield* Fiber.join(drained)).toBe(false);
				expect(yield* Fiber.join(shed)).toMatchObject({ code: 'busy' });
				expect(yield* Effect.flip(admit.admit(0, Effect.succeed('new')))).toMatchObject({
					code: 'busy'
				});
				yield* Fiber.interrupt(active);
				expect(yield* (yield* envelope(1)).drain(10_000)).toBe(true);
			})
	);
});
