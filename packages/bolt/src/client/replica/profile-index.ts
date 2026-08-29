import { enforceProfileReplicaBudget, planProfileEviction } from '#lib/client/replica/budget.js';
import type {
	PersistentReplicaTier,
	ReplicaLeaseKind,
	ReplicaProfileEvictionCandidate,
	ReplicaProfileLease,
	ReplicaProfilePartition,
	ReplicaProfileWindow,
	ReplicaProfileSnapshot,
	ReplicaProfileEvictionResult,
	ReplicaStorageBudget
} from '#lib/client/replica/budget.js';

/** IndexedDB is the tiny, shared control plane even when the PGlite data files live in OPFS. */
export const REPLICA_PROFILE_INDEX_DATABASE = 'bolt-replica-profile-v2';
const STORE = 'profile';
const STATE_KEY = 'state';
export const DEFAULT_REPLICA_LEASE_MILLIS = 45_000;
const EVICTION_CLAIM_MILLIS = 5 * 60_000;

/** The same logical identity may leave one old IDB database while a later browser opens OPFS. */
export const replicaProfilePartitionId = (
	partitionKey: string,
	tier: PersistentReplicaTier
): string => `${tier}:${partitionKey}`;

export const partitionKeyFromReplicaProfileId = (
	partitionId: string,
	tier: PersistentReplicaTier
): string | undefined => {
	const prefix = `${tier}:`;
	return partitionId.startsWith(prefix) && partitionId.length > prefix.length
		? partitionId.slice(prefix.length)
		: undefined;
};

type ReplicaEvictionClaim = Readonly<{
	readonly id: string;
	readonly partitionId: string;
	readonly candidateId: string;
	readonly kind: ReplicaProfileEvictionCandidate['kind'];
	readonly expiresAt: number;
}>;

type StoredProfileState = Readonly<{
	readonly version: 2;
	readonly partitions: ReadonlyArray<ReplicaProfilePartition>;
	readonly windows: ReadonlyArray<ReplicaProfileWindow>;
	readonly leases: ReadonlyArray<ReplicaProfileLease>;
	readonly claims: ReadonlyArray<ReplicaEvictionClaim>;
}>;

const emptyState = (): StoredProfileState => ({
	version: 2,
	partitions: [],
	windows: [],
	leases: [],
	claims: []
});

const finiteNonNegative = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0;
const finiteTime = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value);
const nonEmptyString = (value: unknown): value is string =>
	typeof value === 'string' && value.length > 0;

const decodePartition = (value: unknown): ReplicaProfilePartition | undefined => {
	if (value === null || typeof value !== 'object') return undefined;
	const record = value as Record<string, unknown>;
	return nonEmptyString(record['id']) &&
		nonEmptyString(record['organization']) &&
		(record['tier'] === 'opfs' || record['tier'] === 'indexeddb') &&
		nonEmptyString(record['location']) &&
		finiteNonNegative(record['accountedBytes']) &&
		finiteTime(record['lastAccess'])
		? {
				id: record['id'],
				organization: record['organization'],
				tier: record['tier'],
				location: record['location'],
				accountedBytes: record['accountedBytes'],
				lastAccess: record['lastAccess']
			}
		: undefined;
};

const decodeWindow = (value: unknown): ReplicaProfileWindow | undefined => {
	if (value === null || typeof value !== 'object') return undefined;
	const record = value as Record<string, unknown>;
	return nonEmptyString(record['id']) &&
		nonEmptyString(record['partitionId']) &&
		record['kind'] === 'window' &&
		finiteNonNegative(record['accountedBytes']) &&
		finiteTime(record['lastAccess'])
		? {
				id: record['id'],
				partitionId: record['partitionId'],
				kind: record['kind'],
				accountedBytes: record['accountedBytes'],
				lastAccess: record['lastAccess']
			}
		: undefined;
};

