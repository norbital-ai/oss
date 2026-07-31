import { PodSyncClient, type PgliteLike } from './pod-sync-client.js';
import {
	announceClientSyncReady,
	disableClientSync,
	enableClientSync,
	getClientSync,
	type ClientSync
} from './client-sync.js';
import type { SyncBootstrap, SyncFetch } from './types.js';
import { withTimeout } from '@norbital-ai/std';

/**
 * Main-thread bridge to a SharedWorker-hosted PGlite.
 *
 * Implements `PgliteLike` so PodSyncClient and the rest of the sync layer see the same interface
 * whether backed by a direct in-tab PGlite (Node tests) or a cross-tab SharedWorker (browser).
 * Messages are serialised through postMessage; the bridge tracks in-flight requests by id.
 */
export class PgliteWorkerBridge implements PgliteLike {
	private readonly port: MessagePort;
	private failure: Error | null = null;
	private nextId = 0;
	private readonly pending = new Map<
		number,
		{
			resolve: (value: { rows: Record<string, unknown>[]; affectedRows?: number }) => void;
			reject: (error: Error) => void;
		}
	>();

	constructor(worker: Pick<SharedWorker, 'port' | 'onerror'>) {
		this.port = worker.port;
		this.port.onmessage = this.handleMessage;
		this.port.start();
		worker.onerror = (event) => {
			this.fail(new Error(event.message || 'SharedWorker PGlite error'));
		};
	}

	private fail(error: Error): void {
		this.failure = error;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}

	private handleMessage = (
		event: MessageEvent<{
			type: string;
			id: number;
			rows?: unknown;
			affectedRows?: number;
			message?: string;
		}>
	): void => {
		const msg = event.data;
		const pending = this.pending.get(msg.id);
		if (!pending) return;
		this.pending.delete(msg.id);

		if (msg.type === 'result') {
			pending.resolve({
				rows: (msg.rows as Record<string, unknown>[]) ?? [],
				affectedRows: msg.affectedRows
			});
		} else if (msg.type === 'bootstrapped') {
			pending.resolve({ rows: [], affectedRows: 0 });
		} else if (msg.type === 'error') {
			pending.reject(new Error(msg.message ?? 'PGlite worker error'));
		} else {
			pending.reject(new Error(`Unknown PGlite worker response: ${msg.type}`));
		}
	};

