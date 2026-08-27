export type ReplicaHydrationPriority = 0 | 1 | 2;

export type ReplicaHydrationReason =
	| 'visible'
	| 'mounted'
	| 'relation-dependency'
	| 'adjacent'
	| 'recent';

export type ReplicaWindowVisibility = 'visible' | 'hidden' | 'unknown';

export type ReplicaHydrationCandidate = Readonly<{
	readonly queryKey: string;
	readonly priority: ReplicaHydrationPriority;
	readonly reasons: ReadonlyArray<ReplicaHydrationReason>;
	readonly lastAccess: number | null;
}>;

export type ReplicaHydrationDemandHandle = Readonly<{
	/** Idempotent and generation-fenced: a stale handle cannot release a replacement demand. */
	readonly release: () => void;
}>;

export type ReplicaMountedHydrationDemandHandle = ReplicaHydrationDemandHandle &
	Readonly<{
		/** Only explicit visible-route evidence promotes a mounted query to priority zero. */
		readonly setVisibility: (visibility?: ReplicaWindowVisibility) => void;
	}>;

export type ReplicaHydrationPriorityScheduler = Readonly<{
	readonly mount: (input: {
		readonly ownerId: string;
		readonly queryKey: string;
		readonly visibility?: ReplicaWindowVisibility;
	}) => ReplicaMountedHydrationDemandHandle;
	readonly retain: (input: {
		readonly ownerId: string;
		readonly queryKey: string;
		readonly reason: 'relation-dependency' | 'adjacent';
		/** Omission is deliberately unproven and therefore remains priority two. */
		readonly queryKeyEvidence?: 'concrete';
	}) => ReplicaHydrationDemandHandle;
	readonly noteRecent: (input: {
		readonly queryKey: string;
		readonly lastAccess: number;
	}) => void;
	readonly snapshot: (now?: number) => ReadonlyArray<ReplicaHydrationCandidate>;
	readonly clear: () => void;
}>;

export const DEFAULT_RECENT_HYDRATION_MAX_AGE_MILLIS = 5 * 60_000;
export const DEFAULT_MAX_RECENT_HYDRATION_WINDOWS = 64;

type MountedDemand = {
	readonly generation: number;
	readonly queryKey: string;
	visibility: ReplicaWindowVisibility;
};

type RetainedDemand = Readonly<{
	readonly generation: number;
	readonly queryKey: string;
	readonly reason: 'relation-dependency' | 'adjacent';
	readonly concrete: boolean;
}>;

type RecentDemand = Readonly<{
	readonly queryKey: string;
	readonly lastAccess: number;
}>;

const nonEmpty = (label: string, value: string): string => {
	const normalized = value.trim();
	if (normalized.length === 0) throw new Error(`${label} cannot be empty`);
	return normalized;
};

const finiteTime = (label: string, value: number): number => {
	if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
	return value;
};

