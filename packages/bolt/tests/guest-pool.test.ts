/// <reference types="node" />
// The Node host's prepared isolates: fresh heaps, bounded per host and program, owned by the host's scope.
import { describe, expect, it } from '@effect/vitest';
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { LIMITS, type GuestOutcome, type Invocation } from '../src/engine/contracts.ts';
import type { GuestProgram } from '../src/engine/guest/runner.ts';
import { GuestIsolates } from '../src/engine/ports.ts';
import { Guest, type Bridge } from '../src/engine/services.ts';
import { guestIsolates } from '../src/node/guest-isolates.ts';
import { guestLayer } from './support/guest-fixture.ts';
import { until } from './support/turns.ts';

const program = (body: string, prefix = ''): GuestProgram => ({
	source: `${prefix}\nexport default { automation: { a: { body: ${body} } } };\n`
});
const invocation = (id = 'inv'): Invocation => ({
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
const ok = (outcome: GuestOutcome) => {
	if (outcome.kind !== 'ok')
		throw new Error(
			`expected ok, got ${outcome.kind}: ${outcome.kind === 'failed' ? `${outcome.error.code} ${outcome.error.message}` : outcome.message}`
		);
	return outcome.output;
};
/** The host's pool reads `warm` live (its `idleMs` once, at creation). */
const harness = (overrides: { readonly depth?: number; readonly idleMs?: number } = {}) =>
	Effect.gen(function* () {
		const warm = { maxMiB: 512, depth: 2, idleMs: 60_000, ...overrides };
		const port = yield* guestIsolates({ cpuMs: LIMITS.guestCpuMs, warm });
		return {
			warm,
			counts: Effect.sync(port.counts),
			runner: (source: GuestProgram) =>
				Layer.build(
					guestLayer(source, { console: () => {} }, undefined, GuestIsolates.fromAbi(port))
				).pipe(Effect.map((context) => Context.get(context, Guest)))
		};
	});
type Harness = Effect.Success<ReturnType<typeof harness>>;
const settled = (test: Harness) =>
	until(Effect.map(test.counts, (counts) => counts.preparing === 0));
const noneRunning = (test: Harness) =>
	Effect.map(test.counts, (counts) => expect(counts.live).toBe(counts.warm));
const evictAll = (test: Harness) =>
	Effect.gen(function* () {
		const saved = { ...test.warm };
		Object.assign(test.warm, { maxMiB: 0, depth: 1 });
		const runner = yield* test.runner(program('() => 0', '// flush'));
		ok(yield* runner.invoke(invocation(), bridge));
		yield* settled(test);
		Object.assign(test.warm, saved);
		expect((yield* test.counts).warm).toBe(0);
	});
describe('prepared isolates', () => {
	it.live('maps a guest error to its authored location', () =>
		Effect.gen(function* () {
			const test = yield* harness();
			const runner = yield* test.runner({
				...program('(fail) => { if (fail) throw new Error("mapped"); return 1; }'),
				sourceMap: JSON.stringify({
					version: 3,
					file: 'guest.mjs',
					sources: ['src/automation/+a.automation.ts'],
					names: [],
					mappings: ';AAAA'
				})
			});
			expect(ok(yield* runner.invoke(invocation('success'), bridge))).toBe(1);
			const failed = yield* runner.invoke({ ...invocation('mapped error'), input: true }, bridge);
			expect(failed.kind).toBe('failed');
			if (failed.kind !== 'failed') return;
			expect(failed.error.cause).toMatchObject({ at: 'src/automation/+a.automation.ts:1' });
		})
	);
	it.live('refills a borrowed warm slot while its invocation waits for host I/O', () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>(),
				allow = yield* Deferred.make<void>();
			const test = yield* harness();
			const runner = yield* test.runner(
				program(
					`async () => globalThis[Symbol.for('norbital.bolt.call')]('progress', [null], 'pool')`
				)
			);
			ok(yield* runner.invoke(invocation('prime'), bridge));
			yield* settled(test);
			expect((yield* test.counts).warm).toBe(test.warm.depth);
			const holding: Bridge = {
				cross: (calls) =>
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(allow)),
						Effect.andThen(bridge.cross(calls))
					)
			};
			const running = yield* Effect.forkChild(runner.invoke(invocation('holding'), holding));
			yield* Deferred.await(entered);
			yield* settled(test);
			expect((yield* test.counts).warm).toBe(test.warm.depth);
			yield* Deferred.succeed(allow, undefined);
			expect(ok(yield* Fiber.join(running))).toBe(null);
		})
	);
	it.live(
		"serves invocations from prepared isolates, and none sees another invocation's globals or module state",
		() =>
			Effect.gen(function* () {
				const test = yield* harness(),
					runner = yield* test.runner(
						program(
							'() => [++count, typeof globalThis.leak, (globalThis.leak = 1)]',
							'let count = 0;'
						)
					);
				const before = (yield* test.counts).hits;
				expect(ok(yield* runner.invoke(invocation('a'), bridge))).toEqual([1, 'undefined', 1]);
				yield* settled(test);
				for (const id of ['b', 'c', 'd']) {
					expect(ok(yield* runner.invoke(invocation(id), bridge))).toEqual([1, 'undefined', 1]);
					yield* settled(test);
				}
				const all = yield* Effect.forEach(
					['e', 'f', 'g', 'h'],
					(id) => runner.invoke(invocation(id), bridge),
					{ concurrency: 'unbounded' }
				);
				expect(all.map(ok)).toEqual(Array(4).fill([1, 'undefined', 1]));
				expect((yield* test.counts).hits - before).toBeGreaterThanOrEqual(3);
				yield* settled(test);
				yield* noneRunning(test);
			})
	);
	it.live("binds the taking invocation's seed, and replays its entropy exactly", () =>
		Effect.gen(function* () {
			const test = yield* harness(),
				runner = yield* test.runner(program('() => crypto.randomUUID()'));
			const first = ok(yield* runner.invoke(invocation('same'), bridge));
			yield* settled(test);
			expect(ok(yield* runner.invoke(invocation('same'), bridge))).toBe(first);
			expect(ok(yield* runner.invoke(invocation('other'), bridge))).not.toBe(first);
		})
	);
	it.live(
		'disposes an over-budget isolate and never reuses it',
		() =>
			Effect.gen(function* () {
				const test = yield* harness(),
					runner = yield* test.runner(
						program(
							'() => { if (globalThis.poisoned) return "reused"; globalThis.poisoned = true; for (;;) {} }'
						)
					);
				const first = yield* runner.invoke(invocation('spin'), bridge);
				expect(first.kind === 'failed' && first.error.code).toBe('cpuBudget');
				yield* settled(test);
				yield* noneRunning(test);
				const { hits } = yield* test.counts,
					again = yield* runner.invoke(invocation('again'), bridge);
				expect((yield* test.counts).hits).toBe(hits + 1);
				expect(again.kind === 'failed' && again.error.code).toBe('cpuBudget');
				yield* settled(test);
				yield* noneRunning(test);
			})
	);
	it.live('keeps at most depth prepared isolates per program', () =>
		Effect.gen(function* () {
			const test = yield* harness();
			yield* evictAll(test);
			test.warm.depth = 3;
			const runner = yield* test.runner(program('() => 1', '// depth'));
			yield* Effect.forEach(
				Array.from({ length: 6 }, (_, i) => i),
				(i) => runner.invoke(invocation(`d${i}`), bridge),
				{ concurrency: 'unbounded' }
			);
			yield* settled(test);
			expect((yield* test.counts).warm).toBeLessThanOrEqual(3);
			expect((yield* test.counts).warm).toBeGreaterThan(0);
			test.warm.depth = 0;
			yield* evictAll(test);
			ok(yield* runner.invoke(invocation('none'), bridge));
			yield* settled(test);
			expect((yield* test.counts).warm).toBe(0);
			yield* noneRunning(test);
		})
	);
	it.live(
		'holds prepared bytes under the generation cap, evicting the least recently invoked program first',
		() =>
			Effect.gen(function* () {
				const test = yield* harness();
				yield* evictAll(test);
				test.warm.depth = 2;
				const cold = yield* test.runner(program('() => "cold"', '// cold'));
				ok(yield* cold.invoke(invocation('c1'), bridge));
				yield* settled(test);
				expect((yield* test.counts).warm).toBe(2);
				expect((yield* test.counts).warmBytes).toBeGreaterThan(0);
				test.warm.maxMiB = (yield* test.counts).warmBytes / 2 ** 20;
				const hot = yield* test.runner(program('() => "hot"', '// hot'));
				ok(yield* hot.invoke(invocation('h1'), bridge));
				yield* settled(test);
				expect((yield* test.counts).warmBytes).toBeLessThanOrEqual(test.warm.maxMiB * 2 ** 20);
				const { hits, misses } = yield* test.counts;
				ok(yield* hot.invoke(invocation('h2'), bridge));
				expect((yield* test.counts).hits).toBe(hits + 1);
				ok(yield* cold.invoke(invocation('c2'), bridge));
				expect((yield* test.counts).misses).toBe(misses + 1);
				yield* settled(test);
				expect((yield* test.counts).warmBytes).toBeLessThanOrEqual(test.warm.maxMiB * 2 ** 20);
			})
	);
	it.effect("drops a program's prepared isolates once it goes idle", () =>
		Effect.gen(function* () {
			const test = yield* harness({ idleMs: 50 });
			const runner = yield* test.runner(program('() => 1', '// idle'));
			ok(yield* runner.invoke(invocation(), bridge));
			yield* TestClock.withLive(settled(test));
			expect((yield* test.counts).warm).toBeGreaterThan(0);
			yield* TestClock.adjust('50 millis');
			expect((yield* test.counts).warm).toBe(0);
			yield* noneRunning(test);
		})
	);
	it.effect('drops preparation that completes after the program went idle', () =>
		Effect.gen(function* () {
			const test = yield* harness({ depth: 1, idleMs: 1 });
			const runner = yield* test.runner(
				program('() => 1', 'const until = Date.now() + 75; while (Date.now() < until) {}')
			);
			// The invocation's refill is still evaluating when its session releases the program.
			expect(ok(yield* runner.invoke(invocation(), bridge))).toBe(1);
			expect((yield* test.counts).preparing).toBe(1);
			yield* TestClock.adjust('1 millis');
			yield* TestClock.withLive(settled(test));
			expect((yield* test.counts).warm).toBe(0);
			yield* noneRunning(test);
		})
	);
	it.live('kills prepared isolates with the host and prepares none after', () =>
		Effect.gen(function* () {
			const scope = yield* Scope.make(),
				test = yield* harness().pipe(Effect.provideService(Scope.Scope, scope));
			const runner = yield* test
				.runner(program('() => 1', '// generation'))
				.pipe(Effect.provideService(Scope.Scope, scope));
			ok(yield* runner.invoke(invocation(), bridge));
			yield* settled(test);
			expect((yield* test.counts).warm).toBeGreaterThan(0);
			yield* Scope.close(scope, Exit.succeed(undefined));
			expect((yield* test.counts).warm).toBe(0);
			const late = yield* runner.invoke(invocation('late'), bridge);
			expect(late.kind === 'failed' && late.error.code).toBe('interrupted');
			yield* settled(test);
			expect((yield* test.counts).warm).toBe(0);
			yield* noneRunning(test);
		})
	);
});
