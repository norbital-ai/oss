/// <reference types="node" />
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Exit, Fiber, Layer, Result, Schedule, Scope } from 'effect';
import type ivm from 'isolated-vm';
import { vi } from 'vitest';
import { LIMITS, type Invocation } from '../src/engine/contracts.ts';
import type { GuestProgram } from '../src/engine/guest/runner.ts';
import { GuestIsolates } from '../src/engine/ports.ts';
import { Guest, type Bridge } from '../src/engine/services.ts';
import { guestIsolates } from '../src/node/guest-isolates.ts';
import { guestLayer } from './support/guest-fixture.ts';

type Gate = {
	allowed: Promise<void>;
	entered: Promise<void>;
	disposed: Promise<void>;
	allow(): void;
	enter(): void;
	drop(): void;
};
const observed = vi.hoisted(() => ({
	produced: 0,
	consumed: new Set<ivm.ExternalCopy<unknown>>(),
	gate: undefined as Gate | undefined
}));

vi.mock('isolated-vm', async (importOriginal) => {
	const original = await importOriginal<{ default: typeof ivm }>();
	const native = original.default;
	const Isolate = new Proxy(native.Isolate, {
		construct(target, args: unknown[], newTarget) {
			const value: unknown = Reflect.construct(target, args, newTarget);
			if (!(value instanceof native.Isolate)) throw new Error('Expected the real native isolate');
			let held: Gate | undefined;
			return new Proxy(value, {
				get(isolate, property) {
					const member: unknown = Reflect.get(isolate, property, isolate);
					if (property === 'compileModule' && typeof member === 'function')
						return (...values: unknown[]) => {
							const options = values[1];
							if (typeof options === 'object' && options !== null) {
								if ('produceCachedData' in options && options.produceCachedData === true)
									observed.produced++;
								if ('cachedData' in options && options.cachedData instanceof native.ExternalCopy) {
									observed.consumed.add(options.cachedData);
									held = observed.gate;
								}
							}
							const result: unknown = Reflect.apply(member, isolate, values);
							if (held === undefined) return result;
							if (!(result instanceof Promise))
								throw new Error('Expected the native compilation promise');
							const gate = held;
							return result.then(async (module: unknown) => {
								gate.enter();
								await gate.allowed;
								return module;
							});
						};
					if (property === 'dispose' && typeof member === 'function')
						return () => {
							const result: unknown = Reflect.apply(member, isolate, []);
							held?.drop();
							return result;
						};
					return typeof member === 'function' ? member.bind(isolate) : member;
				}
			});
		}
	});
	const measured: typeof ivm = Object.create(native);
	Object.defineProperty(measured, 'Isolate', { value: Isolate, enumerable: true });
	return { ...original, default: measured };
});

const invocation = (id: string): Invocation => ({
	id,
	kind: 'automation',
	target: 'a',
	input: null,
	ctx: {
		actor: { kind: 'system', run: 'r1', by: { platform: 'test' } },
		now: '2026-01-01T00:00:00.000Z',
		today: '2026-01-01',
		tz: 'UTC',
		seed: id
	},
	budget: {
		crossings: LIMITS.crossings.sync,
		readBytes: LIMITS.readBytes
	}
});
const bridge: Bridge = {
	cross: (calls) => Effect.succeed(calls.map(() => ({ ok: true, value: null })))
};
const program = (value: string): GuestProgram => ({
	source: `let count = 0; export default { automation: { a: { body: () => [${JSON.stringify(value)}, ++count] } } };`
});
/** The Node host's isolates; its pool reads `warm` live. */
const harness = Effect.gen(function* () {
	const warm = { maxMiB: 512, depth: 2, idleMs: 60_000 };
	const port = yield* guestIsolates({ cpuMs: LIMITS.guestCpuMs, warm });
	const counts = Effect.sync(port.counts);
	return {
		warm,
		counts,
		runner: (source: GuestProgram) =>
			Layer.build(guestLayer(source, {}, undefined, GuestIsolates.fromAbi(port))).pipe(
				Effect.map((context) => Context.get(context, Guest))
			),
		settled: counts.pipe(
			Effect.repeat({
				schedule: Schedule.spaced('5 millis'),
				until: (counts) => counts.preparing === 0,
				times: 400
			}),
			Effect.tap((counts) => Effect.sync(() => expect(counts.preparing).toBe(0))),
			Effect.asVoid
		)
	};
});
const reset = () => {
	observed.produced = 0;
	observed.consumed.clear();
	observed.gate = undefined;
};
const gate = (): Gate => {
	let allow = () => {};
	let enter = () => {};
	let drop = () => {};
	const allowed = new Promise<void>((resolve) => {
		allow = resolve;
	});
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const disposed = new Promise<void>((resolve) => {
		drop = resolve;
	});
	return { allowed, entered, disposed, allow, enter, drop };
};