const leaseKinds = new Set<ReplicaLeaseKind>([
	'visible-window',
	'active-tab',
	'pending-mutation',
	'running-automation'
]);
const decodeLease = (value: unknown): ReplicaProfileLease | undefined => {
	if (value === null || typeof value !== 'object') return undefined;
	const record = value as Record<string, unknown>;
	const kind = record['kind'];
	const windowId = record['windowId'];
	const expiresAt = record['expiresAt'];
	return nonEmptyString(record['id']) &&
		nonEmptyString(record['ownerId']) &&
		nonEmptyString(record['partitionId']) &&
		typeof kind === 'string' &&
		leaseKinds.has(kind as ReplicaLeaseKind) &&
		(windowId === undefined || nonEmptyString(windowId)) &&
		(expiresAt === null || finiteTime(expiresAt)) &&
		(kind !== 'visible-window' || nonEmptyString(windowId)) &&
		((kind !== 'pending-mutation' && kind !== 'running-automation') || expiresAt === null)
		? {
				id: record['id'],
				ownerId: record['ownerId'],
				partitionId: record['partitionId'],
				...(windowId === undefined ? {} : { windowId }),
				kind: kind as ReplicaLeaseKind,
				expiresAt
			}
		: undefined;
};

const decodeClaim = (value: unknown): ReplicaEvictionClaim | undefined => {
	if (value === null || typeof value !== 'object') return undefined;
	const record = value as Record<string, unknown>;
	return nonEmptyString(record['id']) &&
		nonEmptyString(record['partitionId']) &&
		nonEmptyString(record['candidateId']) &&
		(record['kind'] === 'window' || record['kind'] === 'partition') &&
		finiteTime(record['expiresAt'])
		? {
				id: record['id'],
				partitionId: record['partitionId'],
				candidateId: record['candidateId'],
				kind: record['kind'],
				expiresAt: record['expiresAt']
			}
		: undefined;
};

const decodeState = (
	value: unknown
): Readonly<{ readonly state: StoredProfileState; readonly known: boolean }> => {
	if (value === undefined) return { state: emptyState(), known: true };
	if (value === null || typeof value !== 'object') return { state: emptyState(), known: false };
	const record = value as Record<string, unknown>;
	if (
		record['version'] !== 2 ||
		!Array.isArray(record['partitions']) ||
		!Array.isArray(record['windows']) ||
		!Array.isArray(record['leases'])
	) {
		return { state: emptyState(), known: false };
	}
	const partitions = record['partitions'].map(decodePartition);
	const windows = record['windows'].map(decodeWindow);
	const leases = record['leases'].map(decodeLease);
	const claims = Array.isArray(record['claims']) ? record['claims'].map(decodeClaim) : [];
	const uniquePartitions =
		new Set(partitions.flatMap((entry) => (entry === undefined ? [] : [entry.id]))).size ===
		partitions.length;
	const uniqueWindows =
		new Set(
			windows.flatMap((entry) =>
				entry === undefined ? [] : [`${entry.partitionId}\u0000${entry.id}`]
			)
		).size === windows.length;
	const uniqueLeases =
		new Set(leases.flatMap((entry) => (entry === undefined ? [] : [entry.id]))).size ===
		leases.length;
	const uniqueClaims =
		new Set(claims.flatMap((entry) => (entry === undefined ? [] : [entry.id]))).size ===
		claims.length;
	if (
		partitions.some((entry) => entry === undefined) ||
		windows.some((entry) => entry === undefined) ||
		leases.some((entry) => entry === undefined) ||
		claims.some((entry) => entry === undefined) ||
		!uniquePartitions ||
		!uniqueWindows ||
		!uniqueLeases ||
		!uniqueClaims
	) {
		return { state: emptyState(), known: false };
	}
	return {
		state: {
			version: 2,
			partitions: partitions as ReadonlyArray<ReplicaProfilePartition>,
			windows: windows as ReadonlyArray<ReplicaProfileWindow>,
			leases: leases as ReadonlyArray<ReplicaProfileLease>,
			claims: claims as ReadonlyArray<ReplicaEvictionClaim>
		},
		known: true
	};
};

/** Atomic state port. Its browser implementation uses one IndexedDB read/write transaction. */
export type ReplicaProfileStateStore = Readonly<{
	readonly read: () => Promise<unknown>;
	readonly update: <Value>(
		change: (current: unknown) => Readonly<{ readonly state: unknown; readonly value: Value }>
	) => Promise<Value>;
	readonly close: () => void;
}>;

export type ReplicaLeaseHandle = Readonly<{
	readonly id: string;
	/** Heartbeats every expiring lease owned by this document or leader. */
	readonly renew: (now?: number) => Promise<void>;
	/** Unmount/completion releases this exact lease immediately. */
	readonly release: () => Promise<void>;
}>;

