/** The physical ceiling promised by the architecture, shared by every partition in one origin. */
const MAX_PROFILE_REPLICA_BYTES = 10 * 1024 * 1024 * 1024;
/** IndexedDB's VFS is memory-amplifying, so it is deliberately capped far below the OPFS tier. */
const MAX_INDEXEDDB_REPLICA_BYTES = 512 * 1024 * 1024;
const MIN_INDEXEDDB_REPLICA_BYTES = 64 * 1024 * 1024;
const EVICT_AT_RATIO = 0.8;
const EVICT_TO_RATIO = 0.7;

export type PersistentReplicaTier = 'opfs' | 'indexeddb';
export type ReplicaStorageTier = PersistentReplicaTier | 'server-only';

type PhysicalStorageEstimate = Readonly<{
	readonly usage: number;
	readonly quota: number;
}>;

export type ReplicaStorageBudget = Readonly<{
	readonly tier: PersistentReplicaTier;
	/** The effective physical cap across every Bolt partition in this browser origin. */
	readonly ceilingBytes: number;
	readonly evictAtBytes: number;
	readonly evictToBytes: number;
}>;

export type ReplicaStorageDecision =
	| Readonly<{ readonly tier: 'server-only'; readonly reason: string }>
	| Readonly<{
			readonly tier: PersistentReplicaTier;
			readonly estimate: PhysicalStorageEstimate;
			readonly budget: ReplicaStorageBudget;
	  }>;

type ReplicaStorageEnvironment = Readonly<{
	readonly estimate?: (() => Promise<Readonly<{ usage?: number; quota?: number }>>) | undefined;
	readonly opfs: boolean;
	readonly indexeddb: boolean;
	/** Replication leadership is mandatory for either writable local tier. */
	readonly webLocks: boolean;
}>; 

const finiteBytes = (value: number | undefined): number | undefined =>
	value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

/**
 * Computes the tier's thresholds from a *physical* browser estimate.
 *
 * `usage` includes WAL, indexes and filesystem fragmentation (and conservatively other origin data),
 * unlike summing serialized rows. OPFS can use the architecture's 10 GiB ceiling. IndexedDB gets an
 * adaptive tenth of what the browser grants, floored for utility and capped at 512 MiB because its
 * VFS loads the database into memory.
 */
export const storageBudgetFor = (
	tier: PersistentReplicaTier,
	estimate: PhysicalStorageEstimate
): ReplicaStorageBudget => {
	const ceilingBytes =
		tier === 'opfs'
			? Math.min(MAX_PROFILE_REPLICA_BYTES, estimate.quota)
			: Math.min(
					estimate.quota,
					MAX_INDEXEDDB_REPLICA_BYTES,
					Math.max(MIN_INDEXEDDB_REPLICA_BYTES, Math.floor(estimate.quota * 0.1))
				);
	return {
		tier,
		ceilingBytes,
		evictAtBytes: Math.floor(ceilingBytes * EVICT_AT_RATIO),
		evictToBytes: Math.floor(ceilingBytes * EVICT_TO_RATIO)
	};
};

/**
 * Selects OPFS when it is actually available, otherwise the smaller IndexedDB tier, otherwise the
 * always-correct server-only path. An unknown quota cannot be budgeted honestly and therefore does
 * not opt into persistence.
 */