describe('host-produced module code cache', () => {
	it.live(
		'does not produce or consume caches when warm preparation or its memory cap is disabled',
		() =>
			Effect.gen(function* () {
				for (const disabled of [
					{ depth: 0, maxMiB: 512 },
					{ depth: 2, maxMiB: 0 }
				]) {
					reset();
					const test = yield* harness;
					Object.assign(test.warm, disabled);
					const runner = yield* test.runner(program('uncached'));
					for (let i = 0; i < 3; i++) {
						expect(yield* runner.invoke(invocation(String(i)), bridge)).toMatchObject({
							kind: 'ok',
							output: ['uncached', 1]
						});
						yield* test.settled;
					}
					expect(observed.produced).toBe(0);
					expect(observed.consumed.size).toBe(0);
					expect((yield* test.counts).warmBytes).toBe(0);
				}
			})
	);
	it.live('keeps same-length sources separate and gives every invocation a fresh module heap', () =>
		Effect.gen(function* () {
			reset();
			const test = yield* harness;
			const first = yield* test.runner(program('aaaa'));
			const second = yield* test.runner(program('bbbb'));
			for (const [runner, expected] of [
				[first, 'aaaa'],
				[second, 'bbbb'],
				[first, 'aaaa'],
				[second, 'bbbb']
			] as const) {
				expect(yield* runner.invoke(invocation(expected), bridge)).toMatchObject({
					kind: 'ok',
					output: [expected, 1]
				});
				yield* test.settled;
			}
			expect(observed.produced).toBe(2);
			expect(observed.consumed.size).toBe(2);
		})
	);
	it.live('never reads tenant-supplied native cache fields', () =>
		Effect.gen(function* () {
			reset();
			let read = false;
			const source = {
				...program('safe'),
				get cachedData() {
					read = true;
					throw new Error('Untrusted native payload');
				}
			};
			const test = yield* harness;
			const runner = yield* test.runner(source);
			expect(yield* runner.invoke(invocation('safe'), bridge)).toMatchObject({
				kind: 'ok',
				output: ['safe', 1]
			});
			yield* test.settled;
			expect(read).toBe(false);
		})
	);
	it.live(
		'counts retained native cache bytes within the original warm cap and releases them when the host closes',
		() =>
			Effect.gen(function* () {
				reset();
				const generation = yield* Effect.acquireRelease(Scope.make(), (scope) =>
					Scope.close(scope, Exit.void)
				);
				const test = yield* harness.pipe(Scope.provide(generation));
				test.warm.maxMiB = 16 / 1024;
				const runner = yield* test.runner(program('bounded')).pipe(Scope.provide(generation));
				for (let i = 0; i < 3; i++) {
					expect(yield* runner.invoke(invocation(String(i)), bridge)).toMatchObject({
						kind: 'ok',
						output: ['bounded', 1]
					});
					yield* test.settled;
				}
				let nativeBytes = 0;
				for (const handle of observed.consumed) {
					const bytes = yield* Effect.result(Effect.try(() => handle.copy()));
					if (Result.isSuccess(bytes)) {
						expect(bytes.success).toBeInstanceOf(ArrayBuffer);
						if (bytes.success instanceof ArrayBuffer) nativeBytes += bytes.success.byteLength;
					}
				}
				const counts = yield* test.counts;
				expect(observed.consumed.size).toBeGreaterThan(0);
				expect(nativeBytes).toBeGreaterThan(0);
				expect(counts.warmBytes).toBeGreaterThanOrEqual(nativeBytes);
				expect(counts.warmBytes).toBeLessThanOrEqual(test.warm.maxMiB * 2 ** 20);
				yield* Scope.close(generation, Exit.void);
				expect((yield* test.counts).warmBytes).toBe(0);
				for (const handle of observed.consumed) expect(() => handle.copy()).toThrow();
			})
	);
	it.live(
		'drops compiling isolates promptly and waits for native settlement before closing their cache',
		() =>
			Effect.gen(function* () {
				reset();
				const generation = yield* Effect.acquireRelease(Scope.make(), (scope) =>
					Scope.close(scope, Exit.void)
				);
				const test = yield* harness.pipe(Scope.provide(generation));
				const runner = yield* test.runner(program('closing')).pipe(Scope.provide(generation));
				yield* runner.invoke(invocation('prime'), bridge);
				yield* test.settled;
				const held = yield* Effect.acquireRelease(Effect.sync(gate), (value) =>
					Effect.sync(() => value.allow())
				);
				observed.gate = held;
				const calls = yield* Effect.forkChild(
					Effect.forEach(['a', 'b', 'c'], (id) => runner.invoke(invocation(id), bridge), {
						concurrency: 'unbounded'
					})
				);
				yield* Effect.promise(() => held.entered);
				let closed = false;
				const closing = yield* Effect.forkChild(
					Scope.close(generation, Exit.void).pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								closed = true;
							})
						)
					)
				);
				yield* Effect.promise(() => held.disposed);
				expect(closed).toBe(false);
				held.allow();
				yield* Fiber.join(closing);
				yield* Fiber.await(calls);
				expect((yield* test.counts).warmBytes).toBe(0);
				for (const handle of observed.consumed) expect(() => handle.copy()).toThrow();
			})
	);
});