type ReplicaEvictionClaimHandle = Readonly<{
	readonly commit: () => Promise<void>;
	readonly release: () => Promise<void>;
}>;

export type ReplicaProfileIndex = Readonly<{
	readonly snapshot: (now?: number) => Promise<ReplicaProfileSnapshot>;
	readonly notePartition: (partition: ReplicaProfilePartition) => Promise<void>;
	readonly replaceWindows: (
		partitionId: string,
		windows: ReadonlyArray<Omit<ReplicaProfileWindow, 'partitionId'>>
	) => Promise<void>;
	readonly lease: (input: {
		readonly id?: string;
		readonly ownerId: string;
		readonly partitionId: string;
		readonly windowId?: string;
		readonly kind: ReplicaLeaseKind;
		readonly ttlMillis?: number;
		readonly now?: number;
	}) => Promise<ReplicaLeaseHandle>;
	readonly renewOwner: (ownerId: string, now?: number) => Promise<void>;
	/** A new leader acknowledges a durable pending mutation by its stable lease id. */
	readonly releaseLease: (leaseId: string) => Promise<void>;
	/** Leader/tab death releases expiring leases; durable mutation/automation work survives. */
	readonly releaseOwner: (ownerId: string) => Promise<void>;
	/** Atomically rechecks protection and reserves a candidate against newly arriving leases. */
	readonly claimCandidate: (
		candidate: ReplicaProfileEvictionCandidate,
		now?: number
	) => Promise<ReplicaEvictionClaimHandle | undefined>;
	readonly removeCandidate: (candidate: ReplicaProfileEvictionCandidate) => Promise<void>;
	readonly close: () => void;
}>;

const leaseTtl = (ttlMillis: number | undefined): number => {
	const ttl = ttlMillis ?? DEFAULT_REPLICA_LEASE_MILLIS;
	if (!Number.isFinite(ttl) || ttl < 5_000 || ttl > 5 * 60_000) {
		throw new Error('Replica lease TTL must be between 5 seconds and 5 minutes');
	}
	return Math.floor(ttl);
};

const pruneExpired = (state: StoredProfileState, now: number): StoredProfileState => ({
	...state,
	leases: state.leases.filter((lease) => lease.expiresAt === null || lease.expiresAt > now),
	claims: state.claims.filter((claim) => claim.expiresAt > now)
});

const withoutCandidate = (
	state: StoredProfileState,
	candidate: ReplicaProfileEvictionCandidate
): StoredProfileState =>
	candidate.kind === 'partition'
		? {
				...state,
				partitions: state.partitions.filter(({ id }) => id !== candidate.partitionId),
				windows: state.windows.filter(({ partitionId }) => partitionId !== candidate.partitionId),
				leases: state.leases.filter(({ partitionId }) => partitionId !== candidate.partitionId),
				claims: state.claims.filter(({ partitionId }) => partitionId !== candidate.partitionId)
			}
		: {
				...state,
				windows: state.windows.filter(
					(window) => window.partitionId !== candidate.partitionId || window.id !== candidate.id
				),
				leases: state.leases.filter(
					(lease) => lease.partitionId !== candidate.partitionId || lease.windowId !== candidate.id
				),
				claims: state.claims.filter(
					(claim) =>
						claim.partitionId !== candidate.partitionId || claim.candidateId !== candidate.id
				)
			};

