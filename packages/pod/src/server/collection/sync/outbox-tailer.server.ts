import type { ProvisionedContext } from '$lib/server/bootstrap/workspace_store.js';
import type { SyncOutboxAction } from './sync-outbox.server.js';

/**
 * The change-feed cursor. `sync_outbox.seq` is a BIGSERIAL assigned at INSERT time, but
 * transactions commit out of order, so `seq` order is NOT commit order — a row with a
 * small `seq` may belong to a transaction still in flight while a larger `seq` has already
 * committed. Emitting by `seq` alone would therefore permanently skip the small-seq row
 * once it committed.
 *
 * The tailer instead orders and cursors by the writing transaction id (`xid`, an xid8 that
 * never wraps) and only emits rows whose `xid` has dropped below the *oldest still in-flight
 * transaction* — `pg_snapshot_xmin(pg_current_snapshot())`. That horizon is the safe
 * watermark: once a row's xid is below it, its transaction is committed AND no transaction
 * with an equal-or-smaller xid can still appear, so `(xid, seq)` order is stable and
 * gap-free. `seq` remains the tiebreaker within a transaction (e.g. a `createMany`).
 */
export type OutboxCursor = { readonly xid: string; readonly seq: string };

/** Before any row: xid8 `0` sorts below every real transaction id. */
export const OUTBOX_CURSOR_START: OutboxCursor = { xid: '0', seq: '0' };

export type SyncOutboxRow = {
	readonly seq: string;
	readonly collection: string;
	readonly recordId: string;
	readonly action: SyncOutboxAction;
	readonly rowVersion: number | null;
	readonly occurredAt: string;
	readonly xid: string;
};

export type OutboxBatch = {
	readonly rows: readonly SyncOutboxRow[];
	/** Advance past this cursor on the next read. Unchanged when nothing was safe to emit. */
	readonly cursor: OutboxCursor;
};

type RawOutboxRow = {
	seq: string;
	collection: string;
	record_id: string;
	action: string;
	row_version: number | string | null;
	occurred_at: string | Date;
	xid: string;
};

