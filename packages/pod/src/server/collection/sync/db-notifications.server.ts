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
let unsubscribeSource: (() => void) | null = null;
let notificationGeneration = 0;
const waiters = new Set<() => void>();

function announceNotification(): void {
	notificationGeneration += 1;
	for (const resolve of waiters) resolve();
	waiters.clear();
}

/** Install or clear the current host-provided commit notification source. */
export function setDatabaseNotifications(source: DatabaseNotifications | null): void {
	unsubscribeSource?.();
	unsubscribeSource = null;
	notifications = source;
	if (source) {
		unsubscribeSource = source.subscribe((channel) => {
			if (channel === SYNC_NOTIFY_CHANNEL) announceNotification();
		});
	}
	// A waiter belongs to the source that existed when it started. Wake it when that source changes
	// so the stream can re-check the durable outbox against the replacement (or absence) instead of
	// sleeping forever on a listener that no longer exists.
	announceNotification();
}

/**
 * A cheap snapshot taken before checking the durable outbox.
 *
 * The stream waits *after* that check. Pairing the wait with this generation closes the classic
 * check-then-sleep race: a commit announced between the query and the wait advances the generation,
 * so the later wait resolves immediately rather than missing the only wake-up for that commit.
 */
export function syncNotificationGeneration(): number {
	return notificationGeneration;
}

/**
 * Resolve when the change feed announces a commit, or when `signal` aborts. Callers that also
 * need a periodic tick (an SSE keep-alive, say) should race this against their own timer rather
 * than asking for one here — a timeout in this function would be a poll wearing a disguise.
 */
export function waitForSyncNotification(
	afterGeneration: number,
	signal: AbortSignal
): Promise<void> {
	if (signal.aborted || notificationGeneration !== afterGeneration) return Promise.resolve();
	// A host that does not install push notifications falls back to the caller's keep-alive.
	if (!notifications)
		return new Promise((resolve) =>
			signal.addEventListener('abort', () => resolve(), { once: true })
		);

	return new Promise((resolve) => {
		const finish = () => {
			waiters.delete(finish);
			signal.removeEventListener('abort', finish);
			resolve();
		};
		waiters.add(finish);
		signal.addEventListener('abort', finish, { once: true });
		// The notification can land between the fast-path check above and registering this waiter.
		// Re-check after registration so neither side of that tiny window can lose it.
		if (notificationGeneration !== afterGeneration) finish();
	});
}
