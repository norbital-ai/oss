import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	setDatabaseNotifications,
	syncNotificationGeneration,
	waitForSyncNotification
} from '$lib/server/collection/sync/db-notifications.server.js';

describe('sync database notifications', () => {
	afterEach(() => setDatabaseNotifications(null));

	it('does not lose a commit announced between the outbox check and the idle wait', async () => {
		let notify: ((channel: string, payload: string) => void) | undefined;
		setDatabaseNotifications({
			subscribe(listener) {
				notify = listener;
				return () => {
					notify = undefined;
				};
			}
		});
		const checkedAt = syncNotificationGeneration();
		notify?.('norbital_sync', '42');

		await expect(
			waitForSyncNotification(checkedAt, new AbortController().signal)
		).resolves.toBeUndefined();
	});

	it('keeps one source subscription and wakes every stream waiter', async () => {
		let notify: ((channel: string, payload: string) => void) | undefined;
		const unsubscribe = vi.fn();
		const subscribe = vi.fn((listener: (channel: string, payload: string) => void) => {
			notify = listener;
			return unsubscribe;
		});
		setDatabaseNotifications({ subscribe });
		const checkedAt = syncNotificationGeneration();
		const first = waitForSyncNotification(checkedAt, new AbortController().signal);
		const second = waitForSyncNotification(checkedAt, new AbortController().signal);

		notify?.('norbital_sync', '43');
		await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
		expect(subscribe).toHaveBeenCalledTimes(1);

		setDatabaseNotifications(null);
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});
});
