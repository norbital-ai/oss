/**
 * Where this client stands against the authority, in the three states it can actually be in.
 *
 * - `connected` — the stream is open and this replica is **level**: replay is complete and nothing
 *   local is queued. Deltas arriving on a level replica are the steady state, not an event.
 * - `syncing` — the stream is open and this replica is **catching up**: replaying what it missed
 *   while it was down, or pushing what was queued locally. It is a transient after a connection.
 * - `disconnected` — no stream. It reconnects on its own.
 *
 * The five-state model this replaces (`unverified`, `connecting`, `online`, `offline`,
 * `disconnected`) existed because the stream was torn down and rebuilt whenever the mounted
 * dependency set changed, so "not connected" could mean a fault, a surface with nothing subscribed,
 * or a connection never attempted. The shell reported all three as an unavailable stream while
 * every command it sent answered normally.
 *
 * `navigator.onLine === false` is proof of `disconnected`; `true` proves nothing, so it never moves
 * the signal on its own.
 */
export type SyncConnectivity = 'connected' | 'syncing' | 'disconnected';

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
		/** The stream is open and this replica is catching up — replaying or pushing. */
		readonly markSyncing: () => void;
		/** Replay is complete and nothing is queued: this replica is level with the authority. */
		readonly markConnected: () => void;
		/** The stream is down. It reconnects on its own; this is the only fault state. */
		readonly markDisconnected: () => void;
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
		connectivity: initialReachability === false ? 'disconnected' : 'syncing',
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
			// Updating an unrelated counter must not turn a catching-up replica into an exact one. Only
			// an explicit `ready` frame may clear retained-only mode.
			offlineRetainedOnly: next.connectivity === 'connected' ? next.offlineRetainedOnly : true
		});
	};
	/**
	 * The adapter can prove absence, never presence.
	 *
	 * `navigator.onLine === false` means no request can succeed, so it settles `disconnected`
	 * immediately rather than waiting for the stream to notice. Coming back only means a request
	 * could now be attempted — the stream says whether one succeeded — so it reports `syncing` and
	 * lets a `ready` frame decide.
	 */
	const browserConnectivity = (): void => {
		patch({
			connectivity: browserReachable() === false ? 'disconnected' : 'syncing',
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
		markSyncing: () =>
			patch({ connectivity: browserReachable() === false ? 'disconnected' : 'syncing' }),
		markConnected: () => patch({ connectivity: 'connected', offlineRetainedOnly: false }),
		markDisconnected: () => patch({ connectivity: 'disconnected', offlineRetainedOnly: true }),
		/**
		 * The stream was closed on purpose, because nothing is subscribed to it.
		 *
		 * `disconnected` is a claim that the authoritative stream is *unavailable*, and the shell says
		 * so. But a partition subscription exists only for the mounted dependency union: navigate from
		 * a collection table to a view holding no live query and the union empties, which closes the
		 * stream, cancels the pending retry, and leaves `open()` refusing to reopen. Reporting that as
		 * a fault told operators their sync was broken while `sync.partition` answered 200 throughout.
		 * There is no claim to make here, which is what `unverified` means.
		 */
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
