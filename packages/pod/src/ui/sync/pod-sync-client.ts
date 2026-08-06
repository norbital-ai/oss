import { abortableDelay } from '$lib/shared/abortable-delay.js';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import type {
	CollectionSyncState,
	MutateResponse,
	MutationResult,
	ShapeRequest,
	ShapeResponse,
	SyncCursor,
	SyncDiff,
	SyncFetch,
	WireMutation
} from './types.js';
import { encodeBase64Url } from './base64url.js';

/** Minimal PGlite surface the client needs — satisfied by @electric-sql/pglite in browser and Node. */
export type PgliteLike = {
	query<T = Record<string, unknown>>(
		sql: string,
		params?: unknown[]
	): Promise<{ rows: T[]; affectedRows?: number }>;
	exec(sql: string): Promise<unknown>;
	close?(): Promise<void>;
};

const PKEY = 'norbital_id';
const VERSION = 'norbital_row_version';
/** Pause between SSE connections, so a stream that ends immediately can't become a hot loop. */
const RECONNECT_DELAY_MS = 500;
/** Quiet period before a newly subscribed collection rotates the open stream connection. */
const SUBSCRIPTION_ROTATE_DELAY_MS = 250;
/**
 * How soon a queued write retries itself, and how far that retry is allowed to back off.
 *
 * The outbox used to drain in exactly one place: the top of a stream *iteration*, which is only
 * reached when a new SSE connection is established. A healthy stream stays connected for minutes,
 * so a write that queued behind one failed request sat there until a proxy timed the feed out —
 * the reported "it committed a minute later for no reason". A queued write now retries on its own
 * clock, and the ceiling bounds how long recovery can take once the server comes back.
 */
const OUTBOX_RETRY_MIN_MS = 1_000;
const OUTBOX_RETRY_MAX_MS = 10_000;
/**
 * Ceiling on a single `sync/*` POST.
 *
 * These requests carried no signal and no deadline, so a connection that was accepted and then
 * never answered — the ordinary failure mode of a dropped route, not an exotic one — left the
 * awaiting promise pending for as long as the tab lived. That is worse than an error: a catch-up
 * page that never returns holds the registry's serialized catch-up queue, and every other
 * collection's `register()` waits behind it forever, so reads that depend on them never resolve
 * and never retry. Generous, because a bulk catch-up page is 5,000 rows over whatever link the
 * user has; the point is that it is finite.
 */
const REQUEST_TIMEOUT_MS = 60_000;
/** Postgres binds at most this many parameters per statement: the count is a signed int16. */
const MAX_BIND_PARAMETERS = 32_767;

const META_TABLE = `CREATE TABLE IF NOT EXISTS _pod_meta (key TEXT PRIMARY KEY, value TEXT)`;
/**
 * Mutations that have not settled with the server yet, kept in submission order.
 *
 * `snapshot` is the row as it stood *before* the optimistic apply. A retry runs against a replica
 * that already shows the mutation, so re-deriving the undo at retry time would derive the mutated
 * state; a rejected queued delete would then stay deleted locally forever. The undo is therefore
 * captured once, when the mutation is first applied, and travels with it.
 */
const PENDING_TABLE = `CREATE TABLE IF NOT EXISTS _pod_pending (
	client_id TEXT PRIMARY KEY,
	collection TEXT NOT NULL,
	action TEXT NOT NULL,
	row JSONB,
	snapshot JSONB,
	base_version INTEGER,
	created_at BIGINT NOT NULL
)`;
/**
 * Which collections this replica holds, surviving reload. Without this every reload is a cold
 * start: the replica still has the rows but nothing remembers that, so every collection is
 * re-downloaded before the first paint.
 */
const SYNC_STATE_TABLE = `CREATE TABLE IF NOT EXISTS _pod_sync_state (
	collection TEXT PRIMARY KEY,
	resident BOOLEAN NOT NULL,
	row_count INTEGER NOT NULL,
	byte_count BIGINT,
	synced_at BIGINT NOT NULL
)`;

/** Internal bookkeeping tables — never part of the tenant schema, never dropped by reconciliation. */
const INTERNAL_TABLES = ['_pod_meta', '_pod_pending', '_pod_sync_state'] as const;
const INTERNAL_TABLE_SET = new Set<string>(INTERNAL_TABLES);

/**
 * Shape version of the bookkeeping tables above.
 *
 * The replica is a cache, so its bookkeeping never needs a migration: a version that does not match
 * means the tables were written by a different build, and the correct answer is to drop them and
 * catch up again. Bumping this is the whole procedure — there is no per-column `ADD COLUMN` ladder
 * to maintain, and therefore no way for one to be forgotten and leave a half-shaped table behind.
 */
const INTERNAL_SCHEMA_VERSION = '2';

type ChangeListener = (collection: string) => void;

/** The row a mutation replaced, restored verbatim if the server refuses the mutation. */
type PendingUndo = Record<string, unknown>;

export type PodSyncClientOptions = {
	readonly db: PgliteLike;
	readonly schemaSql: string;
	/**
	 * Physical tenant-database identity. A new value invalidates all cached rows and mutations.
	 *
	 * Required, because it is the only trustworthy answer to "are the rows on this device still
	 * about the same database?". A factory reset replaces the database while the organization and
	 * user ids that name the replica stay the same, and it leaves no diffs behind — rows vanish by
	 * TRUNCATE, not by `delete` — so nothing on the feed would ever tell the replica to evict them.
	 */
	readonly replicaEpoch: string;
	readonly fetch: SyncFetch;
	readonly now?: () => number;
};

const syncCursorSchema = z.object({ xid: z.string(), seq: z.string() });
const syncDiffSchema = z.object({
	seq: z.string(),
	xid: z.string(),
	collection: z.string(),
	action: z.enum(['insert', 'update', 'delete', 'leave']),
	id: z.string(),
	version: z.number().nullable(),
	row: z.record(z.string(), z.unknown()).optional()
});

type ParsedStreamFrame =
	| { readonly type: 'diff'; readonly diff: SyncDiff }
	| { readonly type: 'cursor'; readonly cursor: SyncCursor };

/** One SSE frame → a diff/control message, or null for comments, heartbeats, or malformed data. */
function parseSseFrame(frame: string): ParsedStreamFrame | null {
	// The server has pruned past this client's resume point. Nothing in the frame is a diff; the
	// only correct response is to throw away the replica and rebuild, which the stream loop does
	// by rethrowing this as a distinguishable error.
	if (frame.split('\n').some((line) => line.trim() === 'event: reset')) {
		throw new SyncResetRequired();
	}
	if (frame.split('\n').some((line) => line.trim() === 'event: scope-reset')) {
		const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
		const parsed = syncCursorSchema.safeParse(
			JSON.parse(dataLine?.slice('data:'.length).trim() || 'null')
		);
		if (!parsed.success) throw new Error('sync scope reset carried an invalid cursor');
		throw new SyncScopeChanged(parsed.data);
	}
	if (frame.split('\n').some((line) => line.trim() === 'event: cursor')) {
		const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
		const parsed = syncCursorSchema.safeParse(
			JSON.parse(dataLine?.slice('data:'.length).trim() || 'null')
		);
		return parsed.success ? { type: 'cursor', cursor: parsed.data } : null;
	}
	if (frame.split('\n').some((line) => line.trim() === 'event: error')) {
		const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
		const detail = dataLine?.slice('data:'.length).trim();
		throw new Error(`sync stream failed${detail ? `: ${detail}` : ''}`);
	}
	const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
	if (!dataLine) return null;
	const json = dataLine.slice('data:'.length).trim();
	if (!json) return null;
	try {
		const validated = syncDiffSchema.safeParse(JSON.parse(json));
		return validated.success ? { type: 'diff', diff: validated.data } : null;
	} catch {
		return null;
	}
}

