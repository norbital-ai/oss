import { describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import {
	createPartitionSyncCoordinator,
	type DurablePartitionPosition,
	type PartitionSyncStore
} from '../../src/client/replica/partition-sync.js';
import type { PartitionDelta } from '../../src/client/replica/subscribe.js';

const cursor = (sequence: number) => ({ xid: 1, sequence });
const cost = {
	replayEvents: 0,
	replayEstimateComplete: true,
	estimatedBytesPerEvent: 0,
	estimatedReplayBytes: 0,
	estimatedRehydrateBytes: null
} as const;
const partition = {
	key: 'partition',
	tenantId: 'tenant',
	environment: 'development',
	effectivePolicyHolder: 'principal',
	impersonationTarget: null,
	authorityGeneration: 1,
	schemaFingerprint: 'schema-v1'
} as const;
const delta = (sequence: number, recordId = `job-${sequence}`): PartitionDelta => ({
	cursor: cursor(sequence),
	collection: 'jobs',
	op: 'upsert',
	recordId,
	rowVersion: sequence,
	mutationId: null,
	row: { id: recordId, row_version: sequence, title: `Job ${sequence}` }
});

const harness = () => {
	let position: DurablePartitionPosition = { cursor: cursor(1), generations: { jobs: 1 } };
	let positionReads = 0;
	const applications: Array<ReadonlyArray<PartitionDelta>> = [];
	const invalidations: Array<ReadonlyArray<string>> = [];
	const rebuilds: Array<ReadonlyArray<string>> = [];
	const store: PartitionSyncStore = {
		position: () => Effect.sync(() => {
			positionReads += 1;
			return position;
		}),
		applyDeltas: (batch) =>
			Effect.sync(() => {
				applications.push(batch.deltas);
				position = { cursor: batch.cursor, generations: batch.generations };
				return {
					applied: batch.deltas.length,
					affectedCollections: [...new Set(batch.deltas.map(({ collection }) => collection))],
					affectedWindowIds: ['jobs-window'],
					proofWithdrawals: ['grouped-jobs']
				};
			}),
		invalidateDependencies: (collections, generations) =>
			Effect.sync(() => {
				invalidations.push(collections);
				position = { ...position, generations };
			}),
		rebuildNamespace: () =>
			Effect.sync(() => {
				rebuilds.push([]);
				position = { cursor: { xid: 0, sequence: 0 }, generations: {} };
			}),
		recordPosition: (next) => Effect.sync(() => (position = next))
	};
	const reruns: Array<ReadonlyArray<string>> = [];
	const refills: Array<string> = [];
	const rehydrates: Array<ReadonlyArray<string>> = [];
	const dependencyPublications: Array<ReadonlyArray<string>> = [];
	const coordinator = createPartitionSyncCoordinator({
		store,
		rerunAffected: (collections) => reruns.push(collections),
		refillWindow: async (queryKey) => {
			refills.push(queryKey);
		},
		rehydrateActive: async (keys) => {
			rehydrates.push(keys);
		},
		onDependenciesChanged: (collections) => dependencyPublications.push(collections)
	});
	return {
		applications,
		coordinator,
		dependencyPublications,
		invalidations,
		rebuilds,
		refills,
		rehydrates,
		reruns,
		positionReads: () => positionReads
	};
};

describe('partition sync moves', () => {
	it('removes only the dependencies owned by the released mount', () => {
		const state = harness();
		const releaseJobs = state.coordinator.mountWindow('shared-window', ['jobs']);
		const releaseTeams = state.coordinator.mountWindow('shared-window', ['teams']);
		expect(state.coordinator.dependencies()).toEqual(['jobs', 'teams']);
		expect(state.coordinator.hydrationPlan()[0]).toMatchObject({ priority: 1 });

		releaseJobs.setVisibility('visible');
		expect(state.coordinator.hydrationPlan()[0]).toMatchObject({ priority: 0 });

		releaseJobs();
		releaseJobs();
		expect(state.coordinator.dependencies()).toEqual(['teams']);
		expect(state.coordinator.hydrationPlan()[0]).toMatchObject({ priority: 1 });

		releaseTeams();
		expect(state.coordinator.dependencies()).toEqual([]);
	});

	it('retains a canonical relationship window at P1 for exactly the owning mount', () => {
		const state = harness();
		const release = state.coordinator.mountWindow(
			'jobs-with-owner',
			['jobs', 'owners'],
			'unknown',
			{ relationDependency: true }
		);
		expect(state.coordinator.hydrationPlan()).toEqual([
			{
				queryKey: 'jobs-with-owner',
				priority: 1,
				reasons: ['mounted', 'relation-dependency'],
				lastAccess: null
			}
		]);

		release();
		expect(state.coordinator.hydrationPlan()).toEqual([]);
	});

	it('does not read durable position for duplicate aggregate dependency sets', async () => {
		const state = harness();
		const releaseFirst = state.coordinator.mountWindow('jobs-one', ['jobs']);
		const releaseSecond = state.coordinator.mountWindow('jobs-two', ['jobs']);
		await state.coordinator.idle();
		expect(state.dependencyPublications).toEqual([['jobs']]);
		expect(state.positionReads()).toBe(1);

		releaseSecond();
		await state.coordinator.idle();
		expect(state.dependencyPublications).toEqual([['jobs']]);
		expect(state.positionReads()).toBe(1);

		releaseFirst();
		await state.coordinator.idle();
		expect(state.dependencyPublications).toEqual([['jobs'], []]);
		expect(state.positionReads()).toBe(2);
	});

	it('buffers page-flight deltas and withholds proof when generations moved', async () => {
		const state = harness();
		state.coordinator.mountWindow('jobs-window', ['jobs']);
		const flight = state.coordinator.beginWindowFlight('jobs-window', ['jobs']);
		state.coordinator.acceptDeltas({
			partition,
			kind: 'delta',
			deltas: [delta(2)],
			cursor: cursor(2),
			headCursor: cursor(2),
			generations: { jobs: 2 },
			affectedCollections: ['jobs'],
			refillCollections: ['jobs'],
			cost,
			mutationConfirmations: [],
			mutationRejections: [],
			complete: true
		});
		await state.coordinator.idle();

		let installed:
			| Readonly<{ buffered: ReadonlyArray<PartitionDelta>; proofMayBeValid: boolean }>
			| undefined;
		await state.coordinator.installWindowFlight(
			flight,
			cursor(1),
			{ jobs: 1 },
			(context) =>
			Effect.sync(() => {
				installed = {
					buffered: context.bufferedDeltas,
					proofMayBeValid: context.proofMayBeValid
				};
				return { valid: context.proofMayBeValid, dirty: false };
			})
		);
		await vi.waitFor(() => expect(state.refills).toEqual(['jobs-window']));
		expect(installed).toEqual({ buffered: [delta(2)], proofMayBeValid: false });
		// Page install owns the buffered replay in the same transaction; the stream apply occurs once.
		expect(state.applications).toEqual([[delta(2)]]);
	});

	it('applies a batch atomically and reruns the affected window set once', async () => {
		const state = harness();
		state.coordinator.mountWindow('jobs-window', ['jobs']);
		state.coordinator.acceptDeltas({
			partition,
			kind: 'delta',
			deltas: [delta(2), delta(3)],
			cursor: cursor(3),
			headCursor: cursor(3),
			generations: { jobs: 3 },
			affectedCollections: ['jobs'],
			refillCollections: [],
			cost,
			mutationConfirmations: [],
			mutationRejections: [],
			complete: true
		});
		await state.coordinator.idle();
		expect(state.reruns).toEqual([['jobs']]);
	});

	it('keeps server-proof windows stale and schedules one bounded refill per batch', async () => {
		const state = harness();
		state.coordinator.mountWindow('grouped-jobs', ['jobs']);
		state.coordinator.acceptDeltas({
			partition,
			kind: 'delta',
			deltas: [delta(2), delta(3)],
			cursor: cursor(3),
			headCursor: cursor(3),
			generations: { jobs: 3 },
			affectedCollections: ['jobs'],
			refillCollections: ['jobs'],
			cost,
			mutationConfirmations: [],
			mutationRejections: [],
			complete: true
		});
		await state.coordinator.idle();
		await vi.waitFor(() => expect(state.refills).toEqual(['grouped-jobs']));
	});

	it('withdraws moved dependency proofs and refills only affected active windows', async () => {
		const state = harness();
		state.coordinator.mountWindow('jobs-window', ['jobs']);
		state.coordinator.mountWindow('teams-window', ['teams']);
		state.coordinator.invalidate(['jobs'], { jobs: 4, teams: 1 });
		await state.coordinator.idle();
		await vi.waitFor(() => expect(state.refills).toEqual(['jobs-window']));
		expect(state.invalidations).toEqual([['jobs']]);
	});

	it('uses M3 for cursor rollback, expiry and rehydrate advice', async () => {
		const state = harness();
		state.coordinator.mountWindow('a-hidden-window', ['jobs']);
		const visible = state.coordinator.mountWindow('z-visible-window', ['jobs']);
		visible.setVisibility('visible');
		state.coordinator.observeReady({
			connectionId: 'one',
			partition,
			cursor: cursor(10),
			generations: { jobs: 10 }
		});
		state.coordinator.observeReady({
			connectionId: 'two',
			partition,
			cursor: cursor(0),
			generations: { jobs: 1 }
		});
		state.coordinator.recover({
			partition,
			kind: 'cursorExpired',
			cursor: cursor(20),
			headCursor: cursor(20),
			generations: { jobs: 20 },
			affectedCollections: ['jobs'],
			refillCollections: ['jobs'],
			cost,
			mutationConfirmations: [],
			mutationRejections: [],
			complete: true
		});
		state.coordinator.recover({
			partition,
			kind: 'rehydrateAdvised',
			cursor: cursor(30),
			headCursor: cursor(30),
			generations: { jobs: 30 },
			affectedCollections: ['jobs'],
			refillCollections: ['jobs'],
			cost,
			mutationConfirmations: [],
			mutationRejections: [],
			complete: true
		});
		await state.coordinator.idle();
		expect(state.rebuilds).toEqual([[], [], []]);
		expect(state.rehydrates).toEqual([
			['z-visible-window', 'a-hidden-window'],
			['z-visible-window', 'a-hidden-window'],
			['z-visible-window', 'a-hidden-window']
		]);
	});
});