/** Shared policy over IndexedDB in production and a deterministic store in focused tests. */
export const createReplicaProfileIndex = (store: ReplicaProfileStateStore): ReplicaProfileIndex => {
	const updateKnown = async <Value>(
		change: (
			state: StoredProfileState
		) => Readonly<{ readonly state: StoredProfileState; readonly value: Value }>
	): Promise<Value> =>
		store.update((raw) => {
			const decoded = decodeState(raw);
			if (!decoded.known) throw new Error('Replica profile index is unreadable; refusing mutation');
			return change(decoded.state);
		});

	return {
		snapshot: async (now = Date.now()) => {
			const decoded = decodeState(await store.read());
			if (!decoded.known) {
				return { partitions: [], windows: [], leases: [], protectionKnown: false };
			}
			const state = pruneExpired(decoded.state, now);
			const partitionIds = new Set(state.partitions.map(({ id }) => id));
			const windowKeys = new Set(
				state.windows.map(({ partitionId, id }) => `${partitionId}\u0000${id}`)
			);
			const referencesKnown =
				state.windows.every(({ partitionId }) => partitionIds.has(partitionId)) &&
				state.leases.every(
					(lease) =>
						partitionIds.has(lease.partitionId) &&
						(lease.windowId === undefined ||
							windowKeys.has(`${lease.partitionId}\u0000${lease.windowId}`))
				) &&
				state.claims.every(
					(claim) =>
						partitionIds.has(claim.partitionId) &&
						(claim.kind === 'partition' ||
							windowKeys.has(`${claim.partitionId}\u0000${claim.candidateId}`))
				);
			return {
				partitions: state.partitions,
				windows: state.windows,
				leases: state.leases,
				protectionKnown: referencesKnown
			};
		},
		notePartition: async (partition) => {
			if (
				!nonEmptyString(partition.id) ||
				!nonEmptyString(partition.organization) ||
				!nonEmptyString(partition.location) ||
				!finiteNonNegative(partition.accountedBytes) ||
				!finiteTime(partition.lastAccess)
			) {
				throw new Error('Invalid replica profile partition');
			}
			await updateKnown((state) => ({
				state: {
					...state,
					partitions: [...state.partitions.filter(({ id }) => id !== partition.id), partition]
				},
				value: undefined
			}));
		},
		replaceWindows: async (partitionId, windows) => {
			if (!nonEmptyString(partitionId)) throw new Error('Invalid replica partition id');
			const windowIds = new Set(windows.map(({ id }) => id));
			if (
				windows.some(
					(window) =>
						!nonEmptyString(window.id) ||
						!finiteNonNegative(window.accountedBytes) ||
						!finiteTime(window.lastAccess)
				) ||
				windowIds.size !== windows.length
			) {
				throw new Error('Invalid replica profile window');
			}
			await updateKnown((state) => {
				const partition = state.partitions.find(({ id }) => id === partitionId);
				if (partition === undefined) {
					throw new Error('Cannot index windows for an unknown replica partition');
				}
				const accountedBytes = windows.reduce(
					(total, window) => total + Math.floor(window.accountedBytes),
					0
				);
				const lastAccess = windows.reduce(
					(latest, window) => Math.max(latest, window.lastAccess),
					partition.lastAccess
				);
				return {
					state: {
						...state,
						partitions: state.partitions.map((entry) =>
							entry.id === partitionId ? { ...entry, accountedBytes, lastAccess } : entry
						),
						windows: [
							...state.windows.filter((window) => window.partitionId !== partitionId),
							...windows.map((window) => ({ ...window, partitionId }))
						]
					},
					value: undefined
				};
			});
		},
		lease: async (input) => {
			const now = input.now ?? Date.now();
			if (
				!nonEmptyString(input.ownerId) ||
				!nonEmptyString(input.partitionId) ||
				!finiteTime(now) ||
				(input.kind === 'visible-window' && !nonEmptyString(input.windowId))
			) {
				throw new Error('Invalid replica lease');
			}
			const durable = input.kind === 'pending-mutation' || input.kind === 'running-automation';
			const ttl = durable ? undefined : leaseTtl(input.ttlMillis);
			const id =
				input.id ??
				`${input.ownerId}\u0000${input.kind}\u0000${input.partitionId}\u0000${input.windowId ?? ''}`;
			const write = async (at: number): Promise<void> => {
				await updateKnown((state) => {
					const current = pruneExpired(state, at);
					if (!current.partitions.some(({ id: partition }) => partition === input.partitionId)) {
						throw new Error('Cannot lease an unknown replica partition');
					}
					if (
						input.windowId !== undefined &&
						!current.windows.some(
							(window) => window.partitionId === input.partitionId && window.id === input.windowId
						)
					) {
						throw new Error('Cannot lease an unknown replica window');
					}
					if (current.claims.some(({ partitionId }) => partitionId === input.partitionId)) {
						throw new Error('Replica eviction is already in progress for this partition');
					}
					const existing = current.leases.find((entry) => entry.id === id);
					if (
						existing !== undefined &&
						(existing.partitionId !== input.partitionId ||
							existing.windowId !== input.windowId ||
							existing.kind !== input.kind ||
							(!durable && existing.ownerId !== input.ownerId))
					) {
						throw new Error('Replica lease id is already owned by another target');
					}
					const lease: ReplicaProfileLease = {
						id,
						ownerId: input.ownerId,
						partitionId: input.partitionId,
						...(input.windowId === undefined ? {} : { windowId: input.windowId }),
						kind: input.kind,
						expiresAt: ttl === undefined ? null : at + ttl
					};
					return {
						state: {
							...current,
							leases: [...current.leases.filter((entry) => entry.id !== id), lease]
						},
						value: undefined
					};
				});
			};
			await write(now);
			let active = true;
			let tail: Promise<void> = Promise.resolve();
			const serialize = (operation: () => Promise<void>): Promise<void> => {
				const next = tail.then(operation);
				tail = next.catch(() => undefined);
				return next;
			};
			return {
				id,
				renew: (at = Date.now()) =>
					serialize(async () => {
						if (!active) return;
						await write(at);
					}),
				release: () =>
					serialize(async () => {
						if (!active) return;
						await updateKnown((state) => ({
							state: { ...state, leases: state.leases.filter((lease) => lease.id !== id) },
							value: undefined
						}));
						active = false;
					})
			};
		},
		renewOwner: async (ownerId, now = Date.now()) => {
			if (!nonEmptyString(ownerId) || !finiteTime(now))
				throw new Error('Invalid replica lease owner');
			await updateKnown((state) => {
				const current = pruneExpired(state, now);
				return {
					state: {
						...current,
						leases: current.leases.map((lease) =>
							lease.ownerId === ownerId && lease.expiresAt !== null
								? { ...lease, expiresAt: now + DEFAULT_REPLICA_LEASE_MILLIS }
								: lease
						)
					},
					value: undefined
				};
			});
		},
		releaseLease: async (leaseId) => {
			if (!nonEmptyString(leaseId)) throw new Error('Invalid replica lease id');
			await updateKnown((state) => ({
				state: { ...state, leases: state.leases.filter(({ id }) => id !== leaseId) },
				value: undefined
			}));
		},
		releaseOwner: async (ownerId) => {
			if (!nonEmptyString(ownerId)) throw new Error('Invalid replica lease owner');
			await updateKnown((state) => ({
				state: {
					...state,
					leases: state.leases.filter(
						(lease) =>
							lease.ownerId !== ownerId ||
							lease.kind === 'pending-mutation' ||
							lease.kind === 'running-automation'
					)
				},
				value: undefined
			}));
		},
		claimCandidate: async (candidate, now = Date.now()) => {
			if (!finiteTime(now)) throw new Error('Invalid replica eviction claim time');
			const claimId = `${candidate.partitionId}\u0000${candidate.kind}\u0000${candidate.id}`;
			const claimed = await updateKnown((state) => {
				const current = pruneExpired(state, now);
				if (current.claims.some(({ partitionId }) => partitionId === candidate.partitionId)) {
					return { state: current, value: false };
				}
				const legal = planProfileEviction(
					{
						partitions: current.partitions,
						windows: current.windows,
						leases: current.leases,
						protectionKnown: true
					},
					now
				).some(
					(entry) =>
						entry.id === candidate.id &&
						entry.partitionId === candidate.partitionId &&
						entry.kind === candidate.kind
				);
				if (!legal) return { state: current, value: false };
				const claim: ReplicaEvictionClaim = {
					id: claimId,
					partitionId: candidate.partitionId,
					candidateId: candidate.id,
					kind: candidate.kind,
					expiresAt: now + EVICTION_CLAIM_MILLIS
				};
				return { state: { ...current, claims: [...current.claims, claim] }, value: true };
			});
			if (!claimed) return undefined;
			return {
				commit: async () => {
					await updateKnown((state) => ({
						state: withoutCandidate(state, candidate),
						value: undefined
					}));
				},
				release: async () => {
					await updateKnown((state) => ({
						state: { ...state, claims: state.claims.filter(({ id }) => id !== claimId) },
						value: undefined
					}));
				}
			};
		},
		removeCandidate: async (candidate) => {
			await updateKnown((state) => ({
				state: withoutCandidate(state, candidate),
				value: undefined
			}));
		},
		close: store.close
	};
};