	private async send(
		type: string,
		payload: Record<string, unknown>
	): Promise<{ rows: Record<string, unknown>[]; affectedRows?: number }> {
		if (this.failure) throw this.failure;
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				this.port.postMessage({ type, id, ...payload });
			} catch (error) {
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	async bootstrap(schemaSql: string, dataDir: string): Promise<void> {
		await this.send('bootstrap', { schemaSql, dataDir });
	}

	async query<T = Record<string, unknown>>(
		sql: string,
		params?: unknown[]
	): Promise<{ rows: T[]; affectedRows?: number }> {
		const result = await this.send('query', { sql, params });
		return { rows: result.rows as T[], affectedRows: result.affectedRows };
	}

	async exec(sql: string): Promise<unknown> {
		return this.send('exec', { sql });
	}

	async close(): Promise<void> {
		this.port.close();
		this.fail(new Error('SharedWorker PGlite port closed'));
	}
}

/** Which of this origin's two replica databases a tab ended up on. */
type ReplicaMode = 'shared' | 'tab';

/**
 * How long to wait for the cross-tab replica before falling back to a tab-local one.
 *
 * A cold boot here is PGlite's WASM download plus IndexedDB open inside a worker that is starting
 * for the first time, and it competes with whatever the page is doing. The bound exists so a
 * genuinely broken
 * SharedWorker cannot hang the workspace, not to police a slow one, so it is generous.
 */
const SHARED_WORKER_BOOTSTRAP_TIMEOUT_MS = 30_000;

function replicaDataDir(replicaStamp: string, mode: ReplicaMode): string {
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

/**
 * Open this tenant's replica, and say which of the two databases was opened.
 *
 * The mode is not a detail. `shared` and `tab` are separate IndexedDB databases with separate
 * contents, so "this device already holds the rows" is only ever true *of one of them*. A caller
 * that does not know which one it got cannot know whether waiting for it is the fast path.
 */
async function createBrowserPglite(
	schemaSql: string,
	replicaStamp: string
): Promise<{ db: PgliteLike; mode: ReplicaMode }> {
	if (typeof SharedWorker === 'undefined') {
		console.warn('[pod-sync] SharedWorker is not supported; using a tab-local replica');
		return { db: await createDirectPglite(replicaDataDir(replicaStamp, 'tab')), mode: 'tab' };
	}
	let worker: SharedWorker | undefined;
	try {
		worker = new SharedWorker(new URL('./pglite-worker.js', import.meta.url), {
			type: 'module',
			name: `norbital-pglite-${replicaStamp}`
		});
		const bridge = new PgliteWorkerBridge(worker);
		await withTimeout(
			() => bridge.bootstrap(schemaSql, replicaDataDir(replicaStamp, 'shared')),
			SHARED_WORKER_BOOTSTRAP_TIMEOUT_MS,
			'SharedWorker PGlite bootstrap'
		);
		return { db: bridge, mode: 'shared' };
	} catch (error) {
		worker?.port.close();
		console.warn('[pod-sync] SharedWorker bootstrap failed; using a tab-local replica', error);
		return { db: await createDirectPglite(replicaDataDir(replicaStamp, 'tab')), mode: 'tab' };
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

/**
 * Keyed by replica MODE as well as identity, because the mark is a claim about one database.
 *
 * `shared` and `tab` are different IndexedDB databases. A single mark for both meant a tab that
 * failed over to the tab-local replica inherited the shared replica's "this device has the rows"
 * answer — and then `clientSyncReady` waited on an empty database for a full catch-up instead of
 * reading from the server. That is the worst of both: the slow path, chosen for being the fast one.
 */
function warmMarkKey(replicaStamp: string, mode: ReplicaMode): string {
	return `${WARM_MARK_PREFIX}${mode}:${replicaStamp}`;
}

function readWarmMark(bootstrap: SyncBootstrap, mode: ReplicaMode): boolean {
	try {
		return (
			localStorage.getItem(warmMarkKey(bootstrap.replicaStamp, mode)) === bootstrap.replicaEpoch
		);
	} catch {
		// Private mode, blocked storage: treat as cold. Being wrong here costs a round trip, never
		// correctness — the replica is still opened and still takes over once it is ready.
		return false;
	}
}

function writeWarmMark(bootstrap: SyncBootstrap, mode: ReplicaMode): void {
	try {
		localStorage.setItem(warmMarkKey(bootstrap.replicaStamp, mode), bootstrap.replicaEpoch);
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
	// Answered before the replica opens, so it has to assume the mode it is about to attempt.
	// `openReplica` corrects it if the attempt falls back to the other database.
	replicaHoldsRows = readWarmMark(bootstrap, 'shared');
	return (bootstrapping ??= openReplica(bootstrap));
}

async function openReplica(bootstrap: SyncBootstrap): Promise<ClientSync | null> {
	const { schemaSql, replicaStamp, replicaEpoch } = bootstrap;
	if (!schemaSql.trim() || !replicaStamp || !replicaEpoch) return null;
	try {
		// Tabs for the same organization and user share one catch-up. A different identity gets a
		// different replica, so policy-scoped residency can never be reused as another user.
		const { db, mode } = await createBrowserPglite(schemaSql, replicaStamp);
		// The mode assumed in `bootstrapClientSync` may not be the one we got. Re-answer against the
		// database actually open, so a fallback stops claiming rows it does not have.
		replicaHoldsRows = readWarmMark(bootstrap, mode);

		const client = new PodSyncClient({ db, schemaSql, replicaEpoch, fetch: browserSyncFetch });
		await client.bootstrap();
		const sync = enableClientSync(client);
		// Adopt persisted per-collection state before the first read so a warm reload answers
		// locally at frame 1 instead of re-downloading collections it already has.
		await sync.registry.restore();
		const restoredCollections = sync.registry.size > 0;

		// Record that this device is worth waiting for next time. If the replica came back with
		// collections already resident it is warm now; otherwise the first completed catch-up says
		// so. A reset mints a new epoch, which retires the old mark rather than trusting it.
		if (sync.registry.size > 0) writeWarmMark(bootstrap, mode);
		else {
			const stop = client.onChange(() => {
				stop();
				writeWarmMark(bootstrap, mode);
			});
		}

		// Connect immediately. The old three-second delay left every change in that window to be
		// picked up only by the next reconnect.
		client.startStream();
		if (restoredCollections) {
			// Persisted residency proves completeness only at its saved cursor. Until the live feed
			// crosses the head observed for this document, reads use the authoritative server tier;
			// otherwise returning to an identity can render rows created while it was signed out as
			// absent. A failure to establish the barrier leaves the replica server-first, which is
			// slower and correct rather than faster and wrong.
			void client
				.serverSequence()
				.then((sequence) => client.waitForSequence(sequence, { timeoutMs: 30_000 }))
				.then((fresh) => {
					if (fresh) sync.registry.markRestoredFresh();
				})
				.catch(() => undefined);
		}
		// A cold load's reads resolved from the server before this existed, so they registered no
		// collection and subscribed to nothing — a surface mounted once, like the notification bell,
		// would sit on that first answer forever. Re-running them is what makes the page live.
		if (!replicaHoldsRows) announceClientSyncReady();
		return sync;
	} catch (err) {
		console.error('[pod-sync] client bootstrap failed; using server transport', err);
		return null;
	}
}
