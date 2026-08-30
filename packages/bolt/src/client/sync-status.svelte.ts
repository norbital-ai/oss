import type { SyncClient } from './sync/index.js';
import type { ClientState } from './sync/machine.js';

/**
 * The one reactive view of the Machine's state the generated framework re-exports as `syncStatus`.
 *
 * A `$state` proxy updated in place: the shell reads `link` and `writes` through ordinary
 * reactivity, and every Machine transition lands here in the same step that applies the frame.
 */
export const createSyncStatusView = (sync: SyncClient): ClientState => {
	const view = $state({ ...sync.current() });
	sync.subscribe((next) => {
		Object.assign(view, next);
	});
	return view;
};
