import {
	EnvironmentName,
	ReleaseId,
	TenantId,
	syncRetainedPrefixBytes,
	type CollectionMutateRequest
} from '@norbital-ai/bolt-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	PUSH_PROBE_AFTER_MS,
	createSyncClient,
	type SyncWorkspaceAttachment
} from '../src/client/sync/client.js';
import { STALE_WRITE_MS } from '../src/client/sync/machine.js';
import type { BrowserSyncScope } from '../src/client/sync/sse-driver.js';

/**
 * A write whose request is still running is not stale. The Machine re-pushes an unsettled write
 * after STALE_WRITE_MS, which recovers a dropped socket; sent while the first request was still
 * being evaluated, the server answered `mutation_in_progress` and a payroll run that took twenty
 * seconds to build was reported as failed while it went on to succeed.
 */
const scope: BrowserSyncScope = {
	workspaceId: 'ws',
	tenantId: TenantId.make('tenant-1'),
	environment: EnvironmentName.make('test'),
	releaseId: ReleaseId.make('release-1')
};

const request = {
	protocolVersion: 2,
	idempotencyKey: 'write-1',
	issuedAtEpochMs: 0,
	partitionKey: 'p',
	schemaFingerprint: 'sha256:0',
	graph: { action: 'mutate', collection: 'jobs', rows: [] }
} as unknown as CollectionMutateRequest;

const attachment = (push: SyncWorkspaceAttachment['push']): SyncWorkspaceAttachment => ({
	scope,
	register: async () => ({ queries: [], outcomes: [] as const }),
	extend: async () => {
		throw new Error('extend is unused');
	},
	push,
	subscribe: () => () => undefined
});

describe('push in flight', () => {
	const clients: Array<{ shutdown: () => void }> = [];
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		for (const client of clients) client.shutdown();
		clients.length = 0;
		vi.useRealTimers();
	});

	it('does not resend a write whose request has not returned, and does once it has failed', async () => {
		let pushes = 0;
		let finish: (() => void) | undefined;
		const client = createSyncClient({ scope });
		clients.push(client);
		client.attach(
			attachment(
				() =>
					new Promise<void>((_resolve, reject) => {
						pushes += 1;
						finish = () => reject(new Error('socket closed'));
					})
			)
		);
		client.start();
		await vi.advanceTimersByTimeAsync(0);
		client.enqueue(request);
		await vi.advanceTimersByTimeAsync(0);
		expect(pushes).toBe(1);

		await vi.advanceTimersByTimeAsync(STALE_WRITE_MS * 3);
		expect(pushes).toBe(1);

		finish?.();
		await vi.advanceTimersByTimeAsync(STALE_WRITE_MS + 1);
		expect(pushes).toBe(2);
	});

	/**
	 * A request that never returns — the socket dropped after the server committed, the proxy
	 * swallowed the response — used to hold the in-flight guard forever: a spinner over a run that
	 * was already in the list. Past PUSH_PROBE_AFTER_MS the write is probed; the server answers a
	 * repeat of the same key with its persisted outcome, and the probe settles it.
	 */
	it('probes a write whose request has been out longer than PUSH_PROBE_AFTER_MS', async () => {
		let pushes = 0;
		const client = createSyncClient({ scope });
		clients.push(client);
		client.attach(
			attachment(
				() =>
					new Promise<void>(() => {
						pushes += 1;
					})
			)
		);
		client.start();
		await vi.advanceTimersByTimeAsync(0);
		client.enqueue(request);
		await vi.advanceTimersByTimeAsync(0);
		expect(pushes).toBe(1);

		await vi.advanceTimersByTimeAsync(PUSH_PROBE_AFTER_MS - STALE_WRITE_MS);
		expect(pushes).toBe(1);
		await vi.advanceTimersByTimeAsync(STALE_WRITE_MS * 2);
		expect(pushes).toBe(2);
		// The probe restarts the window: one a minute, not one a stale tick.
		await vi.advanceTimersByTimeAsync(PUSH_PROBE_AFTER_MS);
		expect(pushes).toBe(3);
	});
});