const requestResult = <Value>(request: IDBRequest<Value>): Promise<Value> =>
	new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error('Replica profile IndexedDB request failed'));
	});

const transactionComplete = (transaction: IDBTransaction): Promise<void> =>
	new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () =>
			reject(transaction.error ?? new Error('Replica profile transaction failed'));
		transaction.onabort = () =>
			reject(transaction.error ?? new Error('Replica profile transaction aborted'));
	});

const openDatabase = (factory: IDBFactory): Promise<IDBDatabase> =>
	new Promise((resolve, reject) => {
		const request = factory.open(REPLICA_PROFILE_INDEX_DATABASE, 1);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error('Replica profile index could not open'));
		request.onblocked = () => reject(new Error('Replica profile index upgrade is blocked'));
	});

/**
 * Opens the one browser-profile directory shared by OPFS and IndexedDB-backed partitions.
 * A caller must choose server-only mode if this fails; running persistence without the directory
 * would silently defeat the cross-organization ceiling.
 */
export const openBrowserReplicaProfileIndex = async (
	factory: IDBFactory | undefined = globalThis.indexedDB
): Promise<ReplicaProfileIndex> => {
	if (factory === undefined)
		throw new Error('IndexedDB replica profile bookkeeping is unavailable');
	const database = await openDatabase(factory);
	const store: ReplicaProfileStateStore = {
		read: async () => {
			const transaction = database.transaction(STORE, 'readonly');
			const result = await requestResult(transaction.objectStore(STORE).get(STATE_KEY));
			await transactionComplete(transaction);
			return result;
		},
		update: async (change) => {
			const transaction = database.transaction(STORE, 'readwrite');
			const objectStore = transaction.objectStore(STORE);
			const current = await requestResult(objectStore.get(STATE_KEY));
			const changed = change(current);
			objectStore.put(changed.state, STATE_KEY);
			await transactionComplete(transaction);
			return changed.value;
		},
		close: () => database.close()
	};
	return createReplicaProfileIndex(store);
};

