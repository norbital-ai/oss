import { expect, it } from '@effect/vitest';
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Result, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { LIMITS, type CrossAnswer, type Invocation } from '../src/engine/contracts.ts';
import { Guest, type Bridge } from '../src/engine/services.ts';
import { guestLayer } from './support/guest-fixture.ts';
const invocation: Invocation = {
	id: 'wall',
	kind: 'automation',
	target: 'a',
	input: null,
	ctx: {
		actor: { kind: 'system', run: 'run', by: { platform: 'test' } },
		now: '2026-01-01T00:00:00.000Z',
		today: '2026-01-01',
		tz: 'UTC',
		seed: 'wall'
	},
	budget: {
		cpuMs: LIMITS.guestCpuMs,
		crossings: LIMITS.crossings.sync,
		readBytes: LIMITS.readBytes
	}
};
const source = {
	source: `export default { automation: { a: { body: async () => Promise.all([null,0].map(value => globalThis[Symbol.for('norbital.bolt.call')]('progress',[value],'wall').then(value=>({ok:true,value}),error=>({ok:false,error})))) } } };`
};
const answers: readonly CrossAnswer[] = [
	{ ok: true, value: null },
	{ ok: true, value: 0 }
];
const timeout = answers.map(() => ({
	ok: false,
	error: { kind: 'timeout', message: 'no answer within 20 ms' }
}));
const host = (callWallMs = 20) =>
	Layer.build(guestLayer(source, { callWallMs, console: () => {} })).pipe(
		Effect.map((context) => Context.get(context, Guest))
	);
