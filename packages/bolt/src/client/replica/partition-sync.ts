import { Effect } from 'effect';
import { compareSyncCursors, type SyncCursor } from '#lib/runtime/sync/sync.js';
import type {
	CollectionGenerations,
	PartitionDelta,
	PartitionDeltaBatch,
	PartitionRecoveryAdvice,
	PartitionStreamPosition,
	PartitionStreamReady
} from '#lib/client/replica/subscribe.js';
import {
	createHydrationPriorityScheduler,
	type ReplicaHydrationCandidate,
	type ReplicaHydrationDemandHandle,
	type ReplicaHydrationPriority,
	type ReplicaHydrationPriorityScheduler,
	type ReplicaWindowVisibility
} from '#lib/client/replica/hydration-priority.js';

/** The durable O6 position owned by the replica, never by a tab's in-memory stream. */
export type DurablePartitionPosition = PartitionStreamPosition;

export type PartitionDeltaApplyOutcome = Readonly<{
	readonly applied: number;
	readonly affectedCollections: ReadonlyArray<string>;
	readonly affectedWindowIds: ReadonlyArray<string>;
	readonly proofWithdrawals: ReadonlyArray<string>;
}>;

/**
 * Structural adapter implemented by the PGlite base/window ledger.
 *
 * Every method which changes O3/O5/O6 is one transaction on that ledger. Keeping the adapter here
 * small prevents the browser orchestration from learning table names or inventing a second storage
 * path while still making the M1/M2/M3 ordering explicit.
 */
export type PartitionSyncStore = Readonly<{
	readonly position: () => Effect.Effect<DurablePartitionPosition, unknown>;
	readonly applyDeltas: (batch: {
		readonly cursor: SyncCursor;
		readonly generations: CollectionGenerations;
		readonly deltas: ReadonlyArray<PartitionDelta>;
		readonly affectedCollections: ReadonlyArray<string>;
		readonly refillCollections: ReadonlyArray<string>;
	}) => Effect.Effect<PartitionDeltaApplyOutcome, unknown>;
	readonly invalidateDependencies: (
		collections: ReadonlyArray<string>,
		generations: CollectionGenerations
	) => Effect.Effect<void, unknown>;
	/** M3 clears O3/O5 and resets O6 to the origin. */
	readonly rebuildNamespace: () => Effect.Effect<void, unknown>;
	/** Commits the advertised recovery head only after active-window hydration succeeds. */
	readonly recordPosition: (
		position: DurablePartitionPosition
	) => Effect.Effect<DurablePartitionPosition, unknown>;
}>; 

export type WindowFlight = Readonly<{
	readonly id: number;
	readonly queryKey: string;
	readonly dependencies: ReadonlyArray<string>;
}>;

export type WindowInstallContext = Readonly<{
	/** Deltas strictly newer than the server's pre-query cursor, in stream order. */
	readonly bufferedDeltas: ReadonlyArray<PartitionDelta>;
	/** The newest O6 facts known when the page is installed. */
	readonly position: DurablePartitionPosition;
	/** False means rows may warm O3 but the response cannot install a fresh proof. */
	readonly proofMayBeValid: boolean;
}>;

type TrackedWindow = {
	readonly queryKey: string;
	readonly mounts: Map<number, ReadonlyArray<string>>;
};

export type PartitionWindowMount = (() => void) &
	Readonly<{
		/** Only a platform-owned visible-route proof may promote this mount to priority zero. */
		readonly setVisibility: (visibility?: ReplicaWindowVisibility) => void;
	}>;

export type PartitionWindowHydrationEvidence = Readonly<{
	/** The exact canonical query, rather than a collection-name inference, selects relationships. */
	readonly relationDependency?: boolean;
}>;

type MutableFlight = {
	readonly id: number;
	readonly queryKey: string;
	readonly dependencies: ReadonlySet<string>;
	readonly buffered: Array<PartitionDelta>;
	overflowed: boolean;
};

