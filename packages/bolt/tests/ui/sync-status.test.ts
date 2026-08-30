import type { CollectionMutationIdempotencyKey } from '@norbital-ai/bolt-protocol';
import type { ClientState } from '../../src/client/sync/machine.js';
import {
	workspaceSyncIndicator,
	workspaceSyncNotices
} from '../../src/client/ui/shell/sync-status-presentation.js';
import { describe, expect, it } from 'vitest';

const state = (overrides: Partial<ClientState> = {}): ClientState => ({
	link: 'live',
	queries: new Map(),
	writes: new Map(),
	reconnectAttempt: 0,
	reconnectAt: 0,
	...overrides
});

describe('live sync presentation', () => {
	it('renders only the Machine link states', () => {
		expect(workspaceSyncIndicator(state())).toMatchObject({ state: 'live', label: 'Connected' });
		expect(workspaceSyncIndicator(state({ link: 'reconnecting' }))).toMatchObject({
			state: 'reconnecting',
			label: 'Reconnecting'
		});
		expect(workspaceSyncIndicator(state({ link: 'needsReload' }))).toMatchObject({
			state: 'needsReload',
			label: 'Reload required'
		});
	});

	it('describes pending writes as tab memory, never durable device storage', () => {
		const writes: ClientState['writes'] = new Map([
			[
				'w1' as CollectionMutationIdempotencyKey,
				{
					graph: { action: 'delete', collection: 'tasks', id: 'a' },
					phase: 'sent',
					sentAt: 1
				}
			]
		]);
		const [notice] = workspaceSyncNotices(state({ writes }));
		expect(notice?.key).toBe('pending');
		expect(notice?.description).toContain('this tab');
		expect(notice?.description).not.toContain('Durable');
	});

	it('exposes one reload affordance for a terminal release mismatch', () => {
		expect(workspaceSyncNotices(state({ link: 'needsReload' }))).toEqual([
			expect.objectContaining({ key: 'reload', title: 'Workspace update required' })
		]);
	});
});
