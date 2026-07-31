import { abortableDelay } from '$lib/shared/abortable-delay.js';
import { z } from 'zod';
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
/** Postgres binds at most this many parameters per statement: the count is a signed int16. */
const MAX_BIND_PARAMETERS = 32_767;

const META_TABLE = `CREATE TABLE IF NOT EXISTS _pod_meta (key TEXT PRIMARY KEY, value TEXT)`;
const PENDING_TABLE = `CREATE TABLE IF NOT EXISTS _pod_pending (
	client_id TEXT PRIMARY KEY,
	collection TEXT NOT NULL,
	action TEXT NOT NULL,
	row JSONB,
	base_version INTEGER,
	created_at BIGINT NOT NULL
)`;
/**
 * Which collections this replica holds, surviving reload. Without this every reload is a cold
 * start: the replica still has the rows but nothing remembers that, so every collection is
 * re-downloaded before the first paint. See README §3.4.
 */
const SYNC_STATE_TABLE = `CREATE TABLE IF NOT EXISTS _pod_sync_state (
	collection TEXT PRIMARY KEY,
	resident BOOLEAN NOT NULL,
	row_count INTEGER NOT NULL,
	synced_at BIGINT NOT NULL
)`;
/**
 * Added after the residency budget moved from a row count to a byte budget. Replicas written by
 * an earlier build already have the table, so this is a separate additive statement rather than a
 * change to the CREATE above — which would be a no-op against an existing table and leave the
 * column missing.
 */
const SYNC_STATE_BYTES_COLUMN = `ALTER TABLE _pod_sync_state ADD COLUMN IF NOT EXISTS byte_count BIGINT`;

/** Internal bookkeeping tables — never part of the tenant schema, never dropped by reconciliation. */
const INTERNAL_TABLES = new Set(['_pod_meta', '_pod_pending', '_pod_sync_state']);

type ChangeListener = (collection: string) => void;

export type PodSyncClientOptions = {
	readonly db: PgliteLike;
	readonly schemaSql: string;
	/** Physical tenant-database identity. A new value invalidates all cached rows and mutations. */
	readonly replicaEpoch?: string;
	readonly fetch: SyncFetch;
	readonly now?: () => number;
};

const syncCursorSchema = z.object({ xid: z.string(), seq: z.string() });
const syncDiffSchema = z.object({
	seq: z.string(),
	xid: z.string().optional(),
	collection: z.string(),
	action: z.enum(['insert', 'update', 'delete', 'leave']),
	id: z.string(),
	version: z.number().nullable(),
	row: z.record(z.string(), z.unknown()).optional()
});

/** One SSE frame → its diff, or null when the frame is a comment/heartbeat or malformed. */
function parseSseFrame(frame: string): SyncDiff | null {
	// The server has pruned past this client's resume point. Nothing in the frame is a diff; the
	// only correct response is to throw away the replica and rebuild, which the stream loop does
	// by rethrowing this as a distinguishable error.
	if (frame.split('\n').some((line) => line.trim() === 'event: reset')) {
		throw new SyncResetRequired();
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
		return validated.success ? validated.data : null;
	} catch {
		return null;
	}
}

function encodeStreamCursor(cursor: SyncCursor): string {
	return encodeBase64Url(JSON.stringify(cursor));
}

/** The server can no longer resume this replica; it has to be discarded and rebuilt. */
export class SyncResetRequired extends Error {
	constructor() {
		super('sync cursor is older than the server retention window');
		this.name = 'SyncResetRequired';
	}
}

export class PodSyncClient {
	readonly db: PgliteLike;
	private readonly schemaSql: string;
	private readonly replicaEpoch: string | null;
	private readonly httpFetch: SyncFetch;
	private readonly now: () => number;
	private readonly listeners = new Set<ChangeListener>();
	private readonly resetListeners = new Set<() => void>();
	/** The server-reset check only needs to happen once per session, on the first shape response. */
	private resetChecked = false;
	private cursor: SyncCursor = { xid: '0', seq: '0' };
	private cursorInitialized = false;
	private streamAbort: AbortController | null = null;
	private streamLoop: Promise<void> | null = null;
	private booted = false;
	lastError: unknown = undefined;

	constructor(options: PodSyncClientOptions) {
		this.db = options.db;
		this.schemaSql = options.schemaSql;
		this.replicaEpoch = options.replicaEpoch?.trim() || null;
		this.httpFetch = options.fetch;
		this.now = options.now ?? (() => Date.now());
	}