export type PartitionSyncCoordinatorOptions = Readonly<{
	readonly store: PartitionSyncStore;
	readonly initialPosition?: DurablePartitionPosition;
	/** Runs a mounted query against the post-transaction base-through-overlay view. */
	readonly rerunAffected: (collections: ReadonlyArray<string>) => void;
	/** Restores dirty LocalExact membership once, inside the batch's serialized apply turn. */
	readonly recomputeWindows?: (
		queryKeys: ReadonlyArray<string>
	) => Promise<ReadonlyArray<string>>;
	/** Mutation overlay settlement and metrics observe the already-durable M1 outcome here. */
	readonly onApplied?: (
		batch: PartitionDeltaBatch,
		outcome: PartitionDeltaApplyOutcome
	) => Promise<void>;
	readonly onProofWithdrawals?: (queryKeys: ReadonlyArray<string>) => void;
	/** One authoritative bounded page. It must not chase the entire collection. */
	readonly refillWindow: (
		queryKey: string,
		priority: ReplicaHydrationPriority
	) => Promise<void>;
	/** Rehydrates only active windows after M3 committed the empty/new namespace. */
	readonly rehydrateActive: (
		queryKeys: ReadonlyArray<string>,
		affectedCollections: ReadonlyArray<string>
	) => Promise<void>;
	readonly onDependenciesChanged?: (
		collections: ReadonlyArray<string>,
		position: DurablePartitionPosition
	) => void;
	readonly onError?: (cause: unknown) => void;
	readonly maxBufferedDeltasPerFlight?: number;
	readonly maxConcurrentRefills?: number;
	/** Injectable only for deterministic focused tests; production uses the platform policy. */
	readonly hydrationPriorities?: ReplicaHydrationPriorityScheduler;
}>;

export type PartitionSyncCoordinator = Readonly<{
	readonly mountWindow: (
		queryKey: string,
		dependencies: ReadonlyArray<string>,
		visibility?: ReplicaWindowVisibility,
		evidence?: PartitionWindowHydrationEvidence
	) => PartitionWindowMount;
	readonly dependencies: () => ReadonlyArray<string>;
	/** A concrete relation or continuation window. Unknown identities deliberately remain P2. */
	readonly retainHydration: (
		input: Parameters<ReplicaHydrationPriorityScheduler['retain']>[0]
	) => ReplicaHydrationDemandHandle;
	/** Durable ledger/profile recency is the sole source for opportunistic P2 work. */
	readonly noteRecentHydration: (
		input: Parameters<ReplicaHydrationPriorityScheduler['noteRecent']>[0]
	) => void;
	readonly hydrationPlan: (
		now?: number
	) => ReadonlyArray<ReplicaHydrationCandidate>;
	/** Enqueues the current P0/P1/P2 plan in policy order. */
	readonly requestPlannedHydration: () => void;
	readonly requestRefill: (
		queryKey: string,
		priority?: ReplicaHydrationPriority
	) => void;
	readonly beginWindowFlight: (
		queryKey: string,
		dependencies: ReadonlyArray<string>
	) => WindowFlight;
	readonly installWindowFlight: (
		flight: WindowFlight,
		readCursor: SyncCursor,
		pageGenerations: CollectionGenerations,
		install: (
			context: WindowInstallContext
		) => Effect.Effect<Readonly<{ readonly valid: boolean; readonly dirty: boolean }>, unknown>
	) => Promise<void>;
	readonly cancelWindowFlight: (flight: WindowFlight) => void;
	readonly acceptDeltas: (batch: PartitionDeltaBatch) => void;
	readonly invalidate: (
		collections: ReadonlyArray<string>,
		generations: CollectionGenerations
	) => void;
	readonly recover: (advice: PartitionRecoveryAdvice) => void;
	readonly observeReady: (ready: PartitionStreamReady) => void;
	readonly rebuild: (
		reason: 'schema' | 'authority' | 'headRollback',
		position: DurablePartitionPosition,
		affectedCollections?: ReadonlyArray<string>
	) => void;
	readonly idle: () => Promise<void>;
	readonly stop: () => Promise<void>;
}>;

