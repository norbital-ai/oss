import { describe, expect, it } from 'vitest';
import {
	enforceProfileReplicaBudget,
	planProfileEviction,
	selectReplicaStorage,
	storageBudgetFor
} from '../../src/client/replica/budget.js';
import {
	createRunningAutomationLeaseHooks,
	createReplicaProfileIndex,
	profilePartition,
	profileWindowsFromLedger,
	type ReplicaProfileStateStore
} from '../../src/client/replica/profile-index.js';
import {
	deleteInactivePGlitePartition,
	openReplicaPhysicalPartitionLease,
	parseReplicaPGliteLocation,
	ReplicaPhysicalPartitionBusy,
	type ReplicaStorageLockManager
} from '../../src/client/replica/physical-storage.js';

const memoryStore = (initial?: unknown) => {
	let durable = initial;
	const store: ReplicaProfileStateStore = {
		read: async () => durable,
		update: async (change) => {
			const changed = change(durable);
			durable = changed.state;
			return changed.value;
		},
		close: () => undefined
	};
	return { store, durable: () => durable };
};

const window = (id: string, lastAccess: number, bytes = 100) => ({
	id,
	kind: 'window' as const,
	accountedBytes: bytes,
	lastAccess
});

class SharedStorageLocks implements ReplicaStorageLockManager {
	shared = 0;
	exclusive = false;

	request = async <Value>(
		name: string,
		options: { readonly mode: 'shared' | 'exclusive'; readonly ifAvailable?: boolean },
		callback: (lock: { readonly name: string } | null) => Value | PromiseLike<Value>
	): Promise<Value> => {
		if (options.mode === 'exclusive' && (this.exclusive || this.shared > 0)) {
			if (options.ifAvailable) return callback(null);
			throw new Error('the focused fake does not queue exclusive locks');
		}
		if (options.mode === 'shared' && this.exclusive) {
			throw new Error('the focused fake does not queue shared locks');
		}
		if (options.mode === 'shared') this.shared += 1;
		else this.exclusive = true;
		try {
			return await callback({ name });
		} finally {
			if (options.mode === 'shared') this.shared -= 1;
			else this.exclusive = false;
		}
	};
}