function toIso(value: string | Date): string {
	if (value instanceof Date) return value.toISOString();
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function normalize(raw: RawOutboxRow): SyncOutboxRow {
	return {
		seq: String(raw.seq),
		collection: raw.collection,
		recordId: raw.record_id,
		action: raw.action as SyncOutboxAction,
		rowVersion:
			raw.row_version == null
				? null
				: typeof raw.row_version === 'number'
					? raw.row_version
					: Number(raw.row_version),
		occurredAt: toIso(raw.occurred_at),
		xid: String(raw.xid)
	};
}

/**
 * Read the next safe batch of change-feed rows strictly after `cursor`, up to `limit`.
 * The horizon is evaluated inline so the visibility filter and the rows come from one
 * snapshot. Returns the rows in `(xid, seq)` order plus the advanced cursor (the last
 * row's `(xid, seq)`, or the input cursor when nothing was safe yet).
 */
export async function readSyncOutboxBatch(
	ctx: ProvisionedContext,
	cursor: OutboxCursor,
	limit = 500
): Promise<OutboxBatch> {
	const cappedLimit = Math.min(Math.max(limit, 1), 5000);
	// The ORDER BY is table-qualified on purpose. An unqualified name there resolves to an
	// *output column* first, and this select list renames `xid`/`seq` to text projections of
	// themselves — so a bare `ORDER BY xid, seq` sorts the text, giving 1, 10, 100, 1000, 101 …
	// while the cursor predicate below still compares numerically. Order and filter disagreeing
	// is not merely out-of-order delivery: the cursor advances to the last row of a lexicographic
	// page, and every numerically smaller row that page skipped is then excluded forever by
	// `seq > $2`. A qualified name can only mean the input column, so the sort and the predicate
	// are the same total order again.
	const result = await ctx.tenantDb.query<RawOutboxRow>(
		`SELECT seq::text AS seq,
		        collection,
		        record_id::text AS record_id,
		        action,
		        row_version,
		        occurred_at,
		        xid::text AS xid
		   FROM sync_outbox
		  WHERE xid < pg_snapshot_xmin(pg_current_snapshot())
		    AND (xid > $1::xid8 OR (xid = $1::xid8 AND seq > $2::bigint))
		  ORDER BY sync_outbox.xid, sync_outbox.seq
		  LIMIT $3`,
		[cursor.xid, cursor.seq, cappedLimit]
	);
	const rows = result.rows.map(normalize);
	if (rows.length === 0) return { rows, cursor };
	const last = rows[rows.length - 1]!;
	return { rows, cursor: { xid: last.xid, seq: last.seq } };
}

/**
 * Resolve the cursor to resume just after a given `seq` (the wire-facing watermark a client
 * echoes back). By resume time the row at `seq` is long committed and below the horizon, so
 * its `(xid, seq)` is a stable resume point. Falls back to the start of the feed when the seq
 * is unknown (0, pruned, or never existed) — the caller then re-bootstraps via `subscribe`.
 */
export async function outboxCursorForSeq(
	ctx: ProvisionedContext,
	seq: string
): Promise<OutboxCursor> {
	if (!seq || seq === '0') return OUTBOX_CURSOR_START;
	const result = await ctx.tenantDb.query<{ xid: string; seq: string }>(
		`SELECT xid::text AS xid, seq::text AS seq FROM sync_outbox WHERE seq = $1::bigint`,
		[seq]
	);
	const row = result.rows[0];
	return row ? { xid: String(row.xid), seq: String(row.seq) } : OUTBOX_CURSOR_START;
}

// ── retention ──────────────────────────────────────────────────────────────────
//
// The feed is bounded by age, and the boundary of what was discarded is durable. Those two facts
// are one feature: pruning without recording the boundary turns a client whose cursor fell behind
// into a silently, permanently wrong replica, because it resumes from a feed that no longer holds
// its changes and nothing tells it so.

/**
 * How long a change stays readable.
 *
 * This is the offline budget: a client away for less than this resumes by delta, and one away for
 * longer rebuilds from scratch. A week covers a holiday and keeps the table proportional to write
 * volume rather than to tenant age.
 */
const RETENTION_DAYS = 7;

/** Never prune below this many recent rows, however old they are. */
const RETENTION_FLOOR_ROWS = 1_000;

/** How often a runtime bothers to sweep. The work is idempotent; this only limits churn. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

let lastPruneAt = 0;

/**
 * Everything at or below this seq has been discarded. A client cursor at or below it cannot be
 * resumed and must rebuild.
 */
export async function syncCompactionBoundary(ctx: ProvisionedContext): Promise<string> {
	const result = await ctx.tenantDb.query<{ seq: string }>(
		`SELECT pruned_through_seq::text AS seq FROM _norbital_sync_compaction WHERE singleton = TRUE`
	);
	return result.rows[0]?.seq ?? '0';
}

/**
 * Drop changes past their retention, and advance the boundary to match.
 *
 * Order matters: the boundary is raised in the same statement batch that deletes, and to the
 * highest seq actually removed. Advancing it further than what was deleted would reject clients
 * that could still have been served; advancing it less would leave clients resuming into a hole.
 */
export async function pruneSyncOutbox(
	ctx: ProvisionedContext,
	options?: { force?: boolean }
): Promise<{ deleted: number; boundary: string }> {
	if (!options?.force && Date.now() - lastPruneAt < PRUNE_INTERVAL_MS) {
		return { deleted: 0, boundary: await syncCompactionBoundary(ctx) };
	}
	lastPruneAt = Date.now();

	// The floor is expressed as "keep the newest N", so the cut is the highest seq that is both
	// older than the retention window and outside that floor. A single statement so a concurrent
	// reader cannot observe rows gone before the boundary moved.
	const result = await ctx.tenantDb.query<{ seq: string | null; deleted: string }>(
		`WITH cut AS (
		   SELECT max(seq) AS seq
		     FROM (
		       SELECT seq
		         FROM sync_outbox
		        WHERE occurred_at < now() - ($1 || ' days')::interval
		        ORDER BY seq DESC
		        OFFSET $2
		     ) old
		 ),
		 removed AS (
		   DELETE FROM sync_outbox
		    WHERE seq <= (SELECT seq FROM cut)
		    RETURNING seq
		 ),
		 advanced AS (
		   UPDATE _norbital_sync_compaction
		      SET pruned_through_seq = GREATEST(pruned_through_seq, COALESCE((SELECT seq FROM cut), 0)),
		          pruned_at = CURRENT_TIMESTAMP
		    WHERE singleton = TRUE
		    RETURNING pruned_through_seq
		 )
		 SELECT (SELECT pruned_through_seq::text FROM advanced) AS seq,
		        (SELECT count(*)::text FROM removed) AS deleted`,
		[String(RETENTION_DAYS), RETENTION_FLOOR_ROWS]
	);
	const row = result.rows[0];
	return { deleted: Number(row?.deleted ?? 0), boundary: row?.seq ?? '0' };
}

/** Whether a client's resume point still exists in the feed. */
export function isCursorTooOld(cursorSeq: string, boundary: string): boolean {
	try {
		return BigInt(cursorSeq || '0') < BigInt(boundary || '0');
	} catch {
		return false;
	}
}

/** The current safe watermark seq: the largest `seq` whose xid is below the horizon. */
export async function currentOutboxWatermark(ctx: ProvisionedContext): Promise<string> {
	const result = await ctx.tenantDb.query<{ seq: string | null }>(
		`SELECT max(seq)::text AS seq
		   FROM sync_outbox
		  WHERE xid < pg_snapshot_xmin(pg_current_snapshot())`
	);
	return result.rows[0]?.seq ?? '0';
}
