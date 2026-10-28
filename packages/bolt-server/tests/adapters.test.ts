// bolt-server's self-host adapters: deadlines and FIFO admission.
import { describe, expect, it, vi } from '@effect/vitest';
import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { DeadlinePort, inProcessDeadlines } from '@norbital-ai/bolt/engine';
import { envelope } from '../src/envelope.ts';

class WorkFailed extends Schema.TaggedError<WorkFailed>()('WorkFailed', {
	message: Schema.String
}) {}

describe('the in-process timekeeper and the envelope (rules 52a, 71)', () => {
	it.effect('wakes a scope once at its earliest announcement and takes the settled answer', () =>
		Effect.gen(function* () {
			const woke: string[] = [];
			let dk: DeadlinePort['Service'] | undefined;
			const context = yield* Layer.build(
				inProcessDeadlines((scope) =>
					Effect.gen(function* () {
						woke.push(scope);
						if (woke.length === 1) {
							if (dk === undefined) throw new Error('deadline layer has not opened');
							yield* dk.settle(scope, new Date(30).toISOString());
						}
					})
				)
			);
			dk = Context.get(context, DeadlinePort);
			yield* dk.announce('ws', new Date(40).toISOString());
			yield* dk.announce('ws', new Date(10).toISOString());
			yield* dk.announce('ws', new Date(60).toISOString());
			yield* TestClock.adjust('9 millis');
			expect(woke).toEqual([]);
			yield* TestClock.adjust('1 millis');
			expect(woke).toEqual(['ws']);
			yield* TestClock.adjust('20 millis');
			expect(woke).toEqual(['ws', 'ws']);
			yield* TestClock.adjust('1 second');
			expect(woke).toEqual(['ws', 'ws']);
		})
	);
	it.effect(
		'stays silent about a wake that a stop interrupted, and never wakes again (rule 71a)',
		() =>
			Effect.gen(function* () {
				const errors = vi.spyOn(console, 'error');
				yield* Effect.addFinalizer(() => Effect.sync(() => errors.mockRestore()));
				let calls = 0,
					released = false;
				const scope = yield* Scope.make();
				yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
				const context = yield* Layer.build(
					inProcessDeadlines(() =>
						Effect.sync(() => {
							calls++;
						}).pipe(
							Effect.andThen(Effect.never),
							Effect.ensuring(
								Effect.sync(() => {
									released = true;
								})
							)
						)
					)
				).pipe(Scope.provide(scope));
				const dk = Context.get(context, DeadlinePort);
				yield* dk.announce('ws', new Date(1).toISOString());
				yield* TestClock.adjust('1 millis');
				expect(calls).toBe(1);
				yield* Scope.close(scope, Exit.void);
				yield* TestClock.adjust('1 second');
				expect([calls, released]).toEqual([1, true]);
				expect(errors).not.toHaveBeenCalled();
			})
	);
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
		'drains within its grace: admission closes, waiters are shed, a never-settling call cannot hold it (rule 71a)',
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

it.effect('a slow deadline cannot starve another scope or overlap itself', () =>
	Effect.gen(function* () {
		const woke: string[] = [],
			held = yield* Deferred.make<void>(),
			scope = yield* Scope.make();
		yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
		const context = yield* Layer.build(
			inProcessDeadlines((name) =>
				Effect.sync(() => {
					woke.push(name);
				}).pipe(Effect.andThen(name === 'slow' ? Deferred.await(held) : Effect.void))
			)
		).pipe(Scope.provide(scope));
		const dk = Context.get(context, DeadlinePort);
		yield* dk.announce('slow', new Date(1).toISOString());
		yield* dk.announce('fast', new Date(1).toISOString());
		yield* TestClock.adjust('1 millis');
		expect(woke).toEqual(['slow', 'fast']);
		yield* dk.announce('slow', new Date(1).toISOString());
		yield* TestClock.adjust('1 millis');
		expect(woke).toEqual(['slow', 'fast']);
		yield* Scope.close(scope, Exit.void);
		yield* Deferred.succeed(held, undefined);
		yield* TestClock.adjust('1 millis');
		expect(woke).toEqual(['slow', 'fast']);
	})
);
