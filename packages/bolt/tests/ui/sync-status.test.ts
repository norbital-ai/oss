import { describe, expect, it } from 'vitest';
import type { WorkspaceSyncStatus } from '../../src/client/runtime.js';
import { createWorkspaceSyncStatus } from '../../src/client/replica/sync-status.js';
import {
	workspaceSyncIndicator,
	workspaceSyncNotices
} from '../../src/client/ui/shell/sync-status-presentation.js';

const status = (overrides: Partial<WorkspaceSyncStatus> = {}): WorkspaceSyncStatus => ({
	connectivity: 'connected',
	offlineRetainedOnly: false,
	staleServerProofWindows: 0,
	pendingMutations: 0,
	settledMutations: 0,
	issues: [],
	revision: 0,
	...overrides
});

/**
 * Three states, because the stream is opened once and never closed on purpose.
 *
 * The five-state model — unverified, connecting, online, offline, disconnected — existed because
 * the stream was torn down and rebuilt whenever the mounted dependency set changed, so "not
 * connected" could mean a fault, a page with nothing subscribed, or a connection never attempted.
 * The shell reported all three as an unavailable stream while every command answered normally.
 */
describe('workspace sync connectivity', () => {
	it('starts syncing and reaches connected only on stream evidence', () => {
		const signal = createWorkspaceSyncStatus();
		expect(signal.current()).toMatchObject({ connectivity: 'syncing', offlineRetainedOnly: true });
		signal.markConnected();
		expect(signal.current()).toMatchObject({
			connectivity: 'connected',
			offlineRetainedOnly: false
		});
		signal.markDisconnected();
		expect(signal.current()).toMatchObject({
			connectivity: 'disconnected',
			offlineRetainedOnly: true
		});
		signal.close();
	});

	it('never lets an unrelated counter imply an exact replica', () => {
		const signal = createWorkspaceSyncStatus();
		signal.markConnected();
		signal.markSyncing();
		signal.patch({ settledMutations: 4 });
		expect(signal.current().offlineRetainedOnly).toBe(true);
		signal.close();
	});
});

/**
 * The engine's own state lives in the sidebar, where ignoring it costs nothing.
 */
describe('workspace sync indicator', () => {
	it('names each state without demanding attention', () => {
		expect(workspaceSyncIndicator(status())).toMatchObject({
			state: 'connected',
			label: 'Connected'
		});
		expect(workspaceSyncIndicator(status({ connectivity: 'syncing' }))).toMatchObject({
			state: 'syncing',
			label: 'Syncing'
		});
		expect(workspaceSyncIndicator(status({ connectivity: 'disconnected' }))).toMatchObject({
			state: 'disconnected',
			tone: 'warning'
		});
	});

	it('treats an absent signal as disconnected rather than inventing health', () => {
		expect(workspaceSyncIndicator(undefined).state).toBe('disconnected');
	});
});

/**
 * A toast is for the reader's own work, never for the plumbing.
 */
describe('workspace sync notices', () => {
	it('says nothing about connectivity in any state', () => {
		for (const connectivity of ['connected', 'syncing', 'disconnected'] as const) {
			expect(workspaceSyncNotices(status({ connectivity }))).toEqual([]);
		}
	});

	it('says nothing about stale server proof or settled changes', () => {
		expect(
			workspaceSyncNotices(status({ staleServerProofWindows: 3, settledMutations: 9 }))
		).toEqual([]);
	});

	it('reports a change that has not reached the server', () => {
		const [notice] = workspaceSyncNotices(status({ pendingMutations: 2 }));
		expect(notice?.key).toBe('pending');
		expect(notice?.title).toBe('2 changes not yet saved to the server');
		expect(notice?.description).toContain('Durable on this device');
	});

	it('reports work the server refused, and says it was not discarded', () => {
		const [notice] = workspaceSyncNotices(
			status({
				issues: [{ mutationId: 'm1', kind: 'rejected', message: 'refused', atEpochMs: 1 }]
			})
		);
		expect(notice?.key).toBe('issues');
		expect(notice?.description).toContain('not silently discarded');
	});

	it('says nothing at all when there is no signal', () => {
		expect(workspaceSyncNotices(undefined)).toEqual([]);
	});
});
