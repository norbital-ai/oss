import type { CollectionMutationIdempotencyKey } from '@norbital-ai/bolt-protocol';
import { createSyncStatusView } from '../../src/client/sync-status.svelte.js';
import type { SyncClient } from '../../src/client/sync/index.js';
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
	it('projects the Machine current state instead of retaining a mutable Svelte copy', () => {
		let current = state({ link: 'reconnecting', reconnectAttempt: 1 });
		const sync = {
			start: () => undefined,
			current: () => current,
			subscribe: (listener) => {
				listener(current);
				return () => undefined;
			},
			mount: () => {
				throw new Error('not used');
			},
			enqueue: () => undefined
		} satisfies SyncClient;
		const view = createSyncStatusView(sync);
		expect(view.link).toBe('reconnecting');
		expect(view.reconnectAttempt).toBe(1);

		current = state({ link: 'live', reconnectAttempt: 2 });
		expect(view.link).toBe('live');
		expect(view.reconnectAttempt).toBe(2);
	});

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
					request: {
						protocolVersion: 2,
						idempotencyKey: 'w1' as CollectionMutationIdempotencyKey,
						issuedAtEpochMs: 1,
						partitionKey: 'partition',
						schemaFingerprint: 'schema',
						graph: { action: 'delete', collection: 'tasks', id: 'a' },
						baseVersions: []
					},
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
