import { Effect, Schema } from 'effect';
import { TenantDb } from '../db/tenant-db.ts';
import { CapturedResult, nativeCommit } from '../db/captured.ts';
import type { EngineError } from '../errors.ts';
import { Live } from '../services.ts';
import { Chain } from '../write/sql.ts';
import { enqueue } from './queue.ts';
import type { Row } from './rows.ts';
import { iso } from './time.ts';

/**
 * Where a run's row stands. A queued run has its row; a fired cron's run writes it only with its first effect:
 * `record` writes it once and answers false when the slot already ran.
 */
export type Ledger = {
	readonly record: Effect.Effect<boolean, EngineError>;
	readonly written: () => boolean;
};
export const QUEUED: Ledger = { record: Effect.succeed(true), written: () => true };

/** A cron records its slot at its first effect; the cached answer belongs to this invocation. */
export const cronLedger = Effect.fn('Runs.cronLedger')(function* (run: Row, now: number) {
	const db = yield* TenantDb, live = yield* Live;
	let written = false;
	const record = yield* Effect.cached(
		Effect.gen(function* () {
			const c = new Chain();
			const inserted = enqueue(
				c,
				{
					select: `SELECT ${c.p(run.id)}::text AS id, ${c.p(run.automation)}::text AS automation, ${c.p(run.due_at)}::timestamptz AS due_at, 'cron'::text AS cause, ${c.p(run.trigger)}::jsonb AS trigger, 0 AS depth, 'running'::text AS state, 1 AS attempts, ${c.p(iso(now))}::timestamptz AS started_at`
				},
				{ conflict: 'keep' }
			);
			const result = yield* nativeCommit(db.write, live.publish, c,
				Schema.Struct({ ...CapturedResult.fields, n: Schema.Number }),
				`(SELECT count(*) FROM ${inserted})::int AS n`);
			written = result.n > 0;
			return written;
		})
	);
	return { record, written: () => written };
});
