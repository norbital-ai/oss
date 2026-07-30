import { PodSyncClient, type PgliteLike } from './pod-sync-client.js';
import { enableClientSync, getClientSync, type ClientSync } from './client-sync.js';
import type { SyncBootstrap, SyncFetch } from './types.js';
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

/**
 * Does this device already hold rows for this tenant?
 *
 * One bit, in `localStorage`, keyed by `<organizationId>:<userId>` so tenants can never read each
 * other's mark, and holding the replica epoch so a factory reset invalidates it. It exists because
 * the answer is needed *before* PGlite can be opened, and reading it costs nothing.
 *
 * The alternative — open the replica and look — is exactly the mistake this whole change is
 * undoing: opening PGlite takes 600–850ms on a cold device, and a page that waits that long to
 * discover it has nothing cached has spent the entire budget learning it should have asked the
 * server.
 */
const WARM_MARK_PREFIX = 'norbital-sync-warm:';

function warmMarkKey(replicaStamp: string): string {
	return `${WARM_MARK_PREFIX}${replicaStamp}`;
}

function readWarmMark(bootstrap: SyncBootstrap): boolean {
	try {
		return localStorage.getItem(warmMarkKey(bootstrap.replicaStamp)) === bootstrap.replicaEpoch;
	} catch {
		// Private mode, blocked storage: treat as cold. Being wrong here costs a round trip, never
		// correctness — the replica is still opened and still takes over once it is ready.
		return false;
	}
}

function writeWarmMark(bootstrap: SyncBootstrap): void {
	try {
		localStorage.setItem(warmMarkKey(bootstrap.replicaStamp), bootstrap.replicaEpoch);
	} catch {
		// Nothing to do — the next load simply starts cold again.
	}
}

/** The one in-flight bootstrap, and whether it is worth waiting for. */
let bootstrapping: Promise<ClientSync | null> | null = null;
let replicaHoldsRows = false;

/**
 * Resolve to the local replica when reading from it is the fast path, or to null when it is not.
 *
 * This is the whole decision, and it turns on one thing: does this device already have the rows?
 *
 *   warm — wait. The replica answers in ~40ms and the wait is what makes a refresh instant.
 *          Peeking instead of waiting is what made every reload pay a full server round trip
 *          while a complete replica sat unopened.
 *   cold — do not wait. There is nothing to serve, so the server is genuinely the fast path.
 *          The replica opens behind this read and takes over the moment its catch-up lands,
 *          because a completed catch-up notifies its collection and re-runs the cached query.
 */
export function clientSyncReady(): Promise<ClientSync | null> {
	const existing = getClientSync();
	if (existing) return Promise.resolve(existing);
	if (!replicaHoldsRows) return Promise.resolve(null);
	return bootstrapping ?? Promise.resolve(null);
}

export function bootstrapClientSync(
	bootstrap: SyncBootstrap | null | undefined
): Promise<ClientSync | null> {
	const existing = getClientSync();
	if (existing) return Promise.resolve(existing);
	if (typeof window === 'undefined' || !bootstrap) return Promise.resolve(null);
	replicaHoldsRows = readWarmMark(bootstrap);
	return (bootstrapping ??= openReplica(bootstrap));
}

async function openReplica(bootstrap: SyncBootstrap): Promise<ClientSync | null> {
	const { schemaSql, replicaStamp, replicaEpoch } = bootstrap;
	if (!schemaSql.trim() || !replicaStamp || !replicaEpoch) return null;
	try {
		// Tabs for the same organization and user share one catch-up. A different identity gets a
		// different replica, so policy-scoped residency can never be reused as another user.
		const db = await createBrowserPglite(schemaSql, replicaStamp);

		const client = new PodSyncClient({ db, schemaSql, replicaEpoch, fetch: browserSyncFetch });
		await client.bootstrap();
		const sync = enableClientSync(client);
		// Adopt persisted per-collection state before the first read so a warm reload answers
		// locally at frame 1 instead of re-downloading collections it already has.
		await sync.registry.restore();

		// Record that this device is worth waiting for next time. If the replica came back with
		// collections already resident it is warm now; otherwise the first completed catch-up says
		// so. A reset mints a new epoch, which retires the old mark rather than trusting it.
		if (sync.registry.size > 0) writeWarmMark(bootstrap);
		else {
			const stop = client.onChange(() => {
				stop();
				writeWarmMark(bootstrap);
			});
		}

		// Connect immediately. The old three-second delay left every change in that window to be
		// picked up only by the next reconnect.
		client.startStream();
		return sync;
	} catch (err) {
		console.error('[pod-sync] client bootstrap failed; using server transport', err);
		return null;
	}
}
