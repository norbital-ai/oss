import { describe, expect, it } from 'vitest';
import type { WorkspaceSyncStatus } from '../../src/client/runtime.js';
import { createWorkspaceSyncStatus } from '../../src/client/replica/sync-status.js';
import { workspaceSyncNotices } from '../../src/client/ui/shell/sync-status-presentation.js';

const status = (overrides: Partial<WorkspaceSyncStatus> = {}): WorkspaceSyncStatus => ({
	connectivity: 'online',
	offlineRetainedOnly: false,
	staleServerProofWindows: 0,
	pendingMutations: 0,
	settledMutations: 0,
	issues: [],
	revision: 0,
	...overrides
});

describe('workspace sync status presentation', () => {
	it('requires explicit stream evidence before reporting online', () => {
		const signal = createWorkspaceSyncStatus();

		expect(signal.current()).toMatchObject({
			connectivity: 'unverified',
			offlineRetainedOnly: true
		});
		signal.markStreamConnecting();
		expect(signal.current().connectivity).toBe('connecting');
		signal.markStreamReady();
		expect(signal.current()).toMatchObject({
			connectivity: 'online',
			offlineRetainedOnly: false
		});
		signal.markStreamDisconnected();
		expect(signal.current()).toMatchObject({
			connectivity: 'disconnected',
			offlineRetainedOnly: true
		});
		signal.close();
	});

	it('fails closed when the runtime publishes no status signal', () => {
		const notices = workspaceSyncNotices(undefined);

		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({
			key: 'unavailable',
			title: 'Sync status unavailable'
		});
		expect(notices[0]?.description).toContain('cannot be verified');
		expect(notices.map(({ title }) => title)).not.toContain('Up to date');
	});

	it('never presents offline retained data as an exact result', () => {
		const notices = workspaceSyncNotices(
			status({ connectivity: 'offline', offlineRetainedOnly: true })
		);
		const offline = notices.find(({ key }) => key === 'offline');

		expect(offline?.title).toBe('Offline — downloaded data only');
		expect(offline?.description).toContain('may be incomplete');
		expect(JSON.stringify(offline)).not.toMatch(/exact/i);
	});

	it('does not treat browser reachability as proof of a live sync stream', () => {
		const notices = workspaceSyncNotices(
			status({ connectivity: 'unverified', offlineRetainedOnly: true })
		);
		const connection = notices.find(({ key }) => key === 'unverified');

		expect(connection?.title).toBe('Sync connection unverified');
		expect(connection?.description).toContain('not proof of a live sync stream');
		expect(notices.find(({ key }) => key === 'settled')).toBeUndefined();
	});

	it('keeps server-proof windows visibly stale until the engine restores proof', () => {
		const stale = workspaceSyncNotices(status({ staleServerProofWindows: 2 })).find(
			({ key }) => key === 'stale'
		);

		expect(stale?.title).toBe('2 server-verified results may be out of date');
		expect(stale?.description).toContain('last verified value');
	});

	it('distinguishes local durability from authoritative server settlement', () => {
		const pending = workspaceSyncNotices(status({ pendingMutations: 3 }));

		expect(pending.find(({ key }) => key === 'pending')?.title).toBe(
			'3 changes saved on this device'
		);
		expect(pending.find(({ key }) => key === 'pending')?.description).toContain(
			'awaiting server confirmation'
		);
		expect(pending).toHaveLength(1);

		const settled = workspaceSyncNotices(status({ settledMutations: 3 }));
		expect(settled.find(({ key }) => key === 'settled')?.title).toBe(
			'All locally saved changes confirmed'
		);
	});

	it('surfaces rejected and quarantined work as one durable issue summary', () => {
		const issues = workspaceSyncNotices(
			status({
				issues: [
					{
						mutationId: 'mutation-rejected',
						kind: 'rejected',
						message: 'The record changed before this edit settled.',
						atEpochMs: 1
					},
					{
						mutationId: 'mutation-quarantined',
						kind: 'quarantined',
						message: 'This offline edit needs a compatible release.',
						atEpochMs: 2
					}
				]
			})
		).find(({ key }) => key === 'issues');

		expect(issues?.title).toBe('2 sync issues need attention');
		expect(issues?.description).toContain('1 rejected and 1 quarantined');
		expect(issues?.description).toContain('not silently discarded');
	});
});
