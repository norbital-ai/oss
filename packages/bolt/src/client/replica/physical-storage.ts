import type {
	PersistentReplicaTier,
	ReplicaProfileEvictionCandidate
} from '#lib/client/replica/budget.js';
import { replicaPartitionKey, type ReplicaPartitionIdentity } from '#lib/client/replica/leader.js';

/** Pure physical location derivation, kept out of the deferred PGlite loader dependency graph. */
export const replicaLocation = (
	scope: string | ReplicaPartitionIdentity,
	tier: PersistentReplicaTier = 'indexeddb'
): string => {
	const key =
		typeof scope === 'string'
			? scope.replaceAll(/[^a-zA-Z0-9:_-]/g, '_')
			: replicaPartitionKey(scope);
	return `${tier === 'opfs' ? 'opfs-ahp' : 'idb'}://bolt-replica::${key}`;
};

type ReplicaStorageWebLock = Readonly<{ readonly name: string }>;

/** Web Locks surface shared by the browser implementation and deterministic focused tests. */
export type ReplicaStorageLockManager = Readonly<{
	request: <Value>(
		name: string,
		options: Readonly<{
			readonly mode: 'shared' | 'exclusive';
			readonly ifAvailable?: boolean;
			readonly signal?: AbortSignal;
		}>,
		callback: (lock: ReplicaStorageWebLock | null) => Value | PromiseLike<Value>
	) => Promise<Value>;
}>;

export const replicaPhysicalStorageLockName = (partitionId: string): string => {
	if (partitionId.length === 0) throw new Error('Replica physical partition id cannot be empty');
	return `bolt-replica-storage:${partitionId}`;
};

export type ReplicaPhysicalPartitionLease = Readonly<{
	readonly name: string;
	/** Resolves only after an earlier deletion has left the physical location. */
	readonly ready: Promise<void>;
	/** Release only after PGlite has fully closed its worker client and filesystem handles. */
	readonly stop: () => Promise<void>;
}>;

/**
 * Holds a shared browser-owned lock for the entire lifetime of one open PGlite location.
 *
 * Every tab holds this lock, independently from replication leadership. Eviction asks for the same
 * lock exclusively, so it cannot remove a database that a follower tab or surviving worker uses.
 */
export const openReplicaPhysicalPartitionLease = (
	partitionId: string,
	locks: ReplicaStorageLockManager
): ReplicaPhysicalPartitionLease => {
	const name = replicaPhysicalStorageLockName(partitionId);
	const abort = new AbortController();
	let active = true;
	let release: () => void = () => undefined;
	let resolveReady: () => void = () => undefined;
	let rejectReady: (cause: unknown) => void = () => undefined;
	let readySettled = false;
	const ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	const settleReady = (cause?: unknown): void => {
		if (readySettled) return;
		readySettled = true;
		if (cause === undefined) resolveReady();
		else rejectReady(cause);
	};
	const held = locks
		.request(name, { mode: 'shared', signal: abort.signal }, async (lock) => {
			if (lock === null || !active) {
				settleReady(new Error('Replica physical partition lock was not acquired'));
				return;
			}
			settleReady();
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		})
		.catch((cause) => settleReady(cause));
	return {
		name,
		ready,
		stop: async () => {
			if (!active) return held;
			active = false;
			abort.abort();
			release();
			settleReady(new Error('Replica physical partition lease stopped before acquisition'));
			await held;
		}
	};
};

export type ParsedPGliteLocation = Readonly<{
	readonly tier: 'opfs' | 'indexeddb';
	/** Direct child name used by PGlite after stripping its dataDir protocol. */
	readonly name: string;
}>;