function encodeStreamCursor(cursor: SyncCursor): string {
	return encodeBase64Url(JSON.stringify(cursor));
}

/** Feed order over `(xid, seq)`; a malformed value never counts as progress. */
function isAfter(candidate: SyncCursor, current: SyncCursor): boolean {
	try {
		const xid = BigInt(candidate.xid);
		const currentXid = BigInt(current.xid);
		if (xid !== currentXid) return xid > currentXid;
		return BigInt(candidate.seq) > BigInt(current.seq);
	} catch {
		return false;
	}
}

/** The server can no longer resume this replica; it has to be discarded and rebuilt. */
export class SyncResetRequired extends Error {
	constructor() {
		super('sync cursor is older than the server retention window');
		this.name = 'SyncResetRequired';
	}
}

/** The policy-bearing scope changed; rebuild rows and resume after the announcing transaction. */
export class SyncScopeChanged extends Error {
	constructor(readonly cursor: SyncCursor) {
		super('sync authorization scope changed');
		this.name = 'SyncScopeChanged';
	}
}

/**
 * Statuses that mean the request never reached anything able to answer it.
 *
 * 502/503/504 are an edge reporting that it has no healthy upstream, and 408 is a request that
 * timed out before it was handled. Every other status — 401, 403, 404, 409 included — is the
 * server answering, and answering is proof of reachability however unwelcome the answer is.
 */
function isTransportFailureStatus(status: number): boolean {
	return status === 408 || status === 502 || status === 503 || status === 504;
}

/** A request this client cancelled on purpose (stream rotation, teardown) — never a failure. */
function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}

/** One unsent outbox entry, as the planner needs to see it. */
type PendingEntry = {
	readonly clientId: string;
	readonly action: WireMutation['action'];
	readonly row: Record<string, unknown> | null;
};

/** How each mutation in a batch reaches the server, given what is still unsent for its record. */
type OutboxPlan = {
	/** Nothing unsent names this record: send it now. */
	readonly direct: WireMutation[];
	/** Something unsent names this record: append to the outbox so order is preserved. */
	readonly sequenced: WireMutation[];
	/** Resolved without a round trip, by folding into (or cancelling) what was already queued. */
	readonly resolved: MutationResult[];
	/** Collections the resolved/sequenced work touched, for the optimistic repaint. */
	readonly touched: Set<string>;
};

/** Key for "this record", so pending entries can be found by collection and id together. */
function recordKey(collection: string, id: string): string {
	return `${collection}\u0000${id}`;
}

export class PodSyncClient {
	readonly db: PgliteLike;
	private readonly schemaSql: string;
	private readonly replicaEpoch: string;
	private readonly httpFetch: SyncFetch;
	private readonly now: () => number;
	private readonly listeners = new Set<ChangeListener>();
	private readonly resetListeners = new Set<() => void>();
	private readonly cursorListeners = new Set<() => void>();
	private readonly subscribedCollections = new Set<string>();
	private rotateTimer: ReturnType<typeof setTimeout> | null = null;
	private cursor: SyncCursor = { xid: '0', seq: '0' };
	private cursorInitialized = false;
	private streamAbort: AbortController | null = null;
	private connectionAbort: AbortController | null = null;
	private streamLoop: Promise<void> | null = null;
	private booted = false;
	private closed = false;
	private drainTimer: ReturnType<typeof setTimeout> | null = null;
	private drainDueAt = Number.POSITIVE_INFINITY;
	private drainDelayMs = OUTBOX_RETRY_MIN_MS;
	private draining = false;
	/**
	 * Monotonic stamp for the next outbox entry. The drain orders by `created_at`, and two writes
	 * can land inside the same millisecond — a programmatic pair, a fast double tap — so a wall
	 * clock alone can tie, and a tie puts the queue's order back in the lap of the storage engine.
	 * Each entry stamps strictly after the one before it.
	 */
	private outboxClock = 0;
	lastError: unknown = undefined;

	constructor(options: PodSyncClientOptions) {
		this.db = options.db;
		this.schemaSql = options.schemaSql;
		const epoch = options.replicaEpoch.trim();
		if (!epoch) throw new Error('PodSyncClient requires a replicaEpoch');
		this.replicaEpoch = epoch;
		this.httpFetch = options.fetch;
		this.now = options.now ?? (() => Date.now());
		this.watchBrowserConnectivity();
	}

	async bootstrap(): Promise<void> {
		if (this.booted) return;
		await this.reconcileInternalSchema();
		await this.reconcileReplicaEpoch();
		await this.reconcileSchema();

		const savedCursor = await this.readMeta('cursor');
		if (savedCursor) {
			try {
				const parsed = syncCursorSchema.safeParse(JSON.parse(savedCursor));
				if (!parsed.success) throw new Error('invalid persisted sync cursor');
				this.cursor = parsed.data;
				this.cursorInitialized = true;
			} catch {
				this.cursor = { xid: '0', seq: '0' };
			}
		}
		this.booted = true;
	}

	/**
	 * Bring the bookkeeping tables to the shape this build expects.
	 *
	 * `_pod_meta` is created first because it holds the answer; a read that fails because its own
	 * shape changed is itself a mismatch. Any mismatch drops all three tables and every synced row:
	 * catch-up state is what tells the replica which rows it is allowed to keep, so restarting
	 * without it would leave rows deleted on the server sitting in the replica forever.
	 */
	private async reconcileInternalSchema(): Promise<void> {
		await this.db.exec(`${META_TABLE};`);
		const stored = await this.readMeta('internal_schema').catch(() => null);
		if (stored !== INTERNAL_SCHEMA_VERSION) {
			for (const table of [...(await this.introspectLocalSchema()).keys(), ...INTERNAL_TABLES]) {
				await this.db.query(`DROP TABLE IF EXISTS ${quoteIdent(table)} CASCADE`);
			}
			await this.db.exec(`${META_TABLE};`);
		}
		await this.db.exec(`${PENDING_TABLE};\n${SYNC_STATE_TABLE};`);
		if (stored !== INTERNAL_SCHEMA_VERSION) {
			await this.writeMeta('internal_schema', INTERNAL_SCHEMA_VERSION);
		}
	}

	/**
	 * A reset creates a new physical tenant database while stable organization/user ids continue to
	 * address the same browser replica. Clear that replica before its first read. Comparing feed
	 * sequence numbers cannot prove continuity: a large reseed can already have a higher watermark
	 * than the old database by the time the browser reconnects.
	 */
	private async reconcileReplicaEpoch(): Promise<void> {
		if ((await this.readMeta('replica_epoch')) === this.replicaEpoch) return;
		await this.discardReplica();
		await this.writeMeta('replica_epoch', this.replicaEpoch);
	}

	// ── schema reconciliation ───────────────────────────────────────────────────

