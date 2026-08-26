import { and, asc, eq, exists, gt, inArray, lt, lte, max, or } from 'drizzle-orm';
import { alias as tableAlias } from 'drizzle-orm/pg-core';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import {
	coalesce,
	commitHorizon,
	composer,
	dbNowMinusDays,
	greatest,
	horizonSequence,
	one,
	scalar,
	toStatement,
	type Statement
} from '#lib/runtime/persistence.js';

/**
 * What keeps the change log from growing forever, composed once and executed by two callers.
 *
 * Two operations, and only one of them can hurt anybody:
 *
 * - **Collapse** removes rows a newer row for the same record has superseded. A replica at any
 *   cursor still converges, because the surviving row carries the record's final state — so this is
 *   safe to run at any time, against any log, with nobody told anything.
 * - **Retention** removes rows past the window whether or not anything replaced them, so it can take
 *   the last row a record ever had. That is the only way a replica can be left with a gap it cannot
 *   detect, which is what the horizon mark exists to make detectable: `diff` answers any cursor
 *   below the mark with a rebuild.
 *
 * The mark is therefore written **before** the delete and covers every row the retention window
 * names, not merely the rows one bounded pass got to. Deriving it from what was deleted would need
 * the deleted cursors back in the guest, which forces a returning statement and a second round trip;
 * marking the whole window instead costs a replica that is already a month behind one extra rebuild
 * and makes "nothing is ever deleted above the mark" a property of the statement order rather than
 * of an argument about timing. `now()` is the transaction timestamp, so both statements read one
 * retention cutoff when they ride the same batch — which they must.
 */

const { bolt_sync_horizon: syncHorizon, bolt_sync_outbox: syncOutbox } = SYSTEM_MODEL_TABLES;
const newerSyncOutbox = tableAlias(syncOutbox, 'newer_sync_outbox');

/** Rows below the oldest transaction still in flight; see `Sync.diff` for why nothing above it moves. */
const COMMIT_HORIZON = commitHorizon();

/** What `sync.compact` keeps when a caller names no window. */
export const DEFAULT_RETENTION_DAYS = 30;

/**
 * At most this many rows leave the outbox per operation per tick.
 *
 * The same bound, and the same reason, as the task queue's own `PRUNE_LIMIT`: maintenance folded
 * into a tick must never become the tick's whole budget. A workspace with a large backlog drains it
 * over the ticks it was going to run anyway.
 */
const TICK_LIMIT = 200;

/** A row a later row for the same record has already replaced. */
const superseded = () =>
	and(
		lt(syncOutbox.xid, COMMIT_HORIZON),
		exists(
			composer
				.select({ one: one() })
				.from(newerSyncOutbox)
				.where(
					and(
						eq(newerSyncOutbox.collection_name, syncOutbox.collection_name),
						eq(newerSyncOutbox.record_id, syncOutbox.record_id),
						lt(newerSyncOutbox.xid, COMMIT_HORIZON),
						or(
							gt(newerSyncOutbox.xid, syncOutbox.xid),
							and(
								eq(newerSyncOutbox.xid, syncOutbox.xid),
								gt(newerSyncOutbox.sequence, syncOutbox.sequence)
							)
						)
					)
				)
		)
	);

/**
 * A row past the retention window, as the *mark* counts them.
 *
 * Deliberately without the commit-horizon term the delete carries. The mark has to cover every row
 * the delete could reach, and a snapshot taken one statement later can only expose more rows — so
 * the set the mark reads from is the superset, and the set the delete works on is inside it.
 */
const expiredForMark = (days: number) => lt(syncOutbox.created_at, dbNowMinusDays(days));

/** A row past the retention window that has a settled position, and so may actually be removed. */
const expired = (days: number) => and(lt(syncOutbox.xid, COMMIT_HORIZON), expiredForMark(days));

/** At or below the mark, which by construction is at or above every row the window names. */
const atOrBelowMark = () =>
	or(
		lt(syncOutbox.xid, syncHorizon.xid),
		and(eq(syncOutbox.xid, syncHorizon.xid), lte(syncOutbox.sequence, syncHorizon.sequence))
	);

/**
 * The keys of the oldest superseded rows.
 *
 * A `delete … limit` is not valid SQL, so the bound is expressed the way the task queue expresses
 * its own: select the keys first. Ordering makes a bounded pass deterministic — the oldest rows go
 * first, so repeated ticks walk the log rather than sampling it.
 */
const supersededKeys = (limit: number | undefined) => {
	const keys = composer
		.select({ id: syncOutbox.id })
		.from(syncOutbox)
		.where(superseded())
		.orderBy(asc(syncOutbox.xid), asc(syncOutbox.sequence));
	return limit === undefined ? keys : keys.limit(limit);
};

/** The keys of the oldest expired rows, joined to the mark so none above it can be named. */
const expiredKeys = (days: number, limit: number | undefined) => {
	const keys = composer
		.select({ id: syncOutbox.id })
		.from(syncOutbox)
		.innerJoin(syncHorizon, eq(syncHorizon.singleton, true))
		.where(and(expired(days), atOrBelowMark()))
		.orderBy(asc(syncOutbox.xid), asc(syncOutbox.sequence));
	return limit === undefined ? keys : keys.limit(limit);
};

/** Removes superseded rows. Safe at any cursor, so it moves no mark and strands nobody. */
export const collapse = (limit?: number) =>
	composer.delete(syncOutbox).where(inArray(syncOutbox.id, supersededKeys(limit)));

/**
 * Declares every row the retention window names unreadable, without deleting anything.
 *
 * `max(xid)` and `max(sequence)` are taken independently, which names a cursor no row need have.
 * That is correct and intended: `sequence` is unique across the log, so the pair is at or above
 * every row in the window under the log's own ordering, and the mark is a boundary rather than a
 * position anybody reads a row from.
 */
export const markRetained = (days: number) => {
	const xid = scalar(
		composer
			.select({ value: coalesce(max(syncOutbox.xid), 0) })
			.from(syncOutbox)
			.where(expiredForMark(days))
	);
	const sequence = scalar(
		composer
			.select({ value: coalesce(max(syncOutbox.sequence), 0) })
			.from(syncOutbox)
			.where(expiredForMark(days))
	);
	return composer
		.update(syncHorizon)
		.set({
			// `greatest`, because a later compaction must never move the mark backwards: that would
			// re-admit cursors already declared stranded.
			xid: greatest(syncHorizon.xid, xid),
			sequence: horizonSequence(syncHorizon.xid, syncHorizon.sequence, xid, sequence)
		})
		.where(eq(syncHorizon.singleton, true));
};

/** Removes rows past the window, never above the mark `markRetained` has already written. */
export const prune = (days: number, limit?: number) =>
	composer.delete(syncOutbox).where(inArray(syncOutbox.id, expiredKeys(days, limit)));

/**
 * One bounded maintenance pass, for a caller that has a batch going and no use for what it removed.
 *
 * Order is the whole correctness argument: mark before prune, so no statement can delete a row the
 * mark does not already cover.
 */
export const tickStatements = (
	days: number = DEFAULT_RETENTION_DAYS,
	limit: number = TICK_LIMIT
): ReadonlyArray<Statement> =>
	[collapse(limit), markRetained(days), prune(days, limit)].map((query) =>
		toStatement(query.toSQL())
	);