/** Windows from the local ledger, adapted into the durable profile directory. */
export const profileWindowsFromLedger = (
	partitionId: string,
	windows: ReadonlyArray<{
		readonly id: string;
		readonly kind: 'window';
		readonly bytes: number;
		readonly lastAccess: number;
	}>
): ReadonlyArray<ReplicaProfileWindow> =>
	windows.map((window) => ({
		id: window.id,
		partitionId,
		kind: window.kind,
		accountedBytes: Math.max(0, Math.floor(window.bytes)),
		lastAccess: window.lastAccess
	}));

export const profilePartition = (input: {
	readonly id: string;
	readonly organization: string;
	readonly tier: PersistentReplicaTier;
	readonly location: string;
	readonly windows: ReadonlyArray<Pick<ReplicaProfileWindow, 'accountedBytes' | 'lastAccess'>>;
	readonly lastAccess?: number;
}): ReplicaProfilePartition => ({
	id: input.id,
	organization: input.organization,
	tier: input.tier,
	location: input.location,
	accountedBytes: input.windows.reduce((total, window) => total + window.accountedBytes, 0),
	lastAccess:
		input.lastAccess ??
		input.windows.reduce((latest, window) => Math.max(latest, window.lastAccess), 0)
});

export type ReplicaAutomationStatus =
	'pending' | 'paused' | 'resuming' | 'running' | 'done' | 'failed';

const activeAutomationStatus = (status: ReplicaAutomationStatus): boolean =>
	status === 'pending' || status === 'resuming' || status === 'running';

export const runningAutomationLeaseId = (partitionId: string, taskId: string): string => {
	if (partitionId.length === 0 || taskId.length === 0)
		throw new Error('Running automation lease identity cannot be empty');
	return `automation:${partitionId.length}:${partitionId}:${taskId}`;
};

/**
 * Internal lifecycle hook for the generated automation client.
 *
 * A lease is stable by durable task id, so a promoted leader can adopt it. `reconcile` consumes a
 * complete server-authoritative set after startup and removes leases whose tasks reached a terminal
 * state while no tab was alive.
 */