	/**
	 * Bring the local schema to the server's, preserving synced rows wherever possible.
	 *
	 * The server ships additive, idempotent DDL (CREATE TABLE IF NOT EXISTS + one ADD COLUMN IF
	 * NOT EXISTS per column), so replaying it adds new tables and columns without touching data.
	 * Only genuinely destructive changes — a table or column that disappeared, which covers
	 * renames and retypes — drop anything, and then only the affected table, whose sync state is
	 * cleared so it re-catches-up on next use. A blanket wipe here would mean every additive
	 * workspace edit re-downloads the entire replica.
	 */
	private async reconcileSchema(): Promise<void> {
		const target = parseTargetSchema(this.schemaSql);
		// An unparseable schema (hand-written DDL in tests) yields no target; never drop on a guess.
		if (target.size > 0) {
			for (const [table, columns] of await this.introspectLocalSchema()) {
				const targetColumns = target.get(table);
				const destructive =
					!targetColumns || [...columns].some((column) => !targetColumns.has(column));
				if (!destructive) continue;
				await this.db.query(`DROP TABLE IF EXISTS ${quoteIdent(table)} CASCADE`);
				await this.db.query(`DELETE FROM _pod_sync_state WHERE collection = $1`, [table]);
			}
		}

		// Applying the DDL is the expensive part of boot (one statement per column). Skip it when
		// the server's schema is byte-identical to the one already applied to this replica.
		const fingerprint = schemaFingerprint(this.schemaSql);
		if ((await this.readMeta('schema')) === fingerprint) return;
		await this.db.exec(this.schemaSql);
		await this.writeMeta('schema', fingerprint);
	}

	private async introspectLocalSchema(): Promise<Map<string, Set<string>>> {
		const result = await this.db.query<{ table_name: string; column_name: string }>(
			`SELECT table_name, column_name FROM information_schema.columns
			  WHERE table_schema = 'public'`
		);
		const tables = new Map<string, Set<string>>();
		for (const row of result.rows) {
			if (INTERNAL_TABLE_SET.has(row.table_name)) continue;
			const columns = tables.get(row.table_name) ?? new Set<string>();
			columns.add(row.column_name);
			tables.set(row.table_name, columns);
		}
		return tables;
	}

	// ── persisted collection sync state ─────────────────────────────────────────

	/** Every collection this replica already holds. Read once at boot so warm data serves frame 1. */
	async loadSyncState(): Promise<Map<string, CollectionSyncState>> {
		const result = await this.db
			.query<{
				collection: string;
				resident: boolean;
				row_count: number;
				byte_count: string | number | null;
				synced_at: string | number;
			}>(`SELECT collection, resident, row_count, byte_count, synced_at FROM _pod_sync_state`)
			.catch(() => ({ rows: [] as never[] }));
		const state = new Map<string, CollectionSyncState>();
		for (const row of result.rows) {
			state.set(row.collection, {
				collection: row.collection,
				resident: row.resident === true,
				rows: Number(row.row_count),
				bytes: Number(row.byte_count ?? 0),
				syncedAt: Number(row.synced_at)
			});
		}
		return state;
	}

	/**
	 * `bytes` is nullable, and the column is too. A replica written before the residency budget
	 * moved to bytes has rows with no size recorded; reporting those as 0 is honest — nothing was
	 * measured — and the budget simply readmits that collection on its next catch-up.
	 */
	async recordSyncState(
		collection: string,
		resident: boolean,
		rows: number,
		bytes = 0
	): Promise<void> {
		await this.db.query(
			`INSERT INTO _pod_sync_state (collection, resident, row_count, byte_count, synced_at)
			 VALUES ($1, $2, $3, $4, $5)
			 ON CONFLICT (collection) DO UPDATE
			   SET resident = EXCLUDED.resident,
			       row_count = EXCLUDED.row_count,
			       byte_count = EXCLUDED.byte_count,
			       synced_at = EXCLUDED.synced_at`,
			[collection, resident, rows, bytes, this.now()]
		);
	}

	onChange(listener: ChangeListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onReset(listener: () => void): () => void {
		this.resetListeners.add(listener);
		return () => this.resetListeners.delete(listener);
	}

	/** Drop every synced row and all sync bookkeeping, keeping the schema. */
	private async discardReplica(resumeCursor?: SyncCursor): Promise<void> {
		const tables = [...(await this.introspectLocalSchema()).keys()];
		for (const table of tables) {
			await this.db.query(`DELETE FROM ${quoteIdent(table)}`).catch(() => undefined);
		}
		await this.db.query(`DELETE FROM _pod_sync_state`).catch(() => undefined);
		await this.db.query(`DELETE FROM _pod_pending`).catch(() => undefined);
		this.cursor = resumeCursor ?? { xid: '0', seq: '0' };
		this.cursorInitialized = resumeCursor != null;
		// A discard with no resume point leaves no cursor at all, rather than a persisted zero. A
		// stored zero reads back at boot as a real saved position, so the next catch-up would decline
		// to seed the cursor from its own watermark and the stream would resume from the start of the
		// feed — a full replay on every device that has just been reset or opened for the first time.
		if (resumeCursor) await this.writeMeta('cursor', JSON.stringify(this.cursor));
		else await this.db.query(`DELETE FROM _pod_meta WHERE key = 'cursor'`).catch(() => undefined);
		this.notifyCursorListeners();
		for (const table of tables) this.notifyCollection(table);
	}

	notifyCollection(collection: string): void {
		for (const listener of this.listeners) listener(collection);
	}

	// ── shape subscribe (one keyset page of a collection) ───────────────────────

	/**
	 * Fetch one page of a collection through `/sync/shape` and upsert it. The caller drives the
	 * paging loop (see SubscriptionRegistry) because only the client knows how many rows it has
	 * already accumulated against its cap.
	 */
	async shapeSubscribe(request: ShapeRequest): Promise<ShapeResponse> {
		this.subscribeCollection(request.collection);
		const response = await this.postJson<ShapeResponse>('shape', request);
		if (response.rows.length > 0) {
			await this.upsertRows(request.collection, response.rows);
		}
		// A catch-up watermark only seeds the stream cursor on a cold client. Once the cursor
		// exists, later catch-ups must leave it alone: moving it forward to a newer collection's
		// watermark would skip changes to collections that caught up earlier. Replaying a few
		// already-applied diffs is free (upsert by id is idempotent); skipping one is corruption.
		if (response.cursor && !this.cursorInitialized) {
			this.cursor = response.cursor;
			this.cursorInitialized = true;
			await this.writeMeta('cursor', JSON.stringify(this.cursor));
		}
		return response;
	}

	/** Current safe server feed head, used to validate persisted rows before serving them. */
	async serverSequence(): Promise<string> {
		const response = await this.postJson<{ sequence: unknown }>('head', {});
		if (typeof response.sequence !== 'string' || !/^\d+$/.test(response.sequence)) {
			throw new Error('sync/head returned an invalid sequence');
		}
		return response.sequence;
	}

	// ── stream: keep the replica live ───────────────────────────────────────────

	startStream(): void {
		if (this.streamLoop) return;
		this.streamAbort = new AbortController();
		this.streamLoop = this.runStream(this.streamAbort.signal);
	}

	async stopStream(): Promise<void> {
		if (this.rotateTimer) clearTimeout(this.rotateTimer);
		this.rotateTimer = null;
		this.streamAbort?.abort();
		this.connectionAbort?.abort();
		await this.streamLoop?.catch(() => undefined);
		this.streamLoop = null;
		this.streamAbort = null;
	}

	private async runStream(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			try {
				// The server decodes this as base64url. Sending raw JSON happens to make a valid
				// URL, but it fails cursor decoding and silently restarts every reconnect at zero.
				// On a busy tenant that turns each proxy timeout into a full-feed replay and leaves
				// newly committed rows queued behind the entire historical outbox.
				const params = new URLSearchParams({ cursor: encodeStreamCursor(this.cursor) });
				for (const collection of [...this.subscribedCollections].sort()) {
					params.append('collection', collection);
				}
				this.connectionAbort = new AbortController();
				const requestSignal = AbortSignal.any([signal, this.connectionAbort.signal]);
				let response: Response;
				try {
					response = await this.httpFetch(`sync/stream?${params.toString()}`, {
						method: 'GET',
						accept: 'text/event-stream',
						signal: requestSignal
					});
				} catch (err) {
					// The feed could not be opened at all. That is the honest offline signal — unlike
					// an apply failure further down, which says nothing about the network.
					if (!isAbortError(err)) this.markUnreachable();
					throw err;
				}
				if (!response.ok) {
					if (isTransportFailureStatus(response.status)) this.markUnreachable();
					throw new Error(`sync stream failed (${response.status})`);
				}
				if (!response.body) throw new Error('sync stream returned no body');
				// The feed is open, so the server is reachable — and a reconnection is exactly when the
				// outbox should move.
				this.markReachable();
				// Scheduled, never awaited. This loop used to `await flushPending()` here, which parked
				// it inside a `sync/mutate` POST — and `stopStream()` awaits this loop, while the
				// registry's serialized catch-up queue awaits `stopStream()`. One slow mutate therefore
				// stalled every collection's catch-up behind it, so reads waiting on those collections
				// never resolved and never retried. The drain has its own scheduler; it does not belong
				// on the critical path of the feed.
				this.scheduleDrain(0);
				await this.consumeSse(response.body, requestSignal);
			} catch (err) {
				if (signal.aborted) return;
				// The feed no longer reaches back to where this replica left off. Reconnecting would
				// resume from a truncated feed and leave the replica quietly missing whatever was
				// pruned, so rebuild instead: drop everything, tell the registry to forget what it
				// believed was resident, and let the next read catch up from scratch.
				if (err instanceof SyncResetRequired || err instanceof SyncScopeChanged) {
					await this.discardReplica(err instanceof SyncScopeChanged ? err.cursor : undefined).catch(
						() => undefined
					);
					for (const listener of this.resetListeners) listener();
					this.lastError = undefined;
				} else if (isAbortError(err)) {
					// A newly subscribed collection rotates the connection so the server can stop
					// resolving unrelated outbox rows. The outer loop reconnects with the new set.
				} else {
					this.lastError = err;
					console.error('[pod-sync] stream iteration failed', err);
				}
			}
			this.connectionAbort = null;
			// Always pause before reconnecting, including after a *clean* end of stream. A proxy
			// timeout or a server restart closes the stream without an error, and reconnecting
			// straight away turns that into an unbounded hot loop against the server.
			if (!signal.aborted) await this.delay(RECONNECT_DELAY_MS, signal);
		}
	}

