// Mutations: removing isolate finalization leaves live > warm; dropping final[4] loses timeout retry classification.
import { expect, it } from '@effect/vitest';
import { Context, Effect, Exit, Fiber, Layer, Scope } from 'effect';
import { LIMITS, type Invocation } from '../src/engine/contracts.ts';
import { GuestIsolates } from '../src/engine/ports.ts';
import { Guest, type Bridge } from '../src/engine/services.ts';
import { guestIsolates } from '../src/node/guest-isolates.ts';
import { guestLayer } from './support/guest-fixture.ts';
import { until } from './support/turns.ts';
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
		crossings: LIMITS.crossings.sync,
		readBytes: LIMITS.readBytes
	}
};
const noCalls: Bridge = { cross: () => Effect.succeed([]) };
it.live('closing a generation disposes its running isolates', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const port = yield* guestIsolates({
				cpuMs: LIMITS.guestCpuMs,
				warm: { maxMiB: 512, depth: 0, idleMs: 60_000 }
			});
			const scope = yield* Scope.make();
			const context = yield* Layer.build(
				guestLayer(
					{ source: 'export default { automation: { a: { body: () => { for (;;) {} } } } };' },
					{},
					undefined,
					GuestIsolates.fromAbi(port)
				)
			).pipe(Effect.provideService(Scope.Scope, scope));
			const running = yield* Context.get(context, Guest)
				.invoke(invocation, noCalls)
				.pipe(Effect.forkIn(scope));
			yield* until(Effect.sync(() => port.counts().live > 0));
			yield* Scope.close(scope, Exit.succeed(undefined));
			yield* Fiber.await(running);
			expect(port.counts().live).toBe(0);
		})
	)
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