const adapterSignal = Effect.acquireRelease(
	Effect.sync(() => new AbortController()),
	(controller, exit) =>
		Effect.sync(() => {
			if (Exit.hasInterrupts(exit)) controller.abort();
		})
).pipe(Effect.map((controller) => controller.signal));
const output = (answer: Effect.Success<ReturnType<Guest['Service']['invoke']>>) => {
	if (answer.kind !== 'ok') throw new Error(`expected ok: ${JSON.stringify(answer)}`);
	return answer.output;
};
it.effect('rejects invalid deadline configuration before any bridge work', () =>
	Effect.gen(function* () {
		for (const millis of [-1, 0.5, NaN, Infinity, 2 ** 32]) {
			const exit = yield* Effect.exit(host(millis));
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit))
				expect(Cause.findErrorOption(exit.cause)).toMatchObject({
					_tag: 'Some',
					value: { _tag: 'BoltError', code: 'invalidInput' }
				});
		}
	})
);
it.effect('preserves answers and malformed failure mapping; empty bodies invoke no bridge', () =>
	Effect.gen(function* () {
		let reads = 0;
		const guest = yield* host(),
			bridge: Bridge = {
				cross: () =>
					Effect.sync(() => {
						reads++;
						return answers;
					})
			};
		const blank = yield* Layer.build(
			guestLayer({ source: 'export default { automation: { a: { body: () => [] } } };' })
		);
		expect(output(yield* Context.get(blank, Guest).invoke(invocation, bridge))).toEqual([]);
		expect(reads).toBe(0);
		expect(output(yield* guest.invoke(invocation, bridge))).toEqual(answers);
		expect(
			output(yield* guest.invoke(invocation, { cross: () => Effect.die(new Error('native')) }))
		).toEqual(
			answers.map(() => ({ ok: false, error: { kind: 'bolt', code: 'bridge', message: 'native' } }))
		);
		expect(output(yield* guest.invoke(invocation, { cross: () => Effect.succeed([]) }))).toEqual(
			answers.map(() => ({
				ok: false,
				error: {
					kind: 'bolt',
					code: 'badAnswer',
					message: 'the host answered a different number of calls'
				}
			}))
		);
		const defect = new Error('invalid native array');
		const poisoned = new Proxy(answers, {
			get(target, key, receiver) {
				if (key === 'length') throw defect;
				return Reflect.get(target, key, receiver);
			}
		});
		const exit = yield* Effect.exit(
			guest.invoke(invocation, { cross: () => Effect.succeed(poisoned) })
		);
		if (Exit.isSuccess(exit)) throw new Error('the poisoned host array must fail');
		const found = Cause.findDefect(exit.cause);
		expect(Result.isSuccess(found) ? found.success : undefined).toBe(defect);
	})
);
it.effect('expires exactly at the wall and aborts an adapter that ignores cancellation', () =>
	Effect.gen(function* () {
		const guest = yield* host(),
			ready = yield* Deferred.make<AbortSignal>(),
			held = yield* Deferred.make<readonly CrossAnswer[]>();
		let settled = false;
		const bridge: Bridge = {
			cross: () =>
				Effect.scoped(
					Effect.gen(function* () {
						const signal = yield* adapterSignal;
						yield* Deferred.succeed(ready, signal);
						return yield* Deferred.await(held);
					})
				)
		};
		const work = yield* guest.invoke(invocation, bridge).pipe(
			Effect.tap(() =>
				Effect.sync(() => {
					settled = true;
				})
			),
			Effect.forkScoped
		);
		const signal = yield* Deferred.await(ready);
		yield* TestClock.adjust('19 millis');
		expect(settled).toBe(false);
		expect(signal.aborted).toBe(false);
		yield* TestClock.adjust('1 millis');
		expect(output(yield* Fiber.join(work))).toEqual(timeout);
		expect(signal.aborted).toBe(true);
		yield* Deferred.succeed(held, answers);
		expect(output(yield* Fiber.join(work))).toEqual(timeout);
	})
);
it.effect('a closed generation refuses without invoking the bridge', () =>
	Effect.gen(function* () {
		const scope = yield* Scope.make(),
			guest = yield* host().pipe(Effect.provideService(Scope.Scope, scope));
		let invoked = false;
		yield* Scope.close(scope, Exit.succeed(undefined));
		expect(
			yield* guest.invoke(invocation, {
				cross: () =>
					Effect.sync(() => {
						invoked = true;
						return answers;
					})
			})
		).toMatchObject({ kind: 'failed', error: { code: 'interrupted' } });
		expect(invoked).toBe(false);
	})
);
it.effect('scope cancellation aborts pending I/O and refuses late answers', () =>
	Effect.gen(function* () {
		const scope = yield* Scope.make(),
			guest = yield* host().pipe(Effect.provideService(Scope.Scope, scope));
		const ready = yield* Deferred.make<AbortSignal>(),
			held = yield* Deferred.make<readonly CrossAnswer[]>();
		const bridge: Bridge = {
			cross: () =>
				Effect.scoped(
					Effect.gen(function* () {
						const signal = yield* adapterSignal;
						yield* Deferred.succeed(ready, signal);
						return yield* Deferred.await(held);
					})
				)
		};
		const work = yield* guest.invoke(invocation, bridge).pipe(Effect.forkScoped);
		const signal = yield* Deferred.await(ready);
		yield* Scope.close(scope, Exit.succeed(undefined));
		expect(Exit.isFailure(yield* Fiber.await(work))).toBe(true);
		expect(signal.aborted).toBe(true);
		yield* Deferred.succeed(held, answers);
		expect(Exit.isFailure(yield* Fiber.await(work))).toBe(true);
	})
);
it.effect('successful I/O clears its deadline without aborting its native signal', () =>
	Effect.gen(function* () {
		const guest = yield* host(),
			seen: AbortSignal[] = [];
		const bridge: Bridge = {
			cross: () =>
				Effect.scoped(
					Effect.gen(function* () {
						seen.push(yield* adapterSignal);
						return answers;
					})
				)
		};
		expect(output(yield* guest.invoke(invocation, bridge))).toEqual(answers);
		yield* TestClock.adjust('20 millis');
		expect(seen[0]?.aborted).toBe(false);
	})
);
