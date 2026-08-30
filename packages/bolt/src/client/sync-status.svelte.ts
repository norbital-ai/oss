import type { SyncClient } from './sync/index.js';
import type { ClientState } from './sync/machine.js';
import { createSubscriber } from 'svelte/reactivity';

/**
 * The one reactive view of the Machine's state the generated framework re-exports as `syncStatus`.
 *
 * The Machine is an external event source. Its transitions can be caused by a live query mounting
 * inside a derived expression, so synchronously assigning a `$state` proxy from its listener is an
 * unsafe mutation. Getter reads subscribe the surrounding Svelte effect; transition notifications
 * are coalesced into a microtask, after the query's derivation has finished, and every getter reads
 * the Machine's one current state directly.
 */
export const createSyncStatusView = (sync: SyncClient): ClientState => {
	const subscribe = createSubscriber((update) => {
		let active = true;
		let ready = false;
		let queued = false;
		const unsubscribe = sync.subscribe(() => {
			// `SyncClient.subscribe` publishes its current value immediately. The getter already reads
			// that value below, so only later transitions need to invalidate the surrounding effect.
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
		get head() {
			return current().head;
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
	// An accessor exists for `head` so it can become present without replacing this stable view.
	// That runtime shape is intentionally wider than the exact-optional object-literal spelling.
	return view as ClientState;
};
