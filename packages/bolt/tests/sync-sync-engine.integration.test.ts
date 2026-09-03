import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { compactSyncChanges, type SyncAdvanceSubscription } from '@norbital-ai/bolt-protocol';
import { applyPrefixDelta } from '../src/client/live-query/project.js';
import * as Collections from '../src/runtime/collections/collections.js';
import {
	advanceActivePrefix,
	extendActivePrefix,
	resolveInitialPrefix
} from '../src/runtime/sync/delta-engine.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const seedPeople = (h: BoltTestRuntime) =>
	h.runtime.runPromise(
		Effect.flatMap(Collections.Service, (collections) =>
			collections.mutate(
				h.effectId('seed'),
				adminSubject,
				'people',
				[
					{ name: 'Ada', team: 'core' },
					{ name: 'Grace', team: 'core' },
					{ name: 'Linus', team: 'edge' }
				],
				false,
				0
			)
		)
	);

describe('clean-cut sync engine', () => {
	it('compacts first-before/final-after facts without a collection changelog', () => {
		expect(
			compactSyncChanges([
				{
					collection: 'people',
					id: 'p1',
					operation: 'update',
					before: { team: 'core' },
					after: { team: 'edge' }
				},
				{
					collection: 'people',
					id: 'p1',
					operation: 'update',
					before: { team: 'edge' },
					after: { team: 'ops' }
				}
			])
		).toEqual([
			{
				collection: 'people',
				id: 'p1',
				operation: 'update',
				before: { team: 'core' },
				after: { team: 'ops' }
			}
		]);
	});

	it('derives an exact bounded keyed delta from the committed ChangeBatch', async () => {
		const h = await makeBoltTestRuntime(testWorkspace());
		harness = h;
		await seedPeople(h);
		const input = {
			kind: 'findMany' as const,
			collection: 'people',
			orderBy: { name: 'asc' as const },
			limit: 3
		};
		const initial = await h.runtime.runPromise(
			resolveInitialPrefix(h.effectId('open'), adminSubject, input, 3)
		);
		const committed = await h.runtime.runPromise(
			Effect.flatMap(Collections.Service, (collections) =>
				collections.mutate(
					h.effectId('insert'),
					adminSubject,
					'people',
					[{ name: 'Aaron', team: 'core' }],
					false,
					0
				)
			)
		);
		const state: SyncAdvanceSubscription = {
			subId: 'people-plan',
			input,
			planKey: initial.plan.effectivePlan.fingerprint,
			version: 0,
			prefixKeys: initial.keys,
			prefixBytes: initial.retainedBytes,
			viewerPrefixes: [3],
			credential: 'host-opaque',
			authorityFingerprint: initial.plan.effectivePlan.authority.fingerprint
		};
		const update = await h.runtime.runPromise(
			advanceActivePrefix(
				h.effectId('advance'),
				adminSubject,
				state,
				committed.batch
			)
		);
		expect(update).toBeDefined();
		if (update === undefined) throw new Error('Expected the inserted row to change the live prefix');
		const delta = update.deltas[0]?.delta;
		expect(delta).toBeDefined();
		const applied = applyPrefixDelta(initial.rows, delta ?? { removeIds: [], put: [] });
		const fresh = await h.runtime.runPromise(
			Effect.flatMap(Collections.Service, (collections) =>
				collections.findMany(h.effectId('fresh'), adminSubject, input)
			)
		);
		expect(applied).toEqual(fresh);
		expect(update).toMatchObject({ fromVersion: 0, toVersion: 1 });
		expect(update).not.toHaveProperty('digest');
		expect(update).not.toHaveProperty('patch');
	});

	it('does not advance a prefix when the authoritative answer is unchanged', async () => {
		const h = await makeBoltTestRuntime(testWorkspace());
		harness = h;
		await seedPeople(h);
		const input = {
			kind: 'findMany' as const,
			collection: 'people',
			orderBy: { name: 'asc' as const },
			limit: 3
		};
		const initial = await h.runtime.runPromise(
			resolveInitialPrefix(h.effectId('open-empty'), adminSubject, input, 3)
		);
		const update = await h.runtime.runPromise(
			advanceActivePrefix(
				h.effectId('advance-empty'),
				adminSubject,
				{
					subId: 'shared-plan',
					input,
					planKey: initial.plan.effectivePlan.fingerprint,
					version: 7,
					prefixKeys: initial.keys,
					prefixBytes: initial.retainedBytes,
					viewerPrefixes: [1, 3],
					credential: 'host-opaque',
					authorityFingerprint: initial.plan.effectivePlan.authority.fingerprint
				},
				{ changes: [] }
			)
		);
		expect(update).toBeUndefined();
	});

	it('extends a prefix monotonically without manufacturing a version', async () => {
		const h = await makeBoltTestRuntime(testWorkspace());
		harness = h;
		await seedPeople(h);
		const input = {
			kind: 'findMany' as const,
			collection: 'people',
			orderBy: { name: 'asc' as const },
			limit: 3
		};
		const initial = await h.runtime.runPromise(
			resolveInitialPrefix(h.effectId('open-extension'), adminSubject, input, 1)
		);
		const evaluation = await h.runtime.runPromise(
			extendActivePrefix(
				h.effectId('extension'),
				adminSubject,
				{
					subId: 'extension-plan',
					input,
					planKey: initial.plan.effectivePlan.fingerprint,
					version: 4,
					prefixKeys: initial.keys,
					prefixBytes: initial.retainedBytes,
					viewerPrefixes: [1],
					credential: 'host-opaque',
					authorityFingerprint: initial.plan.effectivePlan.authority.fingerprint
				},
				{ queryKey: 'people', version: 4, loadedPrefix: 1, requestedPrefix: 3 }
			)
		);
		expect(evaluation).toMatchObject({
			queryKey: 'people',
			version: 4,
			fromPrefix: 1,
			toPrefix: 3
		});
		expect(evaluation.rows).toHaveLength(2);
		expect(evaluation.prefixKeys).toHaveLength(3);
	});
});
