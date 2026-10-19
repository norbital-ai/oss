import { expect, it } from '@effect/vitest';
import { vi } from 'vitest';
import { Context, Effect, Layer } from 'effect';
import { LIMITS, type Invocation } from '../src/engine/contracts.ts';
import { Guest, GuestLimits, Isolates, type Bridge } from '../src/engine/services.ts';
import { guestLayer } from './support/guest-fixture.ts';

const fault = vi.hoisted(() => ({ error: new Error('constructor unavailable') }));
vi.mock('isolated-vm', () => ({
	default: {
		Isolate: class {
			constructor() {
				throw fault.error;
			}
		}
	}
}));
const invocation: Invocation = {
	id: 'constructor',
	kind: 'automation',
	target: 'a',
	input: null,
	ctx: {
		actor: { kind: 'system', run: 'run', by: { platform: 'test' } },
		now: '2026-01-01T00:00:00.000Z',
		today: '2026-01-01',
		tz: 'UTC',
		seed: 'constructor'
	},
	budget: {
		cpuMs: LIMITS.guestCpuMs,
		crossings: LIMITS.crossings.sync,
		readBytes: LIMITS.readBytes
	}
};
const bridge: Bridge = { cross: () => Effect.die(new Error('no guest should start')) };
it.effect('returns a failed outcome for ordinary isolate construction error', () =>
	Effect.gen(function* () {
		const limits = yield* GuestLimits;
		const context = yield* Layer.build(
			guestLayer({ source: 'export default {};' }).pipe(
				Layer.provide(Layer.succeed(GuestLimits, { ...limits, warm: { ...limits.warm, depth: 0 } }))
			)
		);
		const guest = Context.get(context, Guest),
			isolates = Context.get(context, Isolates),
			before = yield* isolates.counts;
		const result = yield* guest.invoke(invocation, bridge);
		expect(result).toMatchObject({
			kind: 'failed',
			cpuMs: 0,
			error: { code: 'internal', cause: fault.error }
		});
		const after = yield* isolates.counts;
		expect(after.live).toBe(before.live);
		expect(after.preparing).toBe(before.preparing);
	})
);
it.effect('settles background preparation accounting after ordinary constructor failure', () =>
	Effect.gen(function* () {
		const limits = yield* GuestLimits;
		const context = yield* Layer.build(
			guestLayer({ source: 'export default {};' }).pipe(
				Layer.provide(Layer.succeed(GuestLimits, { ...limits, warm: { ...limits.warm, depth: 2 } }))
			)
		);
		const guest = Context.get(context, Guest),
			isolates = Context.get(context, Isolates),
			before = yield* isolates.counts;
		expect(yield* guest.invoke(invocation, bridge)).toMatchObject({ kind: 'failed', cpuMs: 0 });
		yield* Effect.yieldNow;
		const after = yield* isolates.counts;
		expect(after.preparing).toBe(before.preparing);
		expect(after.failed - before.failed).toBe(2);
		expect(after.live).toBe(before.live);
	})
);
