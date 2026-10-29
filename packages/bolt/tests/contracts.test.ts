import { fileURLToPath } from 'node:url';
import { it } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, Fiber, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect } from 'vitest';
import { discover } from '../../bolt-cli/src/compiler/discover.ts';
import { load } from '../../bolt-cli/src/compiler/load.ts';
import { engineManifest } from '../src/engine/manifest.ts';
import { Port } from '../src/engine/port.ts';
import { FacilityFailure, Unavailable } from '../src/decl/errors.ts';
import { install } from '../src/decl/runtime/guest.ts';

install();

describe('next engine contracts', () => {
	it.effect('port failures remain typed and calls remain bounded (L-BOLT-288, 289)', () =>
		Effect.gen(function* () {
			expect(yield* Port.unavailable('geo').pipe(Effect.flip)).toEqual(
				new Unavailable({ facility: 'geo', reason: 'the host provides no geo' })
			);
			expect(
				yield* Port.attempt('geo', () => {
					throw new Error('sync');
				}).pipe(Effect.flip)
			).toEqual(new FacilityFailure({ kind: 'upstream', message: 'sync' }));
			expect(
				yield* Port.attempt('geo', () => Promise.reject(new Error(''))).pipe(Effect.flip)
			).toEqual(new FacilityFailure({ kind: 'upstream', message: 'geo failed' }));
			const timed = yield* Effect.forkChild(Effect.never.pipe(Port.call('geo', 20), Effect.flip));
			yield* TestClock.adjust('20 millis');
			expect(yield* Fiber.join(timed)).toEqual(
				new FacilityFailure({ kind: 'timeout', message: 'geo did not answer within 20 ms' })
			);
			expect(
				yield* Port.fromPromise(() => Promise.resolve('x'), Schema.Number, 'geo').pipe(Effect.flip)
			).toEqual(
				new FacilityFailure({
					kind: 'upstream',
					message: 'geo answered something that is not its result'
				})
			);
			expect(yield* Port.fromPromise(() => Promise.resolve(7), Schema.Number, 'geo')).toBe(7);
		})
	);
	it.live('engineManifest projects the loaded manifest to data, bodies stripped', () =>
		Effect.gen(function* () {
			const root = fileURLToPath(new URL('./fixtures/good', import.meta.url));
			const { manifest, errors } = yield* load(root, (yield* discover(root)).files);
			expect(errors).toEqual([]);
			const m = engineManifest(manifest);
			expect(Object.keys(m.exposures).sort()).toEqual(['customers', 'notices', 'orders']);
			expect(m.exposures.orders).not.toHaveProperty('bodies');
			expect(m.exposures.orders).toHaveProperty('read');
			expect(m.integrations.mail).toEqual({
				description: 'The notices mailbox',
				driver: 'email'
			});
			expect(m.exposures.notices?.syncs).toEqual({ messages: { with: 'mail', read: true } });
			expect(m.envoys.desk?.policies).toEqual(['sales_rep']);
			expect(m.connections.support).toEqual({ integration: 'mail', envoy: 'desk' });
			expect(m.workspace.tz).toBeTypeOf('string');
			expect(Object.keys(m.automations)).toEqual(['nightly']);
			expect(m.automations.nightly).toBeDefined();
			expect(m.agent.skills.triage?.text).toContain('description: Triage a notice');
			expect(m.agent.internal).toBeTypeOf('string');
			expect(JSON.parse(JSON.stringify(m.models))).toEqual(m.models);
		}).pipe(Effect.provide(NodeServices.layer))
	);
});