describe('browser-profile replica budget', () => {
	it('holds a physical storage lease until PGlite closes and deletes only its exact OPFS directory', async () => {
		const locks = new SharedStorageLocks();
		const open = openReplicaPhysicalPartitionLease('opfs:partition', locks);
		await open.ready;
		const removed: Array<string> = [];
		const candidate = {
			id: 'opfs:partition',
			partitionId: 'opfs:partition',
			organization: 'org',
			tier: 'opfs' as const,
			location: 'opfs-ahp://bolt-replica::partition',
			kind: 'partition' as const,
			lastAccess: 1,
			accountedBytes: 100
		};
		await expect(
			deleteInactivePGlitePartition(candidate, {
				locks,
				opfsRoot: async () => ({
					removeEntry: async (name) => {
						removed.push(name);
					}
				}),
				indexeddb: {} as IDBFactory
			})
		).rejects.toBeInstanceOf(ReplicaPhysicalPartitionBusy);
		expect(removed).toEqual([]);

		await open.stop();
		await deleteInactivePGlitePartition(candidate, {
			locks,
			opfsRoot: async () => ({
				removeEntry: async (name) => {
					removed.push(name);
				}
			}),
			indexeddb: {} as IDBFactory
		});
		expect(removed).toEqual(['bolt-replica::partition']);
		expect(() => parseReplicaPGliteLocation('opfs-ahp://../partition')).toThrow(
			'invalid PGlite replica location'
		);
	});

	it('does not open OPFS without the durable shared profile index', async () => {
		expect(
			await selectReplicaStorage({
				estimate: async () => ({ usage: 0, quota: 20 * 1024 * 1024 * 1024 }),
				opfs: true,
				indexeddb: false,
				webLocks: true
			})
		).toMatchObject({ tier: 'server-only' });
	});

	it('indexes OPFS and IndexedDB partitions in one durable profile directory', async () => {
		const memory = memoryStore();
		const index = createReplicaProfileIndex(memory.store);
		const opfsWindows = profileWindowsFromLedger('opfs-partition', [
			{ id: 'window-a', kind: 'window', bytes: 120, lastAccess: 1 }
		]);
		await index.notePartition(
			profilePartition({
				id: 'opfs-partition',
				organization: 'org-a',
				tier: 'opfs',
				location: 'opfs-ahp://opfs-partition',
				windows: opfsWindows,
				lastAccess: 1
			})
		);
		await index.replaceWindows('opfs-partition', opfsWindows);
		await index.notePartition(
			profilePartition({
				id: 'idb-partition',
				organization: 'org-b',
				tier: 'indexeddb',
				location: 'idb://idb-partition',
				windows: [],
				lastAccess: 2
			})
		);
		const reopened = createReplicaProfileIndex(memory.store);
		const snapshot = await reopened.snapshot(10);
		expect(snapshot.protectionKnown).toBe(true);
		expect(snapshot.partitions).toEqual([
			expect.objectContaining({ id: 'opfs-partition', tier: 'opfs', accountedBytes: 120 }),
			expect.objectContaining({ id: 'idb-partition', tier: 'indexeddb' })
		]);
		expect(snapshot.windows).toEqual([
			expect.objectContaining({ id: 'window-a', partitionId: 'opfs-partition' })
		]);
		expect(memory.durable()).toMatchObject({ version: 2 });
	});

	it('evicts cold canonical windows before whole inactive organization partitions', async () => {
		const memory = memoryStore();
		const index = createReplicaProfileIndex(memory.store);
		for (const [id, organization] of [
			['warm', 'org-warm'],
			['inactive', 'org-inactive']
		] as const) {
			await index.notePartition({
				id,
				organization,
				tier: 'opfs',
				location: `opfs-ahp://${id}`,
				accountedBytes: 1_000,
				lastAccess: id === 'warm' ? 20 : 1
			});
		}
		await index.replaceWindows('warm', [
			window('window-newer', 9),
			window('window-older', 2),
			window('window-oldest', 1)
		]);
		await index.replaceWindows('inactive', [window('inactive-window', 0)]);
		const active = await index.lease({
			ownerId: 'tab-one',
			partitionId: 'warm',
			kind: 'active-tab',
			now: 100,
			ttlMillis: 5_000
		});

		// Active-tab ownership protects the physical database, while cold unmounted windows may leave.
		expect(planProfileEviction(await index.snapshot(100), 100).map(({ id }) => id)).toEqual([
			'inactive-window',
			'window-oldest',
			'window-older',
			'window-newer',
			'inactive'
		]);
		await active.release();
		expect(planProfileEviction(await index.snapshot(100), 100).map(({ id }) => id)).toEqual([
			'inactive-window',
			'window-oldest',
			'window-older',
			'window-newer',
			'inactive',
			'warm'
		]);
	});

	it('protects visible windows, pending mutations and running automations', async () => {
		const memory = memoryStore();
		const index = createReplicaProfileIndex(memory.store);
		const now = Date.now();
		for (const id of ['visible', 'pending', 'automation']) {
			await index.notePartition({
				id,
				organization: id,
				tier: 'opfs',
				location: `opfs-ahp://${id}`,
				accountedBytes: 100,
				lastAccess: 1
			});
			await index.replaceWindows(id, [window(`${id}-window`, 1)]);
		}
		await index.lease({
			ownerId: 'tab',
			partitionId: 'visible',
			windowId: 'visible-window',
			kind: 'visible-window',
			now,
			ttlMillis: 5_000
		});
		const pending = await index.lease({
			ownerId: 'leader',
			partitionId: 'pending',
			kind: 'pending-mutation',
			now
		});
		const automations = createRunningAutomationLeaseHooks({
			index,
			ownerId: 'leader',
			partitionId: 'automation'
		});
		await automations.started('run-1');

		expect(planProfileEviction(await index.snapshot(now), now)).toEqual([]);
		await index.releaseOwner('leader');
		// Both kinds survive leader death until their durable state becomes terminal.
		expect(planProfileEviction(await index.snapshot(now), now)).toEqual([]);
		await automations.settled('run-1');
		expect(planProfileEviction(await index.snapshot(now), now).map(({ partitionId }) => partitionId)).toEqual([
			'automation',
			'automation'
		]);
		// A promoted leader can clear the stable mutation lease without the dead owner's handle.
		await createReplicaProfileIndex(memory.store).releaseLease(pending.id);
		expect(
			planProfileEviction(await index.snapshot(now), now).some(
				({ partitionId }) => partitionId === 'pending'
			)
		).toBe(true);
	});

	it('adopts and reconciles durable running-automation leases after leader promotion', async () => {
		const memory = memoryStore();
		const index = createReplicaProfileIndex(memory.store);
		await index.notePartition({
			id: 'partition',
			organization: 'org',
			tier: 'opfs',
			location: 'opfs-ahp://bolt-replica::partition',
			accountedBytes: 0,
			lastAccess: 1
		});
		const first = createRunningAutomationLeaseHooks({
			index,
			ownerId: 'old-leader',
			partitionId: 'partition'
		});
		await first.started('still-running');
		await first.started('finished-while-away');
		await index.releaseOwner('old-leader');

		const promoted = createRunningAutomationLeaseHooks({
			index: createReplicaProfileIndex(memory.store),
			ownerId: 'promoted-leader',
			partitionId: 'partition'
		});
		await promoted.reconcile({ complete: true, activeTaskIds: ['still-running'] });
		expect((await index.snapshot()).leases).toEqual([
			expect.objectContaining({
				ownerId: 'promoted-leader',
				kind: 'running-automation',
				expiresAt: null
			})
		]);
	});

	it('expires killed-tab leases, while an explicit unmount releases immediately', async () => {
		const memory = memoryStore();
		const index = createReplicaProfileIndex(memory.store);
		await index.notePartition({
			id: 'partition',
			organization: 'org',
			tier: 'indexeddb',
			location: 'idb://partition',
			accountedBytes: 100,
			lastAccess: 1
		});
		await index.replaceWindows('partition', [window('window', 1)]);
		const visible = await index.lease({
			ownerId: 'tab',
			partitionId: 'partition',
			windowId: 'window',
			kind: 'visible-window',
			now: 1_000,
			ttlMillis: 5_000
		});
		expect(planProfileEviction(await index.snapshot(1_001), 1_001)).toEqual([]);
		await visible.release();
		await visible.release();
		await visible.renew(1_002);
		expect(planProfileEviction(await index.snapshot(1_001), 1_001)).toHaveLength(2);

		await index.lease({
			ownerId: 'dead-tab',
			partitionId: 'partition',
			windowId: 'window',
			kind: 'visible-window',
			now: 2_000,
			ttlMillis: 5_000
		});
		expect(planProfileEviction(await index.snapshot(7_001), 7_001)).toHaveLength(2);
	});

	it('atomically reserves eviction against a window becoming visible in another tab', async () => {
		const memory = memoryStore();
		const index = createReplicaProfileIndex(memory.store);
		await index.notePartition({
			id: 'partition',
			organization: 'org',
			tier: 'opfs',
			location: 'opfs-ahp://partition',
			accountedBytes: 100,
			lastAccess: 1
		});
		await index.replaceWindows('partition', [window('window', 1)]);
		const candidate = planProfileEviction(await index.snapshot(100), 100)[0];
		if (candidate === undefined) throw new Error('expected an eviction candidate');
		const claim = await index.claimCandidate(candidate, 100);
		expect(claim).toBeDefined();
		await expect(
			index.lease({
				ownerId: 'new-tab',
				partitionId: 'partition',
				windowId: 'window',
				kind: 'visible-window',
				now: 101
			})
		).rejects.toThrow('eviction is already in progress');

		await claim?.release();
		const visible = await index.lease({
			ownerId: 'new-tab',
			partitionId: 'partition',
			windowId: 'window',
			kind: 'visible-window',
			now: 102
		});
		expect(await index.claimCandidate(candidate, 103)).toBeUndefined();
		await visible.release();
	});

	it('uses fresh physical measurements to reach 70% and refuses unknown protection state', async () => {
		const budget = storageBudgetFor('opfs', { usage: 0, quota: 1_000 });
		const snapshot = {
			partitions: [
				{
					id: 'one',
					organization: 'one',
					tier: 'opfs' as const,
					location: 'opfs-ahp://one',
					accountedBytes: 300,
					lastAccess: 1
				}
			],
			windows: [
				{ id: 'window-a', partitionId: 'one', kind: 'window' as const, accountedBytes: 100, lastAccess: 1 },
				{ id: 'window-b', partitionId: 'one', kind: 'window' as const, accountedBytes: 200, lastAccess: 2 }
			],
			leases: [],
			protectionKnown: true
		};
		const readings = [850, 760, 690];
		const released: Array<string> = [];
		const result = await enforceProfileReplicaBudget(
			budget,
			async () => {
				const usage = readings.shift();
				return usage === undefined ? { quota: 1_000 } : { usage, quota: 1_000 };
			},
			snapshot,
			async ({ id }) => {
				released.push(id);
			},
			100
		);
		expect(result.complete).toBe(true);
		expect(released).toEqual(['window-a', 'window-b']);

		const unknown = await enforceProfileReplicaBudget(
			budget,
			async () => ({ usage: 850, quota: 1_000 }),
			{ ...snapshot, protectionKnown: false },
			async () => {
				throw new Error('must not release');
			},
			100
		);
		expect(unknown).toMatchObject({ triggered: true, complete: false, released: [] });
	});
});