/** Bolt creates one direct OPFS directory / IDB database, never an arbitrary browser path. */
export const parseReplicaPGliteLocation = (location: string): ParsedPGliteLocation => {
	const parsed = location.startsWith('opfs-ahp://')
		? { tier: 'opfs' as const, name: location.slice('opfs-ahp://'.length) }
		: location.startsWith('idb://')
			? { tier: 'indexeddb' as const, name: location.slice('idb://'.length) }
			: undefined;
	if (
		parsed === undefined ||
		parsed.name.length === 0 ||
		parsed.name === '.' ||
		parsed.name === '..' ||
		parsed.name.includes('/') ||
		parsed.name.includes('\\') ||
		parsed.name.includes('\u0000') ||
		!parsed.name.startsWith('bolt-replica::')
	) {
		throw new Error('Refusing to delete an invalid PGlite replica location');
	}
	return parsed;
};

type OpfsDirectory = Readonly<{
	removeEntry: (name: string, options: Readonly<{ readonly recursive: true }>) => Promise<void>;
}>;

export type ReplicaPhysicalStorageEnvironment = Readonly<{
	readonly locks: ReplicaStorageLockManager;
	readonly opfsRoot: () => Promise<OpfsDirectory>;
	readonly indexeddb: IDBFactory;
}>;

const notFound = (cause: unknown): boolean =>
	typeof DOMException !== 'undefined' &&
	cause instanceof DOMException &&
	cause.name === 'NotFoundError';

const deleteIndexedDatabase = (factory: IDBFactory, name: string): Promise<void> =>
	new Promise((resolve, reject) => {
		const request = factory.deleteDatabase(name);
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error ?? new Error('PGlite IndexedDB deletion failed'));
		// Deliberately do not reject `blocked`: deleteDatabase cannot be cancelled. Keeping this promise
		// and the exclusive Web Lock pending is the only safe response until a stale connection closes.
		request.onblocked = () => undefined;
	});

export class ReplicaPhysicalPartitionBusy extends Error {
	readonly partitionId: string;

	constructor(partitionId: string) {
		super('Replica physical partition is active in another browser context');
		this.partitionId = partitionId;
		this.name = 'ReplicaPhysicalPartitionBusy';
	}
}

/**
 * Concrete idempotent deletion callback for `StartLocalReplicaOptions.deleteInactiveReplicaPartition`.
 * The profile-index eviction claim prevents new logical leases while this exclusive physical lock
 * proves no tab still has PGlite open.
 */
export const deleteInactivePGlitePartition = async (
	candidate: ReplicaProfileEvictionCandidate,
	environment?: ReplicaPhysicalStorageEnvironment
): Promise<void> => {
	const activeEnvironment =
		environment ??
		((): ReplicaPhysicalStorageEnvironment => {
			if (
				typeof navigator === 'undefined' ||
				typeof navigator.locks?.request !== 'function' ||
				typeof globalThis.indexedDB === 'undefined'
			) {
				throw new Error('Browser physical replica deletion is unavailable');
			}
			const getDirectory =
				navigator.storage === undefined
					? undefined
					: Reflect.get(navigator.storage, 'getDirectory');
			return {
				locks: navigator.locks as unknown as ReplicaStorageLockManager,
				opfsRoot: () =>
					typeof getDirectory === 'function'
						? (Reflect.apply(getDirectory, navigator.storage, []) as Promise<OpfsDirectory>)
						: Promise.reject(new Error('Browser OPFS deletion is unavailable')),
				indexeddb: globalThis.indexedDB
			};
		})();
	if (candidate.kind !== 'partition') {
		throw new Error('Physical PGlite deletion requires a whole-partition candidate');
	}
	const location = parseReplicaPGliteLocation(candidate.location);
	if (location.tier !== candidate.tier) {
		throw new Error('Replica candidate tier does not match its physical location');
	}
	const name = replicaPhysicalStorageLockName(candidate.partitionId);
	await activeEnvironment.locks.request(
		name,
		{ mode: 'exclusive', ifAvailable: true },
		async (lock) => {
			if (lock === null) throw new ReplicaPhysicalPartitionBusy(candidate.partitionId);
			if (location.tier === 'opfs') {
				try {
					await (
						await activeEnvironment.opfsRoot()
					).removeEntry(location.name, { recursive: true });
				} catch (cause) {
					if (!notFound(cause)) throw cause;
				}
				return;
			}
			await deleteIndexedDatabase(activeEnvironment.indexeddb, location.name);
		}
	);
};