export const selectReplicaStorage = async (
	environment: ReplicaStorageEnvironment = {
		estimate:
			typeof navigator !== 'undefined' && typeof navigator.storage?.estimate === 'function'
				? () => navigator.storage.estimate()
				: undefined,
		opfs:
			typeof navigator !== 'undefined' &&
			navigator.storage !== undefined &&
			typeof Reflect.get(navigator.storage, 'getDirectory') === 'function' &&
			(() => {
				const handle = Reflect.get(globalThis, 'FileSystemFileHandle');
				return (
					typeof handle === 'function' &&
					typeof Reflect.get(handle.prototype as object, 'createSyncAccessHandle') === 'function'
				);
			})(),
		indexeddb: typeof indexedDB !== 'undefined',
		webLocks:
			typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function'
	}
): Promise<ReplicaStorageDecision> => {
	if (!environment.webLocks)
		return { tier: 'server-only', reason: 'Web Locks replication leadership is unavailable' };
	if (environment.estimate === undefined)
		return { tier: 'server-only', reason: 'Physical storage quota is unavailable' };
	let estimated: Readonly<{ usage?: number; quota?: number }>;
	try {
		estimated = await environment.estimate();
	} catch {
		return { tier: 'server-only', reason: 'Physical storage quota could not be read' };
	}
	const usage = finiteBytes(estimated.usage);
	const quota = finiteBytes(estimated.quota);
	if (usage === undefined)
		return { tier: 'server-only', reason: 'Physical storage usage could not be measured' };
	if (quota === undefined || quota === 0)
		return { tier: 'server-only', reason: 'The browser granted no persistent storage quota' };
	// The physical database may live in OPFS, but the small profile-wide directory of partitions and
	// leases lives in IndexedDB. Without that shared durable control plane there is no correct way to
	// enforce one ceiling across databases, so an otherwise usable OPFS implementation is not enough.
	const tier =
		environment.opfs && environment.indexeddb
			? 'opfs'
			: environment.indexeddb
				? 'indexeddb'
				: undefined;
	if (tier === undefined)
		return { tier: 'server-only', reason: 'No supported persistent browser filesystem is available' };
	const estimate = { usage, quota };
	return { tier, estimate, budget: storageBudgetFor(tier, estimate) };
};

type ReplicaEvictionResult = Readonly<{
	readonly triggered: boolean;
	readonly beforeBytes: number;
	readonly afterBytes: number;
	readonly released: ReadonlyArray<string>;
}>;

type ReplicaProfileEvictionKind = 'window' | 'partition';
export type ReplicaLeaseKind =
	| 'visible-window'
	| 'active-tab'
	| 'pending-mutation'
	| 'running-automation';

/** One physical PGlite database recorded in the browser-profile directory. */
export type ReplicaProfilePartition = Readonly<{
	readonly id: string;
	readonly organization: string;
	readonly tier: PersistentReplicaTier;
	/** Exact PGlite dataDir; required for an injected inactive-partition deletion adapter. */
	readonly location: string;
	/** Durable accounting only. Physical profile usage still comes from StorageManager.estimate(). */
	readonly accountedBytes: number;
	readonly lastAccess: number;
}>;

/** One canonical window known to the profile directory. Base rows and proof facts remain in PGlite. */
export type ReplicaProfileWindow = Readonly<{
	readonly id: string;
	readonly partitionId: string;
	readonly kind: 'window';
	readonly accountedBytes: number;
	readonly lastAccess: number;
}>;

/**
 * Pending mutations and running automations have no time-based expiry: only their durable terminal
 * state releases them. Browser-owned visibility/tab leases expire after a killed document.
 */
export type ReplicaProfileLease = Readonly<{
	readonly id: string;
	readonly ownerId: string;
	readonly partitionId: string;
	readonly windowId?: string;
	readonly kind: ReplicaLeaseKind;
	readonly expiresAt: number | null;
}>;

export type ReplicaProfileSnapshot = Readonly<{
	readonly partitions: ReadonlyArray<ReplicaProfilePartition>;
	readonly windows: ReadonlyArray<ReplicaProfileWindow>;
	readonly leases: ReadonlyArray<ReplicaProfileLease>;
	/** False if any profile record could not be decoded or protection state could not be read. */
	readonly protectionKnown: boolean;
}>;

export type ReplicaProfileEvictionCandidate = Readonly<{
	readonly id: string;
	readonly partitionId: string;
	readonly organization: string;
	readonly tier: PersistentReplicaTier;
	readonly location: string;
	readonly kind: ReplicaProfileEvictionKind;
	readonly lastAccess: number;
	readonly accountedBytes: number;
}>;

const leaseActiveAt = (lease: ReplicaProfileLease, now: number): boolean =>
	lease.expiresAt === null || lease.expiresAt > now;

/**
 * Produces the only legal eviction order from a durable profile snapshot.
 *
 * A partition lease protects all of its windows. A window lease protects only that materialization.
 * Unknown or malformed protection state returns no candidates: availability may fall back to the
 * server, while destructive eviction must never infer that a missing lease is an absent lease.
 */
