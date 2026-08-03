/**
 * The change-feed wake-up signal.
 *
 * `sync_outbox` carries an `AFTER INSERT` statement trigger that issues
 * `pg_notify('norbital_sync', max(seq))` once per statement. Postgres queues that inside the
 * writing transaction and delivers it at COMMIT — the exact moment the rows become visible — so a
 * listener learns about a change instead of asking whether one happened. An idle workspace runs no
 * queries at all, and a bulk write costs one wake-up rather than one per row.
 *
 * The `LISTEN` connection itself lives in the host, not here: this process reaches Postgres only
 * through the request/response `db` binding, which has nowhere to put an unsolicited message. The
 * host keeps one listener per tenant database, shared by every runtime on it, and pushes each
 * notification in. This module is the seam those pushes arrive through.
 */

export const SYNC_NOTIFY_CHANNEL = 'norbital_sync';

export type DatabaseNotifications = {
	/** Register for pushed notifications. Returns an unsubscribe function. */
	subscribe(listener: (channel: string, payload: string) => void): () => void;
};

let notifications: DatabaseNotifications | null = null;

/** Install or clear the current host-provided commit notification source. */
export function setDatabaseNotifications(source: DatabaseNotifications | null): void {
	notifications = source;
}

/**
 * Resolve when the change feed announces a commit, or when `signal` aborts. Callers that also
 * need a periodic tick (an SSE keep-alive, say) should race this against their own timer rather
 * than asking for one here — a timeout in this function would be a poll wearing a disguise.
 */
export function waitForSyncNotification(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	const source = notifications;
	// A host that does not install push notifications falls back to the caller's keep-alive.
	if (!source)
		return new Promise((resolve) =>
			signal.addEventListener('abort', () => resolve(), { once: true })
		);

	return new Promise((resolve) => {
		const finish = () => {
			unsubscribe();
			signal.removeEventListener('abort', finish);
			resolve();
		};
		const unsubscribe = source.subscribe((channel) => {
			if (channel === SYNC_NOTIFY_CHANNEL) finish();
		});
		signal.addEventListener('abort', finish, { once: true });
	});
}
