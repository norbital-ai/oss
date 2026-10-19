import { expect, it } from '@effect/vitest';
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Semaphore } from 'effect';
import { TestClock } from 'effect/testing';
import { LIMITS, type CrossAnswer, type Invocation } from '../src/engine/contracts.ts';
import { makeRequestCpu, withRequestCpu } from '../src/engine/guest/request-cpu.ts';
import { Guest, GuestLimits, Isolates, type Bridge } from '../src/engine/services.ts';
import { BoltError } from '../src/protocol/errors.ts';
import { guestLayer } from './support/guest-fixture.ts';

it.effect('shares one debit across native sources and refuses later work once exhausted', () =>
	Effect.gen(function* () {
		const request = yield* makeRequestCpu(100);
		let first = 0,
			second = 0,
			started = false;
		const source = (cpu: () => number) => ({ cpu, budget: 2_000, drop: () => {} });
		yield* request.run(
			Effect.sync(() => {
				first += 60;
			}),
			source(() => first),
			Effect.void
		);
		const over = yield* Effect.exit(
			request.run(
				Effect.sync(() => {
					second += 60;
				}),
				source(() => second),
				Effect.void
			)
		);
		expect(Exit.isFailure(over)).toBe(true);
		if (Exit.isFailure(over))
			expect(Cause.findErrorOption(over.cause)).toMatchObject({
				_tag: 'Some',
				value: { code: 'cpuBudget', message: 'the request used its 100 ms of guest CPU' }
			});
		const refused = yield* Effect.exit(
			request.run(
				Effect.sync(() => {
					started = true;
				}),
				source(() => 0),
				Effect.void
			)
		);
		expect(Exit.isFailure(refused)).toBe(true);
		expect(started).toBe(false);
	})
);

it.effect('reports the invocation cap after fractional CPU use across slices', () =>
	Effect.gen(function* () {
		const request = yield* makeRequestCpu();
		let used = 13.25;
		const source = { cpu: () => used, budget: 100, drop: () => {} };
		yield* request.run(
			Effect.sync(() => {
				used = 99.75;
			}),
			source,
			Effect.void
		);
		const over = yield* Effect.exit(
			request.run(
				Effect.sync(() => {
					used = 100;
				}),
				source,
				Effect.void
			)
		);
		expect(Exit.isFailure(over)).toBe(true);
		if (Exit.isFailure(over))
			expect(Cause.findErrorOption(over.cause)).toMatchObject({
				_tag: 'Some',
				value: { code: 'cpuBudget', message: 'the invocation used its 100 ms of guest CPU' }
			});
	})
);

it.effect('the watchdog disposes the source and reports its full invocation cap', () =>
	Effect.gen(function* () {
		const request = yield* makeRequestCpu();
		const entered = yield* Deferred.make<void>();
		let used = 13.25,
			dropped = false;
		const running = yield* Effect.forkChild(
			request
				.run(
					Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
					{
						cpu: () => used,
						budget: 100,
						drop: () => {
							dropped = true;
						}
					},
					Effect.void
				)
				.pipe(Effect.exit)
		);
		yield* Deferred.await(entered);
		used = 100;
		yield* TestClock.adjust(100);
		const over = yield* Fiber.join(running);
		expect(dropped).toBe(true);
		expect(Exit.isFailure(over)).toBe(true);
		if (Exit.isFailure(over))
			expect(Cause.findErrorOption(over.cause)).toMatchObject({
				_tag: 'Some',
				value: { code: 'cpuBudget', message: 'the invocation used its 100 ms of guest CPU' }
			});
	})
);

it.effect(
	'serializes native slices so concurrent invocations cannot spend the same remainder',
	() =>
		Effect.gen(function* () {
			const request = yield* makeRequestCpu(100);
			const entered = yield* Deferred.make<void>(),
				allow = yield* Deferred.make<void>();
			let first = 0,
				second = 0,
				secondStarted = false;
			const running = yield* Effect.forkChild(
				request.run(
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(allow)),
						Effect.andThen(
							Effect.sync(() => {
								first = 60;
							})
						)
					),
					{ cpu: () => first, budget: 2_000, drop: () => {} },
					Effect.void
				)
			);
			yield* Deferred.await(entered);
			const waiting = yield* Effect.forkChild(
				request
					.run(
						Effect.sync(() => {
							secondStarted = true;
							second = 60;
						}),
						{ cpu: () => second, budget: 2_000, drop: () => {} },
						Effect.void
					)
					.pipe(Effect.exit)
			);
			yield* Effect.yieldNow;
			expect(secondStarted).toBe(false);
			yield* Deferred.succeed(allow, undefined);
			yield* Fiber.join(running);
			expect(Exit.isFailure(yield* Fiber.join(waiting))).toBe(true);
		})
);

it.effect('does not debit a refused host compute grant', () =>
	Effect.gen(function* () {
		const request = yield* makeRequestCpu(100);
		let used = 0,
			started = false;
		const source = { cpu: () => used, budget: 2_000, drop: () => {} };
		const refused = yield* Effect.exit(
			request.run(
				Effect.sync(() => {
					started = true;
					used = 100;
				}),
				source,
				Effect.fail(BoltError.make('upstream', 'admission', 'no host capacity'))
			)
		);
		expect(Exit.isFailure(refused)).toBe(true);
		expect(started).toBe(false);
		yield* request.run(
			Effect.sync(() => {
				used = 90;
			}),
			source,
			Effect.void
		);
		expect(used).toBe(90);
	})
);

