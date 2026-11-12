import { Effect, Schema } from 'effect';
import { q } from '@norbital-ai/store';
import { BoltError } from '../../protocol/errors.ts';
import { TenantDb } from '../db/tenant-db.ts';
import { CapturedResult, capturePiece, nativeCommit } from '../db/captured.ts';
import type { EngineError } from '../errors.ts';
import { layered, relations } from '../manifest.ts';
import { Logs } from '../ports.ts';
import { prune_history } from '../query/history.ts';
import { Live, Manifest } from '../services.ts';
import { Chain } from '../write/sql.ts';
import { retainedBackfills } from '../sync/backfill.ts';
import { enqueue } from './queue.ts';
import { runPiece } from './rows.ts';
import { iso } from './time.ts';

export const PRUNE = 'bolt.prune';
const MAX_IDS = 10_000, DAY = 86_400_000;

/** Retention and its continuation belong to the run generation that admits the pass. */
export const makePruner = Effect.fn('Runs.pruning')(function* () {
	const m = yield* Manifest, db = yield* TenantDb, live = yield* Live, logs = yield* Logs;
	const references = relations(layered(m)).all;
	const unreferenced = (model: string, except: readonly string[] = []) => references
		.filter((r) => !except.includes(r.from) && r.targets.includes(model))
		.map((r) => ` AND NOT EXISTS (SELECT 1 FROM ${q(r.from)} r WHERE r.${q(r.targets.length > 1 ? `${r.fk}__${model}` : r.fk)} = ${q(model)}.id)`)
		.join('');
	let prunedDay = -1;
	const prune = Effect.fn('Runs.prune')(function* (
		now: number
	): Effect.fn.Return<{ deleted: number; continued?: number }, EngineError> {
		const cleanup = new Chain();
		cleanup.params.push(iso(now));
		const kept = cleanup.cte('retained_backfills', retainedBackfills(m, cleanup));
		const aged = {
			sys_run: `state IN ('succeeded', 'failed', 'stopped', 'skipped') AND finished_at < $1::timestamptz - interval '90 days'
			AND NOT EXISTS (SELECT 1 FROM ${kept} retained WHERE retained.id = sys_run.id)`,
			// a run's idempotency receipt ages out with that run
			bolt_idem: `((run IS NOT NULL AND (run IN (SELECT id FROM sel_sys_run) OR NOT EXISTS (SELECT 1 FROM sys_run r WHERE r.id = bolt_idem.run)))
			OR (run IS NULL AND issued_at < $1::timestamptz - interval '24 hours'))
			AND NOT EXISTS (SELECT 1 FROM bolt_audit_receipt a WHERE a.outcome_key=bolt_idem.key AND a.acknowledged_at IS NULL AND a.expired_at IS NULL)`,
			bolt_rate: `window_start < $1::timestamptz - interval '1 day'`,
			// a consumed delivery only dedupes a redelivery, and providers stop retrying within days
			sys_inbox: `consumed_at < $1::timestamptz - interval '30 days'`,
			// Only completed outcomes age out; dead letters retain replay evidence until replay or a newer ack retires them.
			sys_outbox: `status IN ('acked', 'failed', 'skipped') AND greatest(at, acked_at, claimed_at) < $1::timestamptz - interval '90 days'
			AND NOT EXISTS (SELECT 1 FROM sys_message s WHERE s.direction = 'outbound' AND s.status IN ('queued', 'sending') AND s.meta->>'sync_write' = sys_outbox.key)`,
			sys_challenge: `expires_at <= $1::timestamptz`,
			sys_invitation: `greatest(expires_at, accepted_at, revoked_at) < $1::timestamptz - interval '90 days'${unreferenced('sys_invitation')}`,
			sys_notification: `(read_at < $1::timestamptz - interval '90 days') OR at < $1::timestamptz - interval '365 days'`, // L-BOLT-354
			bolt_host_nonce: `at < $1::timestamptz - CASE WHEN key LIKE 'nonce:%' THEN interval '10 minutes' ELSE interval '30 days' END`,
			// an anonymous user whose session lapsed (30 days unused) or was retired by a sign-in, unless a record references it
			sys_user: `kind = 'anonymous' AND NOT EXISTS (SELECT 1 FROM sys_session s WHERE s."user" = sys_user.id AND s.expires_at > $1::timestamptz)${unreferenced('sys_user', ['sys_session'])}`,
			sys_session: `expires_at <= $1::timestamptz AND NOT EXISTS (SELECT 1 FROM sel_sys_user u WHERE u.id = sys_session."user")`
		};
		const tables = Object.keys(aged);
		for (const [table, where] of Object.entries(aged)) {
			cleanup.cte(`sel_${table}`, `SELECT ctid${table === 'sys_run' || table === 'sys_user' ? ', id' : ''} FROM ${table} WHERE ${where} LIMIT ${MAX_IDS}`);
			const statement = `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM sel_${table})`;
			if (table === 'sys_run') runPiece(cleanup, `del_${table}`, statement, { returning: '1 AS changed' });
			// a table keyed by its own field (sys_challenge) has no `id` to capture
			else if (table === 'sys_outbox' || (Object.hasOwn(layered(m).models, table)
				&& typeof layered(m).models[table]?.table?.primary !== 'object'))
				capturePiece(cleanup, `del_${table}`, table, statement, { returning: '1 AS changed' });
			else cleanup.cte(`del_${table}`, `${statement} RETURNING 1 AS changed`);
		}
		const { selected, deleted, more } = yield* nativeCommit(db.write, live.publish, cleanup,
			Schema.Struct({ ...CapturedResult.fields, selected: Schema.Number, deleted: Schema.Number, more: Schema.Boolean }),
			`${tables.map((t) => `(SELECT count(*)::int FROM sel_${t})`).join(' + ')} AS selected,
			${tables.map((t) => `(SELECT count(*)::int FROM del_${t})`).join(' + ')} AS deleted,
			${tables.map((t) => `(SELECT count(*) FROM sel_${t}) >= ${MAX_IDS}`).join(' OR ')} AS more`);
		// the history horizon (rule 17, L-BOLT-182): 256 revisions per row, never an open restore point or an erased revision
		// ponytail: uncapped by rule 25a's 10,000; cap it with a ctid select if a backlog ever makes this pass long
		const pruned = yield* prune_history(db);
		if (selected > 0 && deleted === 0)
			return yield* Effect.fail(
				BoltError.make(
					'no_progress',
					'commit',
					`bolt.prune: a pass selected ${selected} rows and deleted 0; it stops (rule 25a)`
				)
			);
		if (!more)
			return { deleted: deleted + pruned };
		const c = new Chain();
		enqueue(c, [{ automation: PRUNE, input: {}, due_at: iso(now), cause: 'continue', depth: 0 }], {
			when: `NOT EXISTS (SELECT 1 FROM sys_run WHERE automation = ${c.p(PRUNE)} AND state = 'queued')`
		});
		yield* nativeCommit(db.write, live.publish, c, CapturedResult);
		return { deleted: deleted + pruned, continued: now };
	});
	/** The first wake or written fire of a day prunes (rule 56); `undefined` once it ran today, or when it made no progress. */
	const daily = (now: number) =>
		Effect.suspend(
			(): Effect.Effect<{ deleted: number; continued?: number } | undefined, EngineError> => {
				if (Math.floor(now / DAY) === prunedDay) return Effect.succeed(undefined);
				prunedDay = Math.floor(now / DAY);
				return prune(now).pipe(
					Effect.catchTag('BoltError', (error): Effect.Effect<undefined, EngineError> =>
						error.code !== 'no_progress'
							? Effect.fail(error)
							: logs
									.write({
										at: iso(now),
										severity: 'warn',
										event: 'prune.no_progress',
										invocation: PRUNE,
										run: null,
										conversation: null,
										turn: null,
										attributes: { code: error.code, message: error.message }
									})
									.pipe(Effect.as(undefined))
					)
				);
			}
		);
	return { prune, daily };
});