	async bootstrap(): Promise<void> {
		if (this.booted) return;
		await this.db.exec(
			`${META_TABLE};\n${PENDING_TABLE};\n${SYNC_STATE_TABLE};\n${SYNC_STATE_BYTES_COLUMN};`
		);
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
	 * A reset creates a new physical tenant database while stable organization/user ids continue to
	 * address the same browser replica. Clear that replica before its first read. Comparing feed
	 * sequence numbers cannot prove continuity: a large reseed can already have a higher watermark
	 * than the old database by the time the browser reconnects.
	 */
	private async reconcileReplicaEpoch(): Promise<void> {
		if (!this.replicaEpoch) return;
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
			if (INTERNAL_TABLES.has(row.table_name)) continue;
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

	/**
	 * Backstop for servers that predate the explicit database epoch. The feed's `seq` is monotonic
	 * within the life of a database, so a server watermark *behind* our persisted cursor can only
	 * mean the outbox was truncated and rebuilt.
	 *
	 * This matters because a reset leaves no diffs to follow: rows vanish by TRUNCATE, not by
	 * `delete`, so nothing tells the replica to evict them. Without this check the client keeps
	 * serving records that no longer exist, indefinitely, and looks "cached but wrong".
	 */
	private async detectServerReset(watermark: string | undefined): Promise<void> {
		if (this.resetChecked) return;
		this.resetChecked = true;
		if (!watermark) return;
		let serverSeq: bigint;
		let localSeq: bigint;
		try {
			serverSeq = BigInt(watermark);
			localSeq = BigInt(this.cursor.seq || '0');
		} catch {
			return;
		}
		if (localSeq <= serverSeq) return;
		await this.discardReplica();
		for (const listener of this.resetListeners) listener();
	}

	/** Drop every synced row and all sync bookkeeping, keeping the schema. */
	private async discardReplica(): Promise<void> {
		const tables = [...(await this.introspectLocalSchema()).keys()];
		for (const table of tables) {
			await this.db.query(`DELETE FROM ${quoteIdent(table)}`).catch(() => undefined);
		}
		await this.db.query(`DELETE FROM _pod_sync_state`).catch(() => undefined);
		await this.db.query(`DELETE FROM _pod_pending`).catch(() => undefined);
		this.cursor = { xid: '0', seq: '0' };
		this.cursorInitialized = false;
		await this.writeMeta('cursor', JSON.stringify(this.cursor));
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
		const response = await this.postJson<ShapeResponse>('shape', request);
		await this.detectServerReset(response.watermark);
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

	// ── stream: keep the replica live ───────────────────────────────────────────

	startStream(): void {
		if (this.streamLoop) return;
		this.streamAbort = new AbortController();
		this.streamLoop = this.runStream(this.streamAbort.signal);
	}

	async stopStream(): Promise<void> {
		this.streamAbort?.abort();
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
				const cursorParam = encodeStreamCursor(this.cursor);
				const response = await this.httpFetch(`sync/stream?cursor=${cursorParam}`, {
					method: 'GET',
					accept: 'text/event-stream',
					signal
				});
				if (!response.body) throw new Error('sync stream returned no body');
				await this.flushPending().catch((err) => {
					this.lastError = err;
				});
				await this.consumeSse(response.body, signal);
			} catch (err) {
				if (signal.aborted) return;
				// The feed no longer reaches back to where this replica left off. Reconnecting would
				// resume from a truncated feed and leave the replica quietly missing whatever was
				// pruned, so rebuild instead: drop everything, tell the registry to forget what it
				// believed was resident, and let the next read catch up from scratch.
				if (err instanceof SyncResetRequired) {
					await this.discardReplica().catch(() => undefined);
					for (const listener of this.resetListeners) listener();
					this.lastError = undefined;
				} else {
					this.lastError = err;
					console.error('[pod-sync] stream iteration failed', err);
				}
			}
			// Always pause before reconnecting, including after a *clean* end of stream. A proxy
			// timeout or a server restart closes the stream without an error, and reconnecting
			// straight away turns that into an unbounded hot loop against the server.
			if (!signal.aborted) await this.delay(RECONNECT_DELAY_MS, signal);
		}
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
				while ((sep = buffer.indexOf('\n\n')) !== -1) {
					const frame = buffer.slice(0, sep);
					buffer = buffer.slice(sep + 2);
					const diff = parseSseFrame(frame);
					if (diff) arrived.push(diff);
				}
				// One write pass and one notification per collection per network chunk. A burst of
				// diffs (a bulk import, a cascade) would otherwise cost a replica round trip per row
				// and re-run every live query once per row.
				const touched = await this.applyDiffs(arrived);
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
		this.cursor = { xid: last.xid ?? this.cursor.xid, seq: last.seq };
		this.cursorInitialized = true;
		await this.writeMeta('cursor', JSON.stringify(this.cursor));
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
	 * `create` is deliberately not optimistic — `norbital_id` is minted server-side, so a local
	 * insert would need a temporary id and a rewrite when the real one arrives.
	 */
	async mutate(mutations: readonly WireMutation[]): Promise<MutationResult[]> {
		const rollbacks = await this.applyOptimistic(mutations);
		const touched = new Set(mutations.map((mutation) => mutation.collection));
		for (const collection of touched) this.notifyCollection(collection);

		if (!this.isOnline()) {
			for (const mutation of mutations) await this.enqueuePending(mutation);
			return mutations.map((mutation) => ({
				clientId: mutation.clientId,
				status: 'rejected' as const,
				reason: 'OFFLINE_QUEUED'
			}));
		}

		let response: MutateResponse;
		try {
			response = await this.postJson<MutateResponse>('mutate', { mutations });
		} catch {
			// The write is queued, not lost — keep the optimistic state so the UI stays consistent
			// with what will eventually be sent.
			for (const mutation of mutations) await this.enqueuePending(mutation);
			return mutations.map((mutation) => ({
				clientId: mutation.clientId,
				status: 'rejected' as const,
				reason: 'OFFLINE_QUEUED'
			}));
		}

		for (const result of response.results) {
			const mutation = mutations.find((m) => m.clientId === result.clientId);
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
				await rollbacks.get(result.clientId)?.();
			}
		}
		for (const collection of touched) this.notifyCollection(collection);
		return response.results;
	}

	/** Apply each mutation locally and return an undo per clientId. */
	private async applyOptimistic(
		mutations: readonly WireMutation[]
	): Promise<Map<string, () => Promise<void>>> {
		const rollbacks = new Map<string, () => Promise<void>>();
		for (const mutation of mutations) {
			if (mutation.action === 'create') continue;
			const id = mutation.row?.[PKEY];
			if (typeof id !== 'string') continue;
			const snapshot = await this.localRow(mutation.collection, id).catch(() => null);
			if (!snapshot) continue;
			rollbacks.set(mutation.clientId, async () => {
				await this.upsertRow(mutation.collection, snapshot);
			});
			if (mutation.action === 'delete') {
				await this.deleteRow(mutation.collection, id).catch(() => undefined);
			} else {
				await this.upsertRow(mutation.collection, { ...snapshot, ...mutation.row }).catch(
					() => undefined
				);
			}
		}
		return rollbacks;
	}

	async flushPending(): Promise<MutationResult[]> {
		if (!this.isOnline()) return [];
		const pending = await this.db.query<{
			client_id: string;
			collection: string;
			action: string;
			row: Record<string, unknown> | null;
			base_version: number | null;
		}>(
			`SELECT client_id, collection, action, row, base_version FROM _pod_pending ORDER BY created_at ASC`
		);
		if (pending.rows.length === 0) return [];
		const mutations: WireMutation[] = pending.rows.map((entry) => ({
			clientId: entry.client_id,
			collection: entry.collection,
			action: entry.action as WireMutation['action'],
			row: entry.row ?? undefined,
			version: entry.base_version ?? undefined
		}));
		const results = await this.mutate(mutations);
		const settled = results
			.filter((r) => !(r.status === 'rejected' && r.reason === 'OFFLINE_QUEUED'))
			.map((r) => r.clientId);
		for (const clientId of settled) {
			await this.db.query(`DELETE FROM _pod_pending WHERE client_id = $1`, [clientId]);
		}
		return results;
	}

	private async enqueuePending(mutation: WireMutation): Promise<void> {
		await this.db.query(
			`INSERT INTO _pod_pending (client_id, collection, action, row, base_version, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 ON CONFLICT (client_id) DO UPDATE SET row = EXCLUDED.row, base_version = EXCLUDED.base_version`,
			[
				mutation.clientId,
				mutation.collection,
				mutation.action,
				mutation.row ? JSON.stringify(mutation.row) : null,
				mutation.version ?? null,
				this.now()
			]
		);
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
		if (ids.length === 0) return;
		const placeholders = ids.map((_id, index) => `$${index + 1}`).join(', ');
		await this.db.query(
			`DELETE FROM ${quoteIdent(collection)} WHERE ${quoteIdent(PKEY)} IN (${placeholders})`,
			[...ids]
		);
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

	isOnline(): boolean {
		if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
			return navigator.onLine && this.online;
		}
		return this.online;
	}

	setOnline(online: boolean): void {
		this.online = online;
	}

	async close(): Promise<void> {
		await this.stopStream();
		await this.db.close?.();
	}

	// ── helpers ──────────────────────────────────────────────────────────────────

	private async postJson<T>(action: string, body: unknown): Promise<T> {
		const response = await this.httpFetch(`sync/${action}`, {
			method: 'POST',
			body: JSON.stringify(body),
			accept: 'application/json'
		});
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