export const createRunningAutomationLeaseHooks = (input: {
	readonly index: ReplicaProfileIndex;
	readonly ownerId: string;
	readonly partitionId: string;
}): Readonly<{
	readonly started: (taskId: string) => Promise<void>;
	readonly observe: (taskId: string, status: ReplicaAutomationStatus) => Promise<void>;
	readonly reconcile: (input: {
		readonly complete: true;
		readonly activeTaskIds: ReadonlyArray<string>;
	}) => Promise<void>;
	readonly settled: (taskId: string) => Promise<void>;
}> => {
	const prefix = `automation:${input.partitionId.length}:${input.partitionId}:`;
	const leaseId = (taskId: string): string => runningAutomationLeaseId(input.partitionId, taskId);
	const started = async (taskId: string): Promise<void> => {
		await input.index.lease({
			id: leaseId(taskId),
			ownerId: input.ownerId,
			partitionId: input.partitionId,
			kind: 'running-automation'
		});
	};
	const settled = (taskId: string): Promise<void> => input.index.releaseLease(leaseId(taskId));
	return {
		started,
		observe: (taskId, status) =>
			activeAutomationStatus(status) ? started(taskId) : settled(taskId),
		reconcile: async ({ activeTaskIds }) => {
			const active = new Set(activeTaskIds);
			await Promise.all([...active].map(started));
			const snapshot = await input.index.snapshot();
			await Promise.all(
				snapshot.leases
					.filter(
						(lease) =>
							lease.partitionId === input.partitionId &&
							lease.kind === 'running-automation' &&
							lease.id.startsWith(prefix) &&
							!active.has(lease.id.slice(prefix.length))
					)
					.map(({ id }) => input.index.releaseLease(id))
			);
		},
		settled
	};
};

/**
 * Runtime seam for one leader's budget pass.
 *
 * `releasePhysical` owns PGlite internals: it releases a current query window through the ledger
 * ledger, or deletes an inactive partition through the selected VFS. It must be idempotent because
 * a browser may die after physical deletion but before the profile-index transaction commits.
 */
export const enforceIndexedReplicaProfileBudget = async (input: {
	readonly index: ReplicaProfileIndex;
	readonly budget: ReplicaStorageBudget;
	readonly estimate: () => Promise<Readonly<{ usage?: number; quota?: number }>>;
	readonly releasePhysical: (candidate: ReplicaProfileEvictionCandidate) => Promise<void>;
	readonly now?: number;
}): Promise<ReplicaProfileEvictionResult> => {
	return enforceProfileReplicaBudget(
		input.budget,
		input.estimate,
		await input.index.snapshot(input.now),
		async (candidate) => {
			const claim = await input.index.claimCandidate(candidate, input.now);
			if (claim === undefined) {
				throw new Error('Replica eviction candidate became protected before release');
			}
			try {
				await input.releasePhysical(candidate);
				await claim.commit();
			} catch (error) {
				await claim.release();
				throw error;
			}
		},
		input.now
	);
};

/**
 * Keeps browser-owned leases alive while a tab/leader is healthy. An abrupt process death simply
 * stops heartbeats and the TTL withdraws those leases; `stop` handles the ordinary unmount path.
 * Pending-mutation and running-automation leases are intentionally unaffected by either operation.
 */
export const maintainReplicaLeaseOwner = (
	index: ReplicaProfileIndex,
	ownerId: string,
	options: Readonly<{
		readonly intervalMillis?: number;
		readonly onFailure?: (error: unknown) => void;
		readonly setInterval?: (callback: () => void, milliseconds: number) => unknown;
		readonly clearInterval?: (handle: unknown) => void;
	}> = {}
): Readonly<{ readonly stop: () => Promise<void> }> => {
	const intervalMillis = options.intervalMillis ?? 15_000;
	if (
		!Number.isFinite(intervalMillis) ||
		intervalMillis < 1_000 ||
		intervalMillis >= DEFAULT_REPLICA_LEASE_MILLIS
	) {
		throw new Error('Replica lease heartbeat must be between 1 second and the lease TTL');
	}
	const schedule =
		options.setInterval ??
		((callback: () => void, milliseconds: number): unknown => setInterval(callback, milliseconds));
	const cancel =
		options.clearInterval ??
		((handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>));
	let active = true;
	let tail: Promise<void> = Promise.resolve();
	let stopping: Promise<void> | undefined;
	const timer = schedule(() => {
		if (!active) return;
		const renewal = tail.then(async () => {
			if (active) await index.renewOwner(ownerId);
		});
		tail = renewal.catch((error) => options.onFailure?.(error));
	}, intervalMillis);
	return {
		stop: () => {
			if (stopping !== undefined) return stopping;
			active = false;
			cancel(timer);
			stopping = tail.then(() => index.releaseOwner(ownerId));
			return stopping;
		}
	};
};
