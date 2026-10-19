// Mutations: removing isolate finalization leaves live > warm; dropping final[4] loses timeout retry classification.
import { expect, it } from '@effect/vitest';
import { Context, Effect, Exit, Fiber, Layer, Schedule, Scope } from 'effect';
import { LIMITS, type Invocation } from '../src/engine/contracts.ts';
import { Guest, GuestLimits, Isolates, type Bridge } from '../src/engine/services.ts';
import { guestLayer } from './support/guest-fixture.ts';
const invocation: Invocation = {
	id: 'scope',
	kind: 'automation',
	target: 'a',
	input: null,
	ctx: {
		actor: { kind: 'system', run: 'run', by: { platform: 'test' } },
		now: '2026-01-01T00:00:00.000Z',
		today: '2026-01-01',
		tz: 'UTC',
		seed: 'scope'
	},
	budget: {
		cpuMs: LIMITS.guestCpuMs,
		crossings: LIMITS.crossings.sync,
		readBytes: LIMITS.readBytes
	}
};
const noCalls: Bridge = { cross: () => Effect.succeed([]) };
it.live('closing a generation disposes its running isolates', () =>
	Effect.gen(function* () {
		const scope = yield* Scope.make(),
			limits = yield* GuestLimits;
		const context = yield* Layer.build(
			guestLayer({
				source: 'export default { automation: { a: { body: () => { for (;;) {} } } } };'
			}).pipe(
				Layer.provide(Layer.succeed(GuestLimits, { ...limits, warm: { ...limits.warm, depth: 0 } }))
			)
		).pipe(Effect.provideService(Scope.Scope, scope));
		const isolates = Context.get(context, Isolates),
			guest = Context.get(context, Guest);
		const running = yield* guest.invoke(invocation, noCalls).pipe(Effect.forkIn(scope));
		yield* isolates.counts.pipe(
			Effect.repeat({
				schedule: Schedule.spaced('1 millis'),
				until: (counts) => counts.live > 0,
				times: 1000
			})
		);
		yield* Scope.close(scope, Exit.succeed(undefined));
		yield* Fiber.await(running);
		expect((yield* isolates.counts).live).toBe(0);
	})
);
it.live('copies facility failure kind onto the guest error cause', () =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			guestLayer({
				source:
					'export default { automation: { a: { body: () => { const e = new Error("slow"); e.kind = "timeout"; throw e; } } } };'
			})
		);
		const answer = yield* Context.get(context, Guest).invoke(invocation, noCalls);
		expect(answer).toMatchObject({
			kind: 'failed',
			error: { code: 'guestError', cause: { kind: 'timeout', message: 'slow' } }
		});
	})
);