const normalize = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
	[...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();

const generationsCover = (
	known: CollectionGenerations,
	captured: CollectionGenerations,
	dependencies: ReadonlyArray<string>
): boolean =>
	dependencies.every((collection) => (known[collection] ?? 0) <= (captured[collection] ?? 0));

/**
 * Coordinates M1/M2/M3 for one leader without owning either transport or SQL.
 *
 * All durable changes share `tail`, so applying a stream batch, installing an in-flight page and
 * rebuilding a namespace have one total order. Page-flight buffers are intentionally per window:
 * a shared base delta can apply immediately, then replay idempotently after membership installation
 * so an older page never erases the movement that happened while it was in flight.
 */
export const createPartitionSyncCoordinator = (
	options: PartitionSyncCoordinatorOptions
): PartitionSyncCoordinator => {
	const windows = new Map<string, TrackedWindow>();
	const flights = new Map<number, MutableFlight>();
	const hydrationPriorities = options.hydrationPriorities ?? createHydrationPriorityScheduler();
	const queuedRefills = new Map<
		string,
		Readonly<{ readonly sequence: number; readonly priority?: ReplicaHydrationPriority }>
	>();
	let activeRefills = 0;
	let nextRefillSequence = 0;
	let nextFlightId = 0;
	let nextMountId = 0;
	let stopped = false;
	let serverPartitionId: string | undefined;
	let serverHead: SyncCursor | undefined;
	let lastPosition: DurablePartitionPosition | undefined = options.initialPosition;
	let desiredDependencies: ReadonlyArray<string> = [];
	let desiredDependencySignature = '[]';
	let publishedDependencySignature = '[]';
	let dependencyPublicationRunning = false;
	let tail = Promise.resolve();
	let observedTail = tail;
	const maxBuffered = Math.max(1, options.maxBufferedDeltasPerFlight ?? 2_048);
	const maxRefills = Math.max(1, options.maxConcurrentRefills ?? 2);

	const windowDependencies = (window: TrackedWindow): ReadonlyArray<string> =>
		normalize([...window.mounts.values()].flat());
	const activeDependencies = (): ReadonlyArray<string> =>
		normalize([...windows.values()].flatMap(windowDependencies));
	const priorityByQueryKey = (): ReadonlyMap<string, ReplicaHydrationCandidate> =>
		new Map(hydrationPriorities.snapshot().map((candidate) => [candidate.queryKey, candidate]));
	const activeWindowKeys = (affected?: ReadonlyArray<string>): ReadonlyArray<string> => {
		const changed = affected === undefined || affected.length === 0 ? undefined : new Set(affected);
		const priorities = priorityByQueryKey();
		return [...windows.values()].flatMap((window) =>
			changed === undefined || windowDependencies(window).some((name) => changed.has(name))
				? [window.queryKey]
				: []
		).toSorted((left, right) =>
			(priorities.get(left)?.priority ?? 1) - (priorities.get(right)?.priority ?? 1) ||
			left.localeCompare(right)
		);
	};
	const report = (cause: unknown): void => options.onError?.(cause);
	const serialize = (work: () => Promise<void>): Promise<void> => {
		const accepted = tail.then(work);
		observedTail = accepted;
		tail = accepted.catch(report);
		return accepted;
	};
	const position = async (): Promise<DurablePartitionPosition> => {
		const durable = await Effect.runPromise(options.store.position());
		lastPosition = durable;
		return durable;
	};
	const publishDependencies = (): void => {
		if (stopped || options.onDependenciesChanged === undefined) return;
		const dependencies = activeDependencies();
		const signature = JSON.stringify(dependencies);
		if (signature === desiredDependencySignature && dependencyPublicationRunning) return;
		desiredDependencies = dependencies;
		desiredDependencySignature = signature;
		if (signature === publishedDependencySignature || dependencyPublicationRunning) return;
		dependencyPublicationRunning = true;
		void serialize(async () => {
			try {
				for (;;) {
					const nextDependencies = desiredDependencies;
					const nextSignature = desiredDependencySignature;
					if (nextSignature === publishedDependencySignature) return;
					const durable = await position();
					// A newer mount/release superseded this set while O6 was being read.
					if (nextSignature !== desiredDependencySignature) continue;
					options.onDependenciesChanged?.(nextDependencies, durable);
					publishedDependencySignature = nextSignature;
				}
			} finally {
				dependencyPublicationRunning = false;
			}
		});
	};
	const pumpRefills = (): void => {
		while (!stopped && activeRefills < maxRefills) {
			const priorities = priorityByQueryKey();
			const next = [...queuedRefills.entries()].toSorted(([left, leftRequest], [right, rightRequest]) => {
				const leftCandidate = priorities.get(left);
				const rightCandidate = priorities.get(right);
				return (
					(leftRequest.priority ?? leftCandidate?.priority ?? 2) -
						(rightRequest.priority ?? rightCandidate?.priority ?? 2) ||
					(rightCandidate?.lastAccess ?? Number.NEGATIVE_INFINITY) -
						(leftCandidate?.lastAccess ?? Number.NEGATIVE_INFINITY) ||
					leftRequest.sequence - rightRequest.sequence
				);
			})[0];
			if (next === undefined) return;
			const [queryKey, request] = next;
			const priority = request.priority ?? priorities.get(queryKey)?.priority ?? 2;
			queuedRefills.delete(queryKey);
			activeRefills += 1;
			void options
				.refillWindow(queryKey, priority)
				.catch(report)
				.finally(() => {
					activeRefills -= 1;
					pumpRefills();
				});
		}
	};
	const scheduleRefills = (
		keys: ReadonlyArray<string>,
		priority?: ReplicaHydrationPriority
	): void => {
		for (const key of keys) {
			const existing = queuedRefills.get(key);
			if (existing !== undefined) {
				const existingPriority =
					existing.priority ?? priorityByQueryKey().get(key)?.priority ?? 2;
				if (priority !== undefined && priority < existingPriority) {
					queuedRefills.set(key, { ...existing, priority });
				}
				continue;
			}
			nextRefillSequence += 1;
			queuedRefills.set(key, {
				sequence: nextRefillSequence,
				...(priority === undefined ? {} : { priority })
			});
		}
		pumpRefills();
	};
	const doRebuild = (
		position: DurablePartitionPosition,
		affectedCollections: ReadonlyArray<string>
	): void => {
		void serialize(async () => {
			const affected = affectedCollections.length === 0
				? activeDependencies()
				: affectedCollections;
			// The recovery head is only a proposal until the new namespace contains the bounded
			// active-window snapshot. A crash during hydration therefore resumes from the origin.
			await Effect.runPromise(options.store.rebuildNamespace());
			lastPosition = { cursor: { xid: 0, sequence: 0 }, generations: {} };
			// M3 replaces the whole namespace, so every active window—not merely the collection
			// which revealed the fault—must be installed before the advertised head can commit.
			await options.rehydrateActive(activeWindowKeys(), affected);
			lastPosition = await Effect.runPromise(options.store.recordPosition(position));
			options.rerunAffected(affected);
			const dependencies = activeDependencies();
			options.onDependenciesChanged?.(dependencies, lastPosition);
			desiredDependencies = dependencies;
			desiredDependencySignature = JSON.stringify(dependencies);
			publishedDependencySignature = desiredDependencySignature;
		});
	};

	return {
		mountWindow: (queryKey, dependencies, visibility = 'unknown', evidence = {}) => {
			const normalized = normalize(dependencies);
			nextMountId += 1;
			const mountId = nextMountId;
			const priorityDemand = hydrationPriorities.mount({
				ownerId: `partition-window:${mountId}`,
				queryKey,
				visibility
			});
			const relationDemand = evidence.relationDependency === true
				? hydrationPriorities.retain({
						ownerId: `relation-dependency:${mountId}`,
						queryKey,
						reason: 'relation-dependency',
						queryKeyEvidence: 'concrete'
					})
				: undefined;
			const existing = windows.get(queryKey);
			if (existing === undefined) {
				windows.set(queryKey, {
					queryKey,
					mounts: new Map([[mountId, normalized]])
				});
			} else {
				existing.mounts.set(mountId, normalized);
			}
			publishDependencies();
			let released = false;
			const release = (() => {
				if (released) return;
				released = true;
				priorityDemand.release();
				relationDemand?.release();
				const tracked = windows.get(queryKey);
				if (tracked === undefined) return;
				tracked.mounts.delete(mountId);
				if (tracked.mounts.size === 0) {
					windows.delete(queryKey);
				}
				publishDependencies();
				if (!priorityByQueryKey().has(queryKey)) queuedRefills.delete(queryKey);
			}) as PartitionWindowMount;
			Object.defineProperty(release, 'setVisibility', {
				value: (next: ReplicaWindowVisibility = 'unknown') => {
					if (released) return;
					priorityDemand.setVisibility(next);
					pumpRefills();
				},
				enumerable: true
			});
			return release;
		},
		dependencies: activeDependencies,
		retainHydration: (input) => hydrationPriorities.retain(input),
		noteRecentHydration: (input) => hydrationPriorities.noteRecent(input),
		hydrationPlan: (now) => hydrationPriorities.snapshot(now),
		requestPlannedHydration: () => {
			for (const candidate of hydrationPriorities.snapshot()) {
				scheduleRefills([candidate.queryKey]);
			}
		},
		requestRefill: (queryKey, priority) => scheduleRefills([queryKey], priority),
		beginWindowFlight: (queryKey, dependencies) => {
			nextFlightId += 1;
			const flight: MutableFlight = {
				id: nextFlightId,
				queryKey,
				dependencies: new Set(normalize(dependencies)),
				buffered: [],
				overflowed: false
			};
			flights.set(flight.id, flight);
			return { id: flight.id, queryKey, dependencies: [...flight.dependencies] };
		},
		installWindowFlight: (flight, readCursor, pageGenerations, install) =>
			serialize(async () => {
				const captured = flights.get(flight.id);
				flights.delete(flight.id);
				if (captured === undefined || captured.queryKey !== flight.queryKey || stopped) return;
				const durable = await position();
				const bufferedDeltas = captured.buffered.filter(
					(delta) => compareSyncCursors(delta.cursor, readCursor) > 0
				);
				const proofMayBeValid =
					!captured.overflowed &&
					generationsCover(durable.generations, pageGenerations, [...captured.dependencies]);
				// The ledger installs page rows/membership, replays these transitions and keeps O6 at
				// `durable` in one transaction; followers never observe a fresh pre-flight proof.
				const installed = await Effect.runPromise(
					install({ bufferedDeltas, position: durable, proofMayBeValid })
				);
				if (installed.dirty) {
					const restored = await options.recomputeWindows?.([flight.queryKey]) ?? [];
					if (!restored.includes(flight.queryKey)) scheduleRefills([flight.queryKey]);
				} else if (!proofMayBeValid || !installed.valid) {
					scheduleRefills([flight.queryKey]);
				}
			}),
		cancelWindowFlight: (flight) => {
			flights.delete(flight.id);
		},
		acceptDeltas: (batch) => {
			if (stopped) return;
			const partitionChanged =
				serverPartitionId !== undefined && serverPartitionId !== batch.partition.key;
			const headMovedBack =
				serverHead !== undefined && compareSyncCursors(batch.headCursor, serverHead) < 0;
			serverPartitionId = batch.partition.key;
			serverHead = batch.headCursor;
			if (partitionChanged || headMovedBack) {
				doRebuild(
					{ cursor: batch.cursor, generations: batch.generations },
					activeDependencies()
				);
				return;
			}
			for (const delta of batch.deltas) {
				for (const flight of flights.values()) {
					if (!flight.dependencies.has(delta.collection)) continue;
					if (flight.buffered.length >= maxBuffered) {
						flight.overflowed = true;
						continue;
					}
					flight.buffered.push(delta);
				}
			}
			void serialize(async () => {
				const outcome = await Effect.runPromise(
					options.store.applyDeltas({
						cursor: batch.cursor,
						generations: batch.generations,
						deltas: batch.deltas,
						affectedCollections: batch.affectedCollections,
						refillCollections: batch.refillCollections
					})
				);
				lastPosition = { cursor: batch.cursor, generations: batch.generations };
				await options.recomputeWindows?.(outcome.affectedWindowIds);
				await options.onApplied?.(batch, outcome);
				options.onProofWithdrawals?.(outcome.proofWithdrawals);
				const affected = normalize([
					...batch.affectedCollections,
					...outcome.affectedCollections,
					...batch.deltas.map(({ collection }) => collection)
				]);
				if (
					affected.length > 0 &&
					(outcome.applied > 0 || outcome.proofWithdrawals.length > 0)
				) options.rerunAffected(affected);
				const withdrawn = new Set(outcome.proofWithdrawals);
				const refillKeys = activeWindowKeys(affected).filter((key) => withdrawn.has(key));
				if (refillKeys.length > 0) scheduleRefills(refillKeys);
			});
		},
		invalidate: (collections, generations) => {
			if (stopped) return;
			const affected = normalize(collections);
			void serialize(async () => {
				await Effect.runPromise(options.store.invalidateDependencies(affected, generations));
				const durable = await position();
				lastPosition = { cursor: durable.cursor, generations };
				options.rerunAffected(affected);
				scheduleRefills(activeWindowKeys(affected));
			});
		},
		recover: (advice) => {
			if (stopped) return;
			// Cursor expiry and a live rehydrate recommendation are the same M3 shape. The advertised
			// cursor becomes durable only inside rebuildNamespace, never merely because the frame arrived.
			doRebuild(
				{ cursor: advice.headCursor, generations: advice.generations },
				normalize(advice.affectedCollections)
			);
		},
		observeReady: (ready) => {
			if (stopped) return;
			const partitionChanged =
				serverPartitionId !== undefined && serverPartitionId !== ready.partition.key;
			const headMovedBack =
				(serverHead !== undefined && compareSyncCursors(ready.cursor, serverHead) < 0) ||
				(lastPosition !== undefined && compareSyncCursors(ready.cursor, lastPosition.cursor) < 0);
			serverPartitionId = ready.partition.key;
			serverHead = ready.cursor;
			if (partitionChanged || headMovedBack) {
				doRebuild(
					{ cursor: ready.cursor, generations: ready.generations },
					activeDependencies()
				);
			}
		},
		rebuild: (_reason, position, affectedCollections = activeDependencies()) => {
			if (stopped) return;
			doRebuild(position, normalize(affectedCollections));
		},
		idle: () => observedTail,
		stop: async () => {
			stopped = true;
			windows.clear();
			flights.clear();
			queuedRefills.clear();
			hydrationPriorities.clear();
			await tail;
		}
	};
};
