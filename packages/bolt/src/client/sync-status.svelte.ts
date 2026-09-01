import type { SyncClient } from './sync/index.js';
import type { ClientState } from './sync/machine.js';
import { createSubscriber } from 'svelte/reactivity';

export const createSyncStatusView = (sync: SyncClient): ClientState => {
	const subscribe = createSubscriber((update) => {
		let active = true;
		let ready = false;
		let queued = false;
		const unsubscribe = sync.subscribe(() => {
			if (!ready || queued) return;
			queued = true;
			queueMicrotask(() => {
				queued = false;
				if (active) update();
			});
		});
		ready = true;
		return () => {
			active = false;
			unsubscribe();
		};
	});
	const current = (): ClientState => {
		subscribe();
		return sync.current();
	};
	const view = {
		get link() {
			return current().link;
		},
		get queries() {
			return current().queries;
		},
		get writes() {
			return current().writes;
		},
		get reconnectAttempt() {
			return current().reconnectAttempt;
		},
		get reconnectAt() {
			return current().reconnectAt;
		}
	};
	return view as ClientState;
};
