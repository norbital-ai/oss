import { expect, it } from '@effect/vitest';
import { vi } from 'vitest';
import { Context, Effect, Layer } from 'effect';
import { LIMITS, type Invocation } from '../src/engine/contracts.ts';
import { GuestIsolates } from '../src/engine/ports.ts';
import { Guest, type Bridge } from '../src/engine/services.ts';
import { guestIsolates } from '../src/node/guest-isolates.ts';
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
		crossings: LIMITS.crossings.sync,
		readBytes: LIMITS.readBytes
	}
};
const bridge: Bridge = { cross: () => Effect.die(new Error('no guest should start')) };
/** A guest layer over the Node host's isolates, with `depth` prepared isolates per program. */
const harness = (depth: number) =>
	Effect.gen(function* () {
		const port = yield* guestIsolates({
			cpuMs: LIMITS.guestCpuMs,
			warm: { maxMiB: 512, depth, idleMs: 60_000 }
		});
		const context = yield* Layer.build(
			guestLayer({ source: 'export default {};' }, {}, undefined, GuestIsolates.fromAbi(port))
		);
		return { guest: Context.get(context, Guest), counts: port.counts };
	});
it.effect('returns a failed outcome for ordinary isolate construction error', () =>
	Effect.gen(function* () {
		const { guest, counts } = yield* harness(0),
			before = counts();
		const result = yield* guest.invoke(invocation, bridge);
		expect(result).toMatchObject({
			kind: 'failed',
			error: { code: 'internal', cause: fault.error }
		});
		const after = counts();
		expect(after.live).toBe(before.live);
		expect(after.preparing).toBe(before.preparing);
	})
);
it.effect('settles background preparation accounting after ordinary constructor failure', () =>
	Effect.gen(function* () {
		const { guest, counts } = yield* harness(2),
			before = counts();
		expect(yield* guest.invoke(invocation, bridge)).toMatchObject({ kind: 'failed' });
		yield* Effect.yieldNow;
		const after = counts();
		expect(after.preparing).toBe(before.preparing);
		expect(after.failed - before.failed).toBe(2);
		expect(after.live).toBe(before.live);
	})
);