	/**
	 * Register feed interest and rotate the open connection so the server starts resolving it.
	 *
	 * The rotation is coalesced. A background warm pass registers every collection in the workspace
	 * one after another, and rotating per registration would mean one reconnect — and one reconnect
	 * delay — per collection, so the feed would spend the warm-up disconnected. Nothing is lost by
	 * waiting: the connection resumes from the durable cursor, and catch-up captures its own
	 * watermark, so a change in the gap is replayed rather than skipped.
	 */
	subscribeCollection(collection: string): void {
		if (!collection || this.subscribedCollections.has(collection)) return;
		this.subscribedCollections.add(collection);
		this.rotateSubscriptionStream();
	}

	/** Replace feed interest after the registry is rebuilt or reset. */
	setSubscribedCollections(collections: Iterable<string>): void {
		const next = new Set([...collections].filter(Boolean));
		if (
			next.size === this.subscribedCollections.size &&
			[...next].every((collection) => this.subscribedCollections.has(collection))
		) {
			return;
		}
		this.subscribedCollections.clear();
		for (const collection of next) this.subscribedCollections.add(collection);
		this.rotateSubscriptionStream();
	}

	private rotateSubscriptionStream(): void {
		if (!this.connectionAbort || this.rotateTimer) return;
		this.rotateTimer = setTimeout(() => {
			this.rotateTimer = null;
			this.connectionAbort?.abort();
		}, SUBSCRIPTION_ROTATE_DELAY_MS);
	}

