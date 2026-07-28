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

/** The current safe watermark seq: the largest `seq` whose xid is below the horizon. */
export async function currentOutboxWatermark(ctx: ProvisionedContext): Promise<string> {
	const result = await ctx.tenantDb.query<{ seq: string | null }>(
		`SELECT max(seq)::text AS seq
		   FROM sync_outbox
		  WHERE xid < pg_snapshot_xmin(pg_current_snapshot())`
	);
	return result.rows[0]?.seq ?? '0';
}
