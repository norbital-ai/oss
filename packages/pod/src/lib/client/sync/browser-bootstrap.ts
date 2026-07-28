import { PodSyncClient, type PgliteLike } from './pod-sync-client.js';
import { enableClientSync, getClientSync, type ClientSync } from './client-sync.js';
import { SYNC_REPLICA_EPOCH_HEADER, SYNC_REPLICA_STAMP_HEADER, type SyncFetch } from './types.js';
import { withTimeout } from '@norbital-ai/std';

function replicaDataDir(replicaStamp: string, mode: 'shared' | 'tab'): string {
	return `idb://norbital-pod-sync-${mode}-${encodeURIComponent(replicaStamp)}`;
}

const browserSyncFetch: SyncFetch = (path, init) =>
	fetch(`/_runtime/${path}`, {
		method: init.method,
		credentials: 'include',
		headers: {
			...(init.body ? { 'content-type': 'application/json' } : {}),
			...(init.accept ? { accept: init.accept } : {})
		},
		...(init.body ? { body: init.body } : {}),
		signal: init.signal
	});

async function createDirectPglite(dataDir: string): Promise<PgliteLike> {
	const { PGlite } = await import('@electric-sql/pglite');
	return (await PGlite.create(dataDir)) as unknown as PgliteLike; // stupidity: boundary-cast — PGlite's concrete generic query result satisfies the narrower replica interface.
}

async function createBrowserPglite(schemaSql: string, replicaStamp: string): Promise<PgliteLike> {
	if (typeof SharedWorker === 'undefined') {
		console.warn('[pod-sync] SharedWorker is not supported; using a tab-local replica');
		return createDirectPglite(replicaDataDir(replicaStamp, 'tab'));
	}
	let worker: SharedWorker | undefined;
	try {
		const { PgliteWorkerBridge } = await import('./pglite-worker-bridge.js');
		worker = new SharedWorker(new URL('./pglite-worker.js', import.meta.url), {
			type: 'module',
			name: `norbital-pglite-${replicaStamp}`
		});
		const bridge = new PgliteWorkerBridge(worker);
		await withTimeout(
			() => bridge.bootstrap(schemaSql, replicaDataDir(replicaStamp, 'shared')),
			10_000,
			'SharedWorker PGlite bootstrap'
		);
		return bridge;
	} catch (error) {
		worker?.port.close();
		console.warn('[pod-sync] SharedWorker bootstrap failed; using a tab-local replica', error);
		return createDirectPglite(replicaDataDir(replicaStamp, 'tab'));
	}
}

export async function bootstrapClientSync(): Promise<ClientSync | null> {
	const existing = getClientSync();
	if (existing) return existing;
	if (typeof window === 'undefined') return null;
	try {
		const response = await fetch('/_runtime/sync/schema', { credentials: 'include' });
		if (!response.ok) return null;
		const schemaSql = await response.text();
		const replicaStamp = response.headers.get(SYNC_REPLICA_STAMP_HEADER)?.trim();
		const replicaEpoch = response.headers.get(SYNC_REPLICA_EPOCH_HEADER)?.trim();
		if (!schemaSql.trim() || !replicaStamp || !replicaEpoch) return null;

		// Tabs for the same organization and user share one catch-up. A different identity gets a
		// different replica, so policy-scoped residency can never be reused as another user.
		const db = await createBrowserPglite(schemaSql, replicaStamp);

		const client = new PodSyncClient({ db, schemaSql, replicaEpoch, fetch: browserSyncFetch });
		await client.bootstrap();
		const sync = enableClientSync(client);
		// Adopt persisted per-collection state before the first read so a warm reload answers
		// locally at frame 1 instead of re-downloading collections it already has.
		await sync.registry.restore();
		// Connect immediately. The old three-second delay left every change in that window to be
		// picked up only by the next reconnect.
		client.startStream();
		return sync;
	} catch (err) {
		console.error('[pod-sync] client bootstrap failed; using server transport', err);
		return null;
	}
}
