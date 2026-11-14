import { DateTime, Effect, Schema } from 'effect';
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
import { RETENTION_PASS_KEY, retentionState, type Retention } from './retention.ts';

/**
 * The built-in retention pass: a platform job in every workspace, never an authored automation, so no app, automation
 * list or assistant can start it. It runs while the database is awake for other work and never wakes it.
 */
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
	/** The workspace-zone date of `now` with its day starting at `hour`: a pass belongs to the quiet hour's day. */
	const dayOf = (now: number, hour: number) =>
		DateTime.formatIsoDate(DateTime.makeZonedUnsafe(now - hour * 3_600_000, { timeZone: m.workspace.tz }));
	/** The day this generation last checked whether a pass was due, at the hour it read. */
	let checked: { day: string; hour: number } | undefined;
	const prune = Effect.fn('Runs.prune')(function* (
		now: number,
		retention?: Retention
	): Effect.fn.Return<{ deleted: number; continued?: number }, EngineError> {
		const r = retention ?? (yield* retentionState(db)).settings;
		const cleanup = new Chain();
		cleanup.params.push(iso(now));
		const kept = cleanup.cte('retained_backfills', retainedBackfills(m, cleanup));
		const runs = `$1::timestamptz - make_interval(days => ${cleanup.p(r.runs_days)}::int)`,
			read = `$1::timestamptz - make_interval(days => ${cleanup.p(r.notifications_days)}::int)`;
		cleanup.cte('retention_pass', `INSERT INTO sys_config (key, value) VALUES ('${RETENTION_PASS_KEY}', ${cleanup.p(dayOf(now, r.hour))})
			ON CONFLICT (key) DO UPDATE SET value = excluded.value RETURNING key`);
		const aged = {
			sys_run: `state IN ('succeeded', 'failed', 'stopped', 'skipped') AND finished_at < ${runs}
			AND NOT EXISTS (SELECT 1 FROM ${kept} retained WHERE retained.id = sys_run.id)`,
			// a run's idempotency receipt ages out with that run
			bolt_idem: `((run IS NOT NULL AND (run IN (SELECT id FROM sel_sys_run) OR NOT EXISTS (SELECT 1 FROM sys_run r WHERE r.id = bolt_idem.run)))
			OR (run IS NULL AND issued_at < $1::timestamptz - interval '24 hours'))
			AND NOT EXISTS (SELECT 1 FROM bolt_audit_receipt a WHERE a.outcome_key=bolt_idem.key AND a.acknowledged_at IS NULL AND a.expired_at IS NULL)`,
			bolt_rate: `window_start < $1::timestamptz - interval '1 day'`,
			// a consumed delivery only dedupes a redelivery, and providers stop retrying within days
			sys_inbox: `consumed_at < $1::timestamptz - interval '30 days'`,
			// Only completed outcomes age out; dead letters retain replay evidence until replay or a newer ack retires them.
			sys_outbox: `status IN ('acked', 'failed', 'skipped') AND greatest(at, acked_at, claimed_at) < ${runs}
			AND NOT EXISTS (SELECT 1 FROM sys_message s WHERE s.direction = 'outbound' AND s.status IN ('queued', 'sending') AND s.meta->>'sync_write' = sys_outbox.key)`,
			sys_challenge: `expires_at <= $1::timestamptz`,
			sys_invitation: `greatest(expires_at, accepted_at, revoked_at) < $1::timestamptz - interval '90 days'${unreferenced('sys_invitation')}`,
			// an inbox notice once read past its retention, never unread; a channel notice (no member, never read) with the runs
			sys_notification: `(member IS NOT NULL AND read_at < ${read}) OR (member IS NULL AND at < ${runs})`,
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
		// the history horizon: 256 revisions per row, never an open restore point or an erased revision
		// ponytail: uncapped by the 10,000-row pass cap; cap it with a ctid select if a backlog ever makes this pass long
		const pruned = yield* prune_history(db);
		if (selected > 0 && deleted === 0)
			return yield* Effect.fail(
				BoltError.make(
					'no_progress',
					'commit',
					`bolt.prune: a pass selected ${selected} rows and deleted 0; it stops`
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
	/**
	 * The first tick of a workspace-zone day (from the configured hour) reads the settings and prunes when `every_days`
	 * passed since the last pass; `undefined` when none is due, or it made no progress. Ticks run only while the
	 * database is awake for other work, so retention never wakes it.
	 */
	const daily = Effect.fn('Runs.daily')(function* (
		now: number
	): Effect.fn.Return<{ deleted: number; continued?: number } | undefined, EngineError> {
		if (checked !== undefined && dayOf(now, checked.hour) === checked.day) return undefined;
		const { settings, pass } = yield* retentionState(db);
		const today = dayOf(now, settings.hour);
		checked = { day: today, hour: settings.hour };
		if (pass !== null && Date.parse(today) - Date.parse(pass) < settings.every_days * DAY) return undefined;
		return yield* prune(now, settings).pipe(
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
	});
	return { prune, daily };
});