export const planProfileEviction = (
	snapshot: ReplicaProfileSnapshot,
	now = Date.now()
): ReadonlyArray<ReplicaProfileEvictionCandidate> => {
	if (!snapshot.protectionKnown) return [];
	const partitions = new Map(snapshot.partitions.map((partition) => [partition.id, partition]));
	const activeLeases = snapshot.leases.filter((lease) => leaseActiveAt(lease, now));
	const partitionWideLeases = new Set(
		activeLeases
			.filter(
				(lease) =>
					lease.kind === 'pending-mutation' ||
					lease.kind === 'running-automation'
			)
			.map((lease) => lease.partitionId)
	);
	// Active-tab and visible-window leases are narrower than mutation/automation leases: cold
	// unmounted windows in an open partition may leave, but the physical database may not.
	const partitionsWithAnyLease = new Set(activeLeases.map((lease) => lease.partitionId));
	const protectedWindows = new Set(
		activeLeases
			.filter((lease) => lease.kind === 'visible-window' && lease.windowId !== undefined)
			.map((lease) => `${lease.partitionId}\u0000${lease.windowId}`)
	);

	const windows: Array<ReplicaProfileEvictionCandidate> = [];
	for (const window of snapshot.windows) {
		const partition = partitions.get(window.partitionId);
		if (partition === undefined || partitionWideLeases.has(window.partitionId)) continue;
		if (protectedWindows.has(`${window.partitionId}\u0000${window.id}`)) continue;
		windows.push({
			id: window.id,
			partitionId: window.partitionId,
			organization: partition.organization,
			tier: partition.tier,
			location: partition.location,
			kind: 'window',
			lastAccess: window.lastAccess,
			accountedBytes: window.accountedBytes
		});
	}

	const inactivePartitions = snapshot.partitions
		.filter((partition) => !partitionsWithAnyLease.has(partition.id))
		.map(
			(partition): ReplicaProfileEvictionCandidate => ({
				id: partition.id,
				partitionId: partition.id,
				organization: partition.organization,
				tier: partition.tier,
				location: partition.location,
				kind: 'partition',
				lastAccess: partition.lastAccess,
				accountedBytes: partition.accountedBytes
			})
		);

	const rank = (kind: ReplicaProfileEvictionKind): number => kind === 'window' ? 0 : 1;
	return [...windows, ...inactivePartitions].toSorted(
		(left, right) =>
			rank(left.kind) - rank(right.kind) ||
			left.lastAccess - right.lastAccess ||
			right.accountedBytes - left.accountedBytes ||
			left.partitionId.localeCompare(right.partitionId) ||
			left.id.localeCompare(right.id)
	);
};

export type ReplicaProfileEvictionResult = ReplicaEvictionResult &
	Readonly<{
		readonly complete: boolean;
		readonly releasedCandidates: ReadonlyArray<ReplicaProfileEvictionCandidate>;
	}>;

/**
 * Enforces the shared physical budget. Candidate accounting only orders equal-LRU work; every stop
 * decision is made from a fresh browser physical-usage reading after the release has completed.
 */
export const enforceProfileReplicaBudget = async (
	budget: ReplicaStorageBudget,
	estimate: () => Promise<Readonly<{ usage?: number; quota?: number }>>,
	snapshot: ReplicaProfileSnapshot,
	release: (candidate: ReplicaProfileEvictionCandidate) => Promise<void>,
	now = Date.now()
): Promise<ReplicaProfileEvictionResult> => {
	const beforeBytes = finiteBytes((await estimate()).usage);
	if (beforeBytes === undefined) {
		return {
			triggered: false,
			complete: false,
			beforeBytes: 0,
			afterBytes: 0,
			released: [],
			releasedCandidates: []
		};
	}
	if (beforeBytes < budget.evictAtBytes) {
		return {
			triggered: false,
			complete: true,
			beforeBytes,
			afterBytes: beforeBytes,
			released: [],
			releasedCandidates: []
		};
	}

	let afterBytes = beforeBytes;
	const releasedCandidates: Array<ReplicaProfileEvictionCandidate> = [];
	for (const candidate of planProfileEviction(snapshot, now)) {
		if (afterBytes <= budget.evictToBytes) break;
		await release(candidate);
		releasedCandidates.push(candidate);
		const measured = finiteBytes((await estimate()).usage);
		// An unknown post-release reading cannot prove that continuing is necessary or safe.
		if (measured === undefined) break;
		afterBytes = measured;
	}
	return {
		triggered: true,
		complete: afterBytes <= budget.evictToBytes,
		beforeBytes,
		afterBytes,
		released: releasedCandidates.map(({ id }) => id),
		releasedCandidates
	};
};