	private async consumeSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		const onAbort = () => reader.cancel().catch(() => undefined);
		signal.addEventListener('abort', onAbort, { once: true });
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done || signal.aborted) return;
				buffer += decoder.decode(value, { stream: true });
				let sep: number;
				const arrived: SyncDiff[] = [];
				let cursorAdvance: SyncCursor | undefined;
				while ((sep = buffer.indexOf('\n\n')) !== -1) {
					const frame = buffer.slice(0, sep);
					buffer = buffer.slice(sep + 2);
					const parsed = parseSseFrame(frame);
					if (parsed?.type === 'diff') arrived.push(parsed.diff);
					else if (parsed?.type === 'cursor') cursorAdvance = parsed.cursor;
				}
				// One write pass and one notification per collection per network chunk. A burst of
				// diffs (a bulk import, a cascade) would otherwise cost a replica round trip per row
				// and re-run every live query once per row.
				const touched = await this.applyDiffs(arrived);
				// A chunk can carry diffs and then a cursor frame for a later batch that held nothing
				// this client subscribes to. Applying the diffs alone would leave the cursor behind
				// that frame, so a command waiting on the newer sequence would not see it arrive until
				// some unrelated commit pushed the cursor past it.
				if (cursorAdvance && isAfter(cursorAdvance, this.cursor)) {
					await this.advanceCursor(cursorAdvance);
				}
				for (const collection of touched) this.notifyCollection(collection);
			}
		} finally {
			signal.removeEventListener('abort', onAbort);
			// An apply/parse failure exits before the response body ends. Cancel the reader so fetch
			// closes that HTTP connection; otherwise each retry leaks one live SSE request until the
			// browser's per-origin connection pool is exhausted.
			await reader.cancel().catch(() => undefined);
		}
	}

	private async advanceCursor(cursor: SyncCursor): Promise<void> {
		this.cursor = cursor;
		this.cursorInitialized = true;
		await this.writeMeta('cursor', JSON.stringify(cursor));
		this.notifyCursorListeners();
	}

	/**
	 * Wait until this replica has consumed every feed event through `sequence`.
	 *
	 * Commands such as approval run outside the ordinary mutation endpoint but still append their
	 * changes to the same outbox. Their response carries the committed watermark, making this the
	 * read-your-command barrier: once it resolves true, any subscribed collection reflects the
	 * command before its promise returns to the UI.
	 */
	waitForSequence(sequence: string, options?: { readonly timeoutMs?: number }): Promise<boolean> {
		let target: bigint;
		try {
			target = BigInt(sequence);
		} catch {
			return Promise.resolve(false);
		}
		if (BigInt(this.cursor.seq) >= target) return Promise.resolve(true);
		this.startStream();
		const timeoutMs = options?.timeoutMs ?? 5_000;
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				this.cursorListeners.delete(check);
				resolve(value);
			};
			const check = () => {
				if (BigInt(this.cursor.seq) >= target) finish(true);
			};
			const timeout = setTimeout(() => finish(false), Math.max(0, timeoutMs));
			this.cursorListeners.add(check);
			check();
		});
	}

	private notifyCursorListeners(): void {
		for (const listener of this.cursorListeners) listener();
	}

	/**
	 * Apply a run of diffs in feed order, in as few replica writes as the run allows.
	 *
	 * Applying one diff at a time costs two replica round trips per row — the row itself and the
	 * durable cursor — so a burst is throughput-bound on the client no matter how fast the feed
	 * delivered it: a single ~1,300-row write took the client past the point where anything
	 * committed after it could be seen, because it was still working through the burst. Adjacent
	 * diffs that hit the same collection the same way collapse into one statement; the cursor is
	 * written once at the end.
	 *
	 * Only *adjacent* like diffs merge, so feed order is preserved exactly — a row created and then
	 * deleted within one chunk ends deleted, not resurrected. Persisting the cursor once per run is
	 * safe for the same reason a catch-up may overlap the stream: a crash mid-run replays diffs that
	 * were already applied, and re-applying by primary key is idempotent. Skipping one would be
	 * corruption; repeating one costs nothing.
	 */
	async applyDiffs(diffs: readonly SyncDiff[]): Promise<Set<string>> {
		const touched = new Set<string>();
		if (diffs.length === 0) return touched;

		let index = 0;
		while (index < diffs.length) {
			const head = diffs[index]!;
			const removes = head.action === 'delete' || head.action === 'leave';
			const run: SyncDiff[] = [];
			while (index < diffs.length) {
				const next = diffs[index]!;
				const nextRemoves = next.action === 'delete' || next.action === 'leave';
				if (next.collection !== head.collection || nextRemoves !== removes) break;
				run.push(next);
				index += 1;
			}
			touched.add(head.collection);
			if (removes) {
				await this.deleteRows(
					head.collection,
					run.map((diff) => diff.id)
				);
			} else {
				const rows = run.map((diff) => diff.row).filter((row) => row != null);
				if (rows.length > 0) await this.upsertRows(head.collection, rows);
			}
		}

		// Advance both halves of the cursor. Carrying a stale `xid` forward would make every
		// reconnect replay the entire feed since the first catch-up.
		const last = diffs[diffs.length - 1]!;
		this.cursor = { xid: last.xid, seq: last.seq };
		this.cursorInitialized = true;
		await this.writeMeta('cursor', JSON.stringify(this.cursor));
		this.notifyCursorListeners();
		return touched;
	}

	async applyDiff(diff: SyncDiff, options?: { notify?: boolean }): Promise<void> {
		await this.applyDiffs([diff]);
		if (options?.notify !== false) this.notifyCollection(diff.collection);
	}

	// ── mutate: optimistic locally, authoritative on the server ─────────────────

	/**
	 * Apply writes to the local replica first so the UI updates in the same frame, then confirm
	 * against `/sync/mutate`. The server stays the authority: a confirmation overwrites the
	 * optimistic row with the committed one (hook output, defaults, version), and a rejection
	 * restores the snapshot taken before the optimistic apply.
	 *
	 * Creates use a client-minted UUIDv7. The server preserves it through hooks, which makes the
	 * optimistic identity final rather than a temporary key that relationships would have to rewrite.
	 */
	async mutate(mutations: readonly WireMutation[]): Promise<MutationResult[]> {
		const prepared = mutations.map((mutation) =>
			mutation.action === 'create' && typeof mutation.row?.[PKEY] !== 'string'
				? { ...mutation, row: { ...mutation.row, [PKEY]: uuidv7() } }
				: mutation
		);
		const undo = await this.applyOptimistic(prepared);
		const plan = await this.planAgainstOutbox(prepared);

		const results = new Map<string, MutationResult>();
		for (const result of plan.resolved) results.set(result.clientId, result);
		if (plan.sequenced.length > 0) {
			for (const result of await this.enqueueBatch(plan.sequenced, undo, { schedule: true })) {
				results.set(result.clientId, result);
			}
		}
		// Everything that stayed local still has to repaint; `submit` only announces what it sends.
		for (const collection of plan.touched) this.notifyCollection(collection);
		if (plan.direct.length > 0) {
			for (const result of await this.submit(plan.direct, undo))
				results.set(result.clientId, result);
		}
		// Answer in the caller's order. A batch of one — every write from the collection client —
		// therefore behaves exactly as it did before any of this existed.
		return prepared.flatMap((mutation) => {
			const result = results.get(mutation.clientId);
			return result ? [result] : [];
		});
	}

	/**
	 * Decide how each mutation reaches the server, given what is still sitting in the outbox.
	 *
	 * A mutation that names a record whose create has not been sent yet cannot go straight to the
	 * server: the server has never seen that id, so the write arrives as `404 Record with ID … not
	 * found`. It is a race — the outbox drains and the next attempt works — but a race the client is
	 * in a position to remove outright, because it knows the create is still in its own hands.
	 *
	 * Two of the three answers avoid the round trip entirely:
	 *
	 *   create-then-delete  The record only ever existed on this device. Dropping both outbox
	 *                       entries reaches the same end state as sending them, so it is not a
	 *                       shortcut — it is the same operation with nothing left to say.
	 *   create-then-update  Fold the edit into the create still waiting to be sent. One INSERT
	 *                       carrying the latest values, instead of an UPDATE racing the row it edits.
	 *
	 * Anything else that names a busy record is appended to the outbox, which is already ordered by
	 * `created_at` and drained in that order — so ordering is enforced by the queue rather than by a
	 * second mechanism that would have to agree with it.
	 */
	private async planAgainstOutbox(prepared: readonly WireMutation[]): Promise<OutboxPlan> {
		const plan: OutboxPlan = {
			direct: [],
			sequenced: [],
			resolved: [],
			touched: new Set<string>()
		};
		const wanted = new Set(
			prepared.flatMap((mutation) => {
				const id = mutation.row?.[PKEY];
				return typeof id === 'string' ? [recordKey(mutation.collection, id)] : [];
			})
		);
		if (wanted.size === 0) {
			plan.direct.push(...prepared);
			return plan;
		}

		const byRecord = await this.pendingByRecord(wanted);
		if (byRecord.size === 0) {
			plan.direct.push(...prepared);
			return plan;
		}

		for (const mutation of prepared) {
			const id = mutation.row?.[PKEY];
			const key = typeof id === 'string' ? recordKey(mutation.collection, id) : null;
			const entries = key ? byRecord.get(key) : undefined;
			if (!key || typeof id !== 'string' || !entries || entries.length === 0) {
				plan.direct.push(mutation);
				continue;
			}
			const create = entries.find((entry) => entry.action === 'create');

			if (create && mutation.action === 'delete') {
				for (const entry of entries) {
					await this.db.query(`DELETE FROM _pod_pending WHERE client_id = $1`, [entry.clientId]);
				}
				byRecord.delete(key);
				plan.resolved.push({ clientId: mutation.clientId, status: 'confirmed', serverId: id });
				plan.touched.add(mutation.collection);
				continue;
			}

			// Only when the create is the *whole* of what is queued for this record. With an older
			// queued update also waiting, merging would move this edit ahead of it.
			if (create && entries.length === 1 && mutation.action === 'update') {
				const merged = { ...(create.row ?? {}), ...(mutation.row ?? {}), [PKEY]: id };
				await this.db.query(`UPDATE _pod_pending SET row = $1 WHERE client_id = $2`, [
					JSON.stringify(merged),
					create.clientId
				]);
				byRecord.set(key, [{ ...create, row: merged }]);
				plan.resolved.push({
					clientId: mutation.clientId,
					status: 'rejected',
					reason: 'OFFLINE_QUEUED'
				});
				plan.touched.add(mutation.collection);
				continue;
			}

			plan.sequenced.push(mutation);
			plan.touched.add(mutation.collection);
		}
		return plan;
	}

	/** Unsent outbox entries for the given records, oldest first — the order they will be sent in. */
	private async pendingByRecord(wanted: ReadonlySet<string>): Promise<Map<string, PendingEntry[]>> {
		const byRecord = new Map<string, PendingEntry[]>();
		// The outbox only ever holds writes that have not settled, so this is a handful of rows in
		// the worst case; filtering here keeps the record identity in one place rather than
		// reproducing `row ->> id` matching in SQL as well.
		const result = await this.db
			.query<{
				client_id: string;
				collection: string;
				action: string;
				row: Record<string, unknown> | null;
			}>(`SELECT client_id, collection, action, row FROM _pod_pending ORDER BY created_at ASC`)
			.catch(() => ({ rows: [] as never[] }));
		for (const entry of result.rows) {
			const id = entry.row?.[PKEY];
			if (typeof id !== 'string') continue;
			const key = recordKey(entry.collection, id);
			if (!wanted.has(key)) continue;
			const bucket = byRecord.get(key) ?? [];
			bucket.push({
				clientId: entry.client_id,
				action: entry.action as WireMutation['action'],
				row: entry.row
			});
			byRecord.set(key, bucket);
		}
		return byRecord;
	}

	/**
	 * Ids in `collection` whose write has not settled with the server yet.
	 *
	 * This is the outbox itself, not an inference from it: a record is listed exactly while an entry
	 * naming it is still waiting to be sent, and stops being listed the moment that entry settles —
	 * confirmed or rejected, since the entry is deleted either way.
	 */
	async pendingRecordIds(collection: string): Promise<Set<string>> {
		const result = await this.db
			.query<{
				record_id: string | null;
			}>(`SELECT row ->> '${PKEY}' AS record_id FROM _pod_pending WHERE collection = $1`, [
				collection
			])
			.catch(() => ({ rows: [] as never[] }));
		return new Set(
			result.rows
				.map((entry) => entry.record_id)
				.filter((id): id is string => typeof id === 'string')
		);
	}

	/**
	 * Send a prepared batch and settle each result against the replica.
	 *
	 * `undo` is the pre-mutation state captured when the batch was first applied, not re-derived
	 * here. A retry runs against a replica that already shows the mutation, so deriving the undo at
	 * send time would derive the mutated state — and a rejected queued delete would have no row to
	 * restore and would stay deleted locally for good.
	 */
	private async submit(
		prepared: readonly WireMutation[],
		undo: ReadonlyMap<string, PendingUndo>,
		options?: { readonly drain?: boolean }
	): Promise<MutationResult[]> {
		const touched = new Set(prepared.map((mutation) => mutation.collection));
		for (const collection of touched) this.notifyCollection(collection);

		// The write is queued, not lost — keep the optimistic state so the UI stays consistent with
		// what will eventually be sent. A drain schedules its own retry with backoff, so it must not
		// also ask for the immediate one a fresh write gets.
		const queue = (): Promise<MutationResult[]> =>
			this.enqueueBatch(prepared, undo, { schedule: !options?.drain });

		// A drain IS the probe: attempting the request is how an unreachable server is discovered to
		// be reachable again, so it never consults the verdict it exists to refresh.
		if (!options?.drain && !this.isOnline()) return queue();

		let response: MutateResponse;
		try {
			response = await this.postJson<MutateResponse>('mutate', { mutations: prepared });
		} catch {
			return queue();
		}

		for (const result of response.results) {
			const mutation = prepared.find((m) => m.clientId === result.clientId);
			if (!mutation) continue;
			if (result.status === 'confirmed') {
				if (mutation.action === 'delete') {
					const fallbackId = mutation.row?.[PKEY];
					const id = result.serverId ?? (typeof fallbackId === 'string' ? fallbackId : null);
					if (id) await this.deleteRow(mutation.collection, id);
				} else if (result.row) {
					await this.upsertRow(mutation.collection, result.row);
				}
			} else {
				await this.rollback(mutation, undo.get(result.clientId) ?? null);
			}
		}
		for (const collection of touched) this.notifyCollection(collection);
		return response.results;
	}

	/** Restore the state a rejected mutation replaced. A create simply loses its optimistic row. */
	private async rollback(mutation: WireMutation, undo: PendingUndo | null): Promise<void> {
		const id = mutation.row?.[PKEY];
		if (typeof id !== 'string') return;
		if (undo) await this.upsertRow(mutation.collection, undo).catch(() => undefined);
		else await this.deleteRow(mutation.collection, id).catch(() => undefined);
	}

	/** Apply each mutation locally and return the row it replaced, per clientId. */
	private async applyOptimistic(
		mutations: readonly WireMutation[]
	): Promise<Map<string, PendingUndo>> {
		const undo = new Map<string, PendingUndo>();
		for (const mutation of mutations) {
			const id = mutation.row?.[PKEY];
			if (typeof id !== 'string') continue;
			if (mutation.action === 'create') {
				await this.upsertRow(mutation.collection, mutation.row ?? {}).catch(() => undefined);
				continue;
			}
			const snapshot = await this.localRow(mutation.collection, id).catch(() => null);
			if (!snapshot) continue;
			undo.set(mutation.clientId, snapshot);
			if (mutation.action === 'delete') {
				await this.deleteRow(mutation.collection, id).catch(() => undefined);
			} else {
				await this.upsertRow(mutation.collection, { ...snapshot, ...mutation.row }).catch(
					() => undefined
				);
			}
		}
		return undo;
	}

	/**
	 * Send everything still in the outbox, oldest first, and delete whatever settled.
	 *
	 * Deliberately not gated on `isOnline()`. Attempting the request is the only way an unreachable
	 * server is ever observed to be reachable again, and the backoff below — not a stale verdict —
	 * is what keeps a genuinely offline device from polling at write speed.
	 */
	async flushPending(): Promise<MutationResult[]> {
		// One drain at a time. The stream reconnect, the retry timer and a recovering connection can
		// all ask at once, and sending the same batch twice would race two answers into the replica.
		if (this.draining) return [];
		this.draining = true;
		try {
			const pending = await this.db.query<{
				client_id: string;
				collection: string;
				action: string;
				row: Record<string, unknown> | null;
				snapshot: Record<string, unknown> | null;
				base_version: number | null;
			}>(
				`SELECT client_id, collection, action, row, snapshot, base_version
				   FROM _pod_pending ORDER BY created_at ASC`
			);
			if (pending.rows.length === 0) {
				this.drainDelayMs = OUTBOX_RETRY_MIN_MS;
				return [];
			}
			const mutations: WireMutation[] = pending.rows.map((entry) => ({
				clientId: entry.client_id,
				collection: entry.collection,
				action: entry.action as WireMutation['action'],
				row: entry.row ?? undefined,
				version: entry.base_version ?? undefined
			}));
			// Already applied optimistically when it was queued; re-applying would overwrite the newer
			// local state with the same proposal and, worse, capture it as the undo.
			const undo = new Map<string, PendingUndo>();
			for (const entry of pending.rows) {
				if (entry.snapshot) undo.set(entry.client_id, entry.snapshot);
			}
			const results = await this.submit(mutations, undo, { drain: true });
			const settled = results
				.filter((r) => !(r.status === 'rejected' && r.reason === 'OFFLINE_QUEUED'))
				.map((r) => r.clientId);
			for (const clientId of settled) {
				await this.db.query(`DELETE FROM _pod_pending WHERE client_id = $1`, [clientId]);
			}
			if (settled.length === results.length) {
				this.drainDelayMs = OUTBOX_RETRY_MIN_MS;
			} else {
				this.drainDelayMs = Math.min(this.drainDelayMs * 2, OUTBOX_RETRY_MAX_MS);
				this.scheduleDrain(this.drainDelayMs);
			}
			return results;
		} finally {
			this.draining = false;
		}
	}

	/** Append a batch to the outbox and report it as queued. */
	private async enqueueBatch(
		mutations: readonly WireMutation[],
		undo: ReadonlyMap<string, PendingUndo>,
		options: { readonly schedule: boolean }
	): Promise<MutationResult[]> {
		for (const mutation of mutations) {
			await this.enqueuePending(mutation, undo.get(mutation.clientId) ?? null);
		}
		if (options.schedule) this.scheduleDrain(OUTBOX_RETRY_MIN_MS);
		return mutations.map((mutation) => ({
			clientId: mutation.clientId,
			status: 'rejected' as const,
			reason: 'OFFLINE_QUEUED'
		}));
	}

	/**
	 * Ask the outbox to drain in `delayMs`, unless something sooner is already scheduled.
	 *
	 * Earliest wins, so a fresh write always pulls a long backoff forward: a user who queues a
	 * second write after five failed minutes should not inherit the wait the failures earned.
	 */
	private scheduleDrain(delayMs: number): void {
		if (this.closed) return;
		const dueAt = this.now() + delayMs;
		if (this.drainTimer && dueAt >= this.drainDueAt) return;
		if (this.drainTimer) clearTimeout(this.drainTimer);
		this.drainDueAt = dueAt;
		this.drainTimer = setTimeout(
			() => {
				this.drainTimer = null;
				this.drainDueAt = Number.POSITIVE_INFINITY;
				void this.flushPending().catch((err) => {
					this.lastError = err;
				});
			},
			Math.max(0, delayMs)
		);
	}

	private async enqueuePending(mutation: WireMutation, undo: PendingUndo | null): Promise<void> {
		await this.db.query(
			`INSERT INTO _pod_pending (client_id, collection, action, row, snapshot, base_version, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)
			 ON CONFLICT (client_id) DO UPDATE SET row = EXCLUDED.row, base_version = EXCLUDED.base_version`,
			[
				mutation.clientId,
				mutation.collection,
				mutation.action,
				mutation.row ? JSON.stringify(mutation.row) : null,
				undo ? JSON.stringify(undo) : null,
				mutation.version ?? null,
				this.nextOutboxTimestamp()
			]
		);
	}

	/** Strictly increasing, so `ORDER BY created_at` is the queue order even inside one millisecond. */
	private nextOutboxTimestamp(): number {
		this.outboxClock = Math.max(this.now(), this.outboxClock + 1);
		return this.outboxClock;
	}

	// ── local reads ─────────────────────────────────────────────────────────────

	async queryLocal<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
		const result = await this.db.query<T>(sql, params);
		return result.rows;
	}

	async count(collection: string): Promise<number> {
		const result = await this.db.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM ${quoteIdent(collection)}`
		);
		return Number(result.rows[0]?.n ?? 0);
	}

	async localRow(collection: string, id: string): Promise<Record<string, unknown> | null> {
		const result = await this.db.query<Record<string, unknown>>(
			`SELECT * FROM ${quoteIdent(collection)} WHERE ${quoteIdent(PKEY)} = $1`,
			[id]
		);
		return result.rows[0] ?? null;
	}

	// ── generic row storage ─────────────────────────────────────────────────────

	async upsertRows(collection: string, rows: readonly Record<string, unknown>[]): Promise<void> {
		// One outbox chunk may contain several versions of the same row. PostgreSQL deliberately
		// rejects an INSERT ... ON CONFLICT statement that would update one target row twice, so
		// collapse the chunk first. Feed order is authoritative: the last version wins.
		const latestById = new Map<string, Record<string, unknown>>();
		for (const row of rows) {
			const id = row[PKEY];
			if (typeof id === 'string') latestById.set(id, row);
		}

		const byShape = new Map<string, Record<string, unknown>[]>();
		for (const row of latestById.values()) {
			const columns = Object.keys(row);
			if (columns.length === 0) continue;
			const shape = columns.join(' ');
			const bucket = byShape.get(shape);
			if (bucket) bucket.push(row);
			else byShape.set(shape, [row]);
		}

		for (const bucket of byShape.values()) {
			const columns = Object.keys(bucket[0]!);
			const table = quoteIdent(collection);
			const updates = columns
				.filter((column) => column !== PKEY)
				.map((column) => `${quoteIdent(column)} = EXCLUDED.${quoteIdent(column)}`);
			// A fallback query that started before a mutation can finish after the mutation result was
			// already folded into the replica. Both rows are authoritative server answers, but only
			// the row version tells us which one is current. Never let that late, older answer roll a
			// confirmed mutation back locally. Equal versions still update because optimistic writes
			// deliberately keep the current version until the server confirms the next one.
			const versionGuard = columns.includes(VERSION)
				? ` WHERE EXCLUDED.${quoteIdent(VERSION)} IS NULL
					OR ${table}.${quoteIdent(VERSION)} IS NULL
					OR EXCLUDED.${quoteIdent(VERSION)} >= ${table}.${quoteIdent(VERSION)}`
				: '';
			const conflict =
				updates.length > 0 ? `DO UPDATE SET ${updates.join(', ')}${versionGuard}` : 'DO NOTHING';

			// A bind message counts its parameters in a SIGNED int16, so 32767 is the ceiling — not
			// 65535. Past it PGlite throws `Invalid array length`, `runCatchUp` swallows it as a
			// failed catch-up, and the collection silently never becomes resident: the replica looks
			// like it is still downloading forever. Measured on PGlite 0.3.16 — 32760 parameters
			// succeed, 33300 do not.
			const perChunk = Math.max(1, Math.floor(MAX_BIND_PARAMETERS / columns.length));
			for (let start = 0; start < bucket.length; start += perChunk) {
				const chunk = bucket.slice(start, start + perChunk);
				const values: unknown[] = [];
				const tuples = chunk.map((row) => {
					const placeholders = columns.map((column) => {
						values.push(encodeValue(row[column]));
						return `$${values.length}`;
					});
					return `(${placeholders.join(', ')})`;
				});
				await this.db.query(
					`INSERT INTO ${table} (${columns.map(quoteIdent).join(', ')})
					 VALUES ${tuples.join(', ')}
					 ON CONFLICT (${quoteIdent(PKEY)}) ${conflict}`,
					values
				);
			}
		}
	}

	upsertRow(collection: string, row: Record<string, unknown>): Promise<void> {
		return this.upsertRows(collection, [row]);
	}

	async deleteRow(collection: string, id: string): Promise<void> {
		await this.deleteRows(collection, [id]);
	}

	async deleteRows(collection: string, ids: readonly string[]): Promise<void> {
		// Same signed-int16 bind ceiling as the upsert path. A bulk delete arrives as one run of
		// `delete`/`leave` diffs, so this list is as long as whatever the feed just carried.
		for (let start = 0; start < ids.length; start += MAX_BIND_PARAMETERS) {
			const chunk = ids.slice(start, start + MAX_BIND_PARAMETERS);
			const placeholders = chunk.map((_id, index) => `$${index + 1}`).join(', ');
			await this.db.query(
				`DELETE FROM ${quoteIdent(collection)} WHERE ${quoteIdent(PKEY)} IN (${placeholders})`,
				[...chunk]
			);
		}
	}

	async localVersion(collection: string, id: string): Promise<number | null> {
		const result = await this.db.query<{ v: number | null }>(
			`SELECT ${quoteIdent(VERSION)} AS v FROM ${quoteIdent(collection)} WHERE ${quoteIdent(PKEY)} = $1`,
			[id]
		);
		return result.rows[0]?.v ?? null;
	}

	// ── connectivity ─────────────────────────────────────────────────────────────

	private online = true;

	/**
	 * Whether the server is reachable, as this client last observed it.
	 *
	 * This used to be `navigator.onLine && this.online`, where `this.online` was never assigned by
	 * anything — so the whole verdict was `navigator.onLine`. That property answers a different
	 * question: whether the machine has a network interface it believes is up. A Wi-Fi handover, a
	 * VPN reconnect or a NIC waking from sleep flips it false for a moment, and every mutation that
	 * landed in that window was filed as "offline" while the server was reachable throughout.
	 *
	 * The verdict is therefore *observed*: the SSE stream reports whether it could be opened, and
	 * every `sync/*` POST reports whether it got an answer. A status the server (or its edge)
	 * produced counts as reachable however unwelcome it is. The device's own connectivity events
	 * only ever pull the verdict one way: a browser reporting its radio is down marks the server
	 * unreachable without spending a request on proving it, and nothing but an answered request is
	 * ever allowed to put it back.
	 */
	isOnline(): boolean {
		return this.online;
	}

	/** A request reached the server, whatever the server then said. */
	private markReachable(): void {
		if (this.online) return;
		this.online = true;
		// Recovery is the moment the outbox has to move — not the next SSE reconnect, which on a
		// healthy feed is minutes away.
		this.drainDelayMs = OUTBOX_RETRY_MIN_MS;
		this.scheduleDrain(0);
	}

	/** A request did not reach the server. */
	private markUnreachable(): void {
		this.online = false;
	}

	/**
	 * The browser's own connectivity events, wired only where a window exists.
	 *
	 * `offline` is trusted negatively: when the device says its radio is down, nothing will reach
	 * the server, so writes queue at once instead of each paying a failed request first. `online`
	 * is NOT trusted positively — an interface coming back up says nothing about our server — but
	 * it is exactly the moment the outbox should find out, so it pulls the drain forward and lets
	 * the attempt itself decide the verdict.
	 */
	private readonly browserOfflineListener = (): void => this.markUnreachable();
	private readonly browserOnlineListener = (): void => {
		this.drainDelayMs = OUTBOX_RETRY_MIN_MS;
		this.scheduleDrain(0);
	};

	private watchBrowserConnectivity(): void {
		if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
		window.addEventListener('offline', this.browserOfflineListener);
		window.addEventListener('online', this.browserOnlineListener);
	}

	private unwatchBrowserConnectivity(): void {
		if (typeof window === 'undefined' || typeof window.removeEventListener !== 'function') return;
		window.removeEventListener('offline', this.browserOfflineListener);
		window.removeEventListener('online', this.browserOnlineListener);
	}

	/**
	 * Override the connectivity verdict.
	 *
	 * Ordinary operation never calls this — reachability is observed from real requests and device
	 * events. It exists for tests and for a host that genuinely knows better (a service worker
	 * running its own probe).
	 */
	setOnline(online: boolean): void {
		if (online) this.markReachable();
		else this.markUnreachable();
	}

	async close(): Promise<void> {
		this.closed = true;
		this.unwatchBrowserConnectivity();
		if (this.drainTimer) clearTimeout(this.drainTimer);
		this.drainTimer = null;
		this.drainDueAt = Number.POSITIVE_INFINITY;
		await this.stopStream();
		await this.db.close?.();
	}

	// ── helpers ──────────────────────────────────────────────────────────────────

	private async postJson<T>(action: string, body: unknown): Promise<T> {
		let response: Response;
		try {
			response = await this.httpFetch(`sync/${action}`, {
				method: 'POST',
				body: JSON.stringify(body),
				accept: 'application/json',
				// A deadline, not a policy: without one, a connection that is accepted and then never
				// answered leaves this promise pending for the life of the tab.
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});
		} catch (err) {
			// `fetch` only rejects when the request never got an answer at all: DNS, a refused
			// connection, a dropped TLS session, a dead radio. That is what offline actually is —
			// and so is a request that ran out its deadline, which aborts as `TimeoutError` rather
			// than the `AbortError` a deliberate cancellation raises.
			if (!isAbortError(err)) this.markUnreachable();
			throw err;
		}
		if (isTransportFailureStatus(response.status)) this.markUnreachable();
		else this.markReachable();
		if (!response.ok) throw new Error(`sync/${action} failed (${response.status})`);
		return (await response.json()) as T;
	}

	private async readMeta(key: string): Promise<string | null> {
		const result = await this.db.query<{ value: string }>(
			`SELECT value FROM _pod_meta WHERE key = $1`,
			[key]
		);
		return result.rows[0]?.value ?? null;
	}

	private async writeMeta(key: string, value: string): Promise<void> {
		await this.db.query(
			`INSERT INTO _pod_meta (key, value) VALUES ($1, $2)
			 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
			[key, value]
		);
	}

	private delay(ms: number, signal: AbortSignal): Promise<void> {
		return abortableDelay(ms, signal);
	}
}

function encodeValue(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'object') return JSON.stringify(value);
	return value;
}

function quoteIdent(identifier: string): string {
	if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
		throw new Error(`Unsafe SQL identifier: ${identifier}`);
	}
	return `"${identifier}"`;
}

/**
 * Recover the target `table -> columns` map from the server's additive DDL. Each column is its
 * own statement, so this is a line scan rather than a SQL parse. Returns an empty map for DDL
 * that isn't in that form (hand-written schemas in tests), which callers read as "unknown".
 */
function parseTargetSchema(schemaSql: string): Map<string, Set<string>> {
	const tables = new Map<string, Set<string>>();
	const create = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"([^"]+)"\s*\(\s*"([^"]+)"/gi;
	const alter = /ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"([^"]+)"/gi;
	for (const pattern of [create, alter]) {
		for (const match of schemaSql.matchAll(pattern)) {
			const [, table, column] = match;
			if (!table || !column) continue;
			const columns = tables.get(table) ?? new Set<string>();
			columns.add(column);
			tables.set(table, columns);
		}
	}
	return tables;
}

function schemaFingerprint(schemaSql: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < schemaSql.length; index += 1) {
		hash ^= schemaSql.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}