it.effect('keeps the CPU lease until interrupted native cleanup has actually settled', () =>
	Effect.gen(function* () {
		const request = yield* makeRequestCpu();
		const entered = yield* Deferred.make<void>(),
			cleanup = yield* Deferred.make<void>(),
			settled = yield* Deferred.make<void>();
		let leased = 0;
		const compute = Effect.acquireRelease(
			Effect.sync(() => {
				leased++;
			}),
			() =>
				Effect.sync(() => {
					leased--;
				})
		);
		const running = yield* Effect.forkChild(
			request.run(
				Deferred.succeed(entered, undefined).pipe(
					Effect.andThen(Effect.never),
					Effect.ensuring(
						Deferred.succeed(cleanup, undefined).pipe(Effect.andThen(Deferred.await(settled)))
					)
				),
				{ cpu: () => 0, budget: 2_000, drop: () => {} },
				compute
			)
		);
		yield* Deferred.await(entered);
		const interrupting = yield* Effect.forkChild(Fiber.interrupt(running));
		yield* Deferred.await(cleanup);
		expect(leased).toBe(1);
		yield* Deferred.succeed(settled, undefined);
		yield* Fiber.join(interrupting);
		expect(leased).toBe(0);
	})
);

const invocation = (target: string): Invocation => ({
	id: target,
	kind: 'automation',
	target,
	input: null,
	ctx: {
		actor: { kind: 'system', run: 'run', by: { platform: 'test' } },
		now: '2026-01-01T00:00:00.000Z',
		today: '2026-01-01',
		tz: 'UTC',
		seed: target
	},
	budget: {
		cpuMs: LIMITS.guestCpuMs,
		crossings: LIMITS.crossings.sync,
		readBytes: LIMITS.readBytes
	}
});

it.live(
	'releases native CPU during host I/O and admits a nested guest through a single CPU slot',
	() =>
		Effect.gen(function* () {
			const gate = yield* Semaphore.make(1);
			let active = 0,
				acquired = 0,
				released = 0;
			const compute = Effect.acquireRelease(
				gate.take(1).pipe(
					Effect.andThen(
						Effect.sync(() => {
							active++;
							acquired++;
						})
					)
				),
				() =>
					Effect.sync(() => {
						active--;
						released++;
					}).pipe(Effect.andThen(gate.release(1)))
			);
			const limits = yield* GuestLimits;
			const context = yield* Layer.build(
				guestLayer(
					{
						source: `export default { automation: {
				a: { body: async () => globalThis[Symbol.for('norbital.bolt.call')]('progress', [null], 'cpu') },
				b: { body: () => 'nested' }
			} };`
					},
					{ compute }
				).pipe(
					Layer.provide(
						Layer.succeed(GuestLimits, { ...limits, warm: { ...limits.warm, depth: 0 } })
					)
				)
			);
			const guest = Context.get(context, Guest);
			const bridge: Bridge = {
				cross: (): Effect.Effect<readonly CrossAnswer[]> =>
					Effect.gen(function* () {
						expect(active).toBe(0);
						const nested = yield* guest.invoke(invocation('b'), {
							cross: () => Effect.succeed([])
						});
						expect(nested).toMatchObject({ kind: 'ok', output: 'nested' });
						expect(active).toBe(0);
						return [{ ok: true, value: 'nested' }];
					})
			};
			const result = yield* guest.invoke(invocation('a'), bridge).pipe(withRequestCpu);
			expect(result).toMatchObject({ kind: 'ok', output: 'nested' });
			expect(acquired).toBeGreaterThan(1);
			expect(released).toBe(acquired);
			expect(active).toBe(0);
			expect((yield* Context.get(context, Isolates).counts).live).toBe(0);
		})
);

it.live(
	'exhausts caught native CPU failures for sibling invocations and refunds capacity after disposal',
	() =>
		Effect.gen(function* () {
			let active = 0;
			const compute = Effect.acquireRelease(
				Effect.sync(() => {
					active++;
				}),
				() =>
					Effect.sync(() => {
						active--;
					})
			);
			const limits = yield* GuestLimits;
			const context = yield* Layer.build(
				guestLayer(
					{
						source: `export default { automation: { a: { body: () => { while (true) {} } }, b: { body: () => 'fresh request' } } };`
					},
					{ compute }
				).pipe(
					Layer.provide(
						Layer.succeed(GuestLimits, { ...limits, warm: { ...limits.warm, depth: 0 } })
					)
				)
			);
			const guest = Context.get(context, Guest),
				bridge: Bridge = { cross: () => Effect.succeed([]) };
			yield* withRequestCpu(
				Effect.gen(function* () {
					const base = invocation('a');
					const over = yield* guest.invoke(
						{ ...base, budget: { ...base.budget, cpuMs: 50 } },
						bridge
					);
					expect(over).toMatchObject({ kind: 'failed', error: { code: 'cpuBudget' } });
					expect(active).toBe(0);
					expect((yield* Context.get(context, Isolates).counts).live).toBe(0);
					expect(yield* guest.invoke(invocation('b'), bridge)).toMatchObject({
						kind: 'failed',
						error: { code: 'cpuBudget' }
					});
				})
			);
			expect(yield* guest.invoke(invocation('b'), bridge)).toMatchObject({
				kind: 'ok',
				output: 'fresh request'
			});
			expect(active).toBe(0);
		})
);
