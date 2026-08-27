/**
 * Health of the authoritative sync path, not merely the device network adapter.
 *
 * `online` is reserved for an explicit live-stream proof. `navigator.onLine === true` can move the
 * signal only to `unverified`: a browser can have a network interface while DNS, authentication,
 * the host, or the partition stream is unavailable.
 */
export type SyncConnectivity =
	| 'unverified'
	| 'connecting'
	| 'online'
	| 'offline'
	| 'disconnected';

export type SyncIssue = Readonly<{
	readonly mutationId: string;
	readonly kind: 'rejected' | 'quarantined';
	readonly message: string;
	readonly atEpochMs: number;
}>;

export type WorkspaceSyncStatus = Readonly<{
	readonly connectivity: SyncConnectivity;
	/** True means queries may render retained/overlay rows but cannot claim unseen rows are absent. */
	readonly offlineRetainedOnly: boolean;
	readonly staleServerProofWindows: number;
	readonly pendingMutations: number;
	readonly settledMutations: number;
	readonly issues: ReadonlyArray<SyncIssue>;
	readonly revision: number;
}>;

export type WorkspaceSyncStatusSignal = Readonly<{
	readonly current: () => WorkspaceSyncStatus;
	readonly subscribe: (listener: (status: WorkspaceSyncStatus) => void) => () => void;
}>;

export type MutableWorkspaceSyncStatusSignal = WorkspaceSyncStatusSignal &
	Readonly<{
		readonly patch: (patch: Partial<Omit<WorkspaceSyncStatus, 'revision'>>) => void;
		/** The leader has begun opening the authoritative partition stream. */
		readonly markStreamConnecting: () => void;
		/** A decoded partition `ready` frame proved the stream and authority are live. */
		readonly markStreamReady: () => void;
		/** The stream errored or closed and has not yet produced a replacement `ready` frame. */
		readonly markStreamDisconnected: () => void;
		readonly close: () => void;
	}>;

const browserReachable = (): boolean | undefined =>
	typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean'
		? undefined
		: navigator.onLine;

/** One platform-owned status source shared by every shell surface for this runtime. */
export const createWorkspaceSyncStatus = (): MutableWorkspaceSyncStatusSignal => {
	const initialReachability = browserReachable();
	let value: WorkspaceSyncStatus = {
		connectivity: initialReachability === false ? 'offline' : 'unverified',
		// Until the sync stream proves itself live, retained rows cannot prove unseen rows are absent.
		offlineRetainedOnly: true,
		staleServerProofWindows: 0,
		pendingMutations: 0,
		settledMutations: 0,
		issues: [],
		revision: 0
	};
	const listeners = new Set<(status: WorkspaceSyncStatus) => void>();
	let closed = false;
	const publish = (next: Omit<WorkspaceSyncStatus, 'revision'>): void => {
		if (closed) return;
		value = { ...next, revision: value.revision + 1 };
		for (const listener of listeners) listener(value);
	};
	const patch = (change: Partial<Omit<WorkspaceSyncStatus, 'revision'>>): void => {
		const { revision: _revision, ...current } = value;
		const next = { ...current, ...change };
		publish({
			...next,
			// Updating an unrelated counter must not turn an unverified connection into an exact
			// replica. Only an explicit stream-ready transition may clear retained-only mode.
			offlineRetainedOnly:
				next.connectivity === 'online' ? next.offlineRetainedOnly : true
		});
	};
	const browserConnectivity = (): void => {
		const reachable = browserReachable();
		patch({
			connectivity: reachable === false ? 'offline' : 'unverified',
			offlineRetainedOnly: true
		});
	};
	if (typeof window !== 'undefined') {
		window.addEventListener('online', browserConnectivity);
		window.addEventListener('offline', browserConnectivity);
	}
	return {
		current: () => value,
		subscribe: (listener) => {
			if (closed) return () => undefined;
			listeners.add(listener);
			listener(value);
			return () => listeners.delete(listener);
		},
		patch,
		markStreamConnecting: () =>
			patch({ connectivity: browserReachable() === false ? 'offline' : 'connecting' }),
		markStreamReady: () => patch({ connectivity: 'online', offlineRetainedOnly: false }),
		markStreamDisconnected: () =>
			patch({ connectivity: 'disconnected', offlineRetainedOnly: true }),
		close: () => {
			if (closed) return;
			closed = true;
			listeners.clear();
			if (typeof window !== 'undefined') {
				window.removeEventListener('online', browserConnectivity);
				window.removeEventListener('offline', browserConnectivity);
			}
		}
	};
};