const positiveInteger = (label: string, value: number): number => {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${label} must be a positive safe integer`);
	}
	return value;
};

const reasonRank: Readonly<Record<ReplicaHydrationReason, number>> = {
	visible: 0,
	mounted: 1,
	'relation-dependency': 2,
	adjacent: 3,
	recent: 4
};

/**
 * Pure platform policy. It ranks only concrete window identities and never guesses route visibility.
 * Runtime/UI adapters supply evidence; authored collection APIs remain unchanged.
 */
export const createHydrationPriorityScheduler = (
	options: Readonly<{
		readonly now?: () => number;
		readonly recentMaxAgeMillis?: number;
		readonly maxRecentWindows?: number;
	}> = {}
): ReplicaHydrationPriorityScheduler => {
	const clock = options.now ?? Date.now;
	const recentMaxAgeMillis = positiveInteger(
		'Recent hydration maximum age',
		options.recentMaxAgeMillis ?? DEFAULT_RECENT_HYDRATION_MAX_AGE_MILLIS
	);
	const maxRecentWindows = positiveInteger(
		'Recent hydration window limit',
		options.maxRecentWindows ?? DEFAULT_MAX_RECENT_HYDRATION_WINDOWS
	);
	const mounted = new Map<string, MountedDemand>();
	const retained = new Map<string, RetainedDemand>();
	const recent = new Map<string, RecentDemand>();
	let generation = 0;

	const pruneRecent = (now: number): void => {
		const oldest = now - recentMaxAgeMillis;
		for (const [queryKey, demand] of recent) {
			if (demand.lastAccess < oldest) recent.delete(queryKey);
		}
		const admitted = [...recent.values()].toSorted(
			(left, right) =>
				right.lastAccess - left.lastAccess || left.queryKey.localeCompare(right.queryKey)
		);
		for (const demand of admitted.slice(maxRecentWindows)) recent.delete(demand.queryKey);
	};

	const release = <Demand extends Readonly<{ readonly generation: number }>>(
		demands: Map<string, Demand>,
		ownerId: string,
		ownedGeneration: number
	): void => {
		if (demands.get(ownerId)?.generation === ownedGeneration) demands.delete(ownerId);
	};

	return {
		mount: (input) => {
			const ownerId = nonEmpty('Hydration mount owner', input.ownerId);
			const queryKey = nonEmpty('Hydration mount query key', input.queryKey);
			generation += 1;
			const ownedGeneration = generation;
			mounted.set(ownerId, {
				generation: ownedGeneration,
				queryKey,
				visibility: input.visibility ?? 'unknown'
			});
			let active = true;
			return {
				setVisibility: (visibility = 'unknown') => {
					if (!active) return;
					const current = mounted.get(ownerId);
					if (current?.generation === ownedGeneration) current.visibility = visibility;
				},
				release: () => {
					if (!active) return;
					active = false;
					release(mounted, ownerId, ownedGeneration);
				}
			};
		},
		retain: (input) => {
			const ownerId = nonEmpty('Hydration retention owner', input.ownerId);
			const queryKey = nonEmpty('Hydration retention query key', input.queryKey);
			generation += 1;
			const ownedGeneration = generation;
			retained.set(ownerId, {
				generation: ownedGeneration,
				queryKey,
				reason: input.reason,
				concrete: input.queryKeyEvidence === 'concrete'
			});
			let active = true;
			return {
				release: () => {
					if (!active) return;
					active = false;
					release(retained, ownerId, ownedGeneration);
				}
			};
		},
		noteRecent: (input) => {
			const queryKey = nonEmpty('Recent hydration query key', input.queryKey);
			const lastAccess = finiteTime('Recent hydration access time', input.lastAccess);
			recent.set(queryKey, { queryKey, lastAccess });
			pruneRecent(finiteTime('Hydration clock', clock()));
		},
		snapshot: (at = clock()) => {
			const now = finiteTime('Hydration snapshot time', at);
			pruneRecent(now);
			const candidates = new Map<
				string,
				{
					priority: ReplicaHydrationPriority;
					reasons: Set<ReplicaHydrationReason>;
					lastAccess: number | null;
				}
			>();
			const include = (
				queryKey: string,
				priority: ReplicaHydrationPriority,
				reason: ReplicaHydrationReason,
				lastAccess: number | null = null
			): void => {
				const current = candidates.get(queryKey);
				if (current === undefined) {
					candidates.set(queryKey, { priority, reasons: new Set([reason]), lastAccess });
					return;
				}
				current.priority = Math.min(current.priority, priority) as ReplicaHydrationPriority;
				current.reasons.add(reason);
				if (lastAccess !== null) {
					current.lastAccess = Math.max(current.lastAccess ?? lastAccess, lastAccess);
				}
			};

			for (const demand of mounted.values()) {
				include(
					demand.queryKey,
					demand.visibility === 'visible' ? 0 : 1,
					demand.visibility === 'visible' ? 'visible' : 'mounted'
				);
			}
			for (const demand of retained.values()) {
				include(demand.queryKey, demand.concrete ? 1 : 2, demand.reason);
			}
			for (const demand of recent.values()) {
				include(demand.queryKey, 2, 'recent', demand.lastAccess);
			}

			return [...candidates.entries()]
				.map(([queryKey, candidate]): ReplicaHydrationCandidate => ({
					queryKey,
					priority: candidate.priority,
					reasons: [...candidate.reasons].toSorted(
						(left, right) => reasonRank[left] - reasonRank[right]
					),
					lastAccess: candidate.lastAccess
				}))
				.toSorted(
					(left, right) =>
						left.priority - right.priority ||
						(right.lastAccess ?? Number.NEGATIVE_INFINITY) -
							(left.lastAccess ?? Number.NEGATIVE_INFINITY) ||
						left.queryKey.localeCompare(right.queryKey)
				);
		},
		clear: () => {
			mounted.clear();
			retained.clear();
			recent.clear();
		}
	};
};
