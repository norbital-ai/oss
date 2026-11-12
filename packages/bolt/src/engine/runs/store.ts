// Captured run-state mutations and authorized native commands.
import { Clock, Deferred, Effect, Option, PubSub, Schema } from 'effect';
import type { Authority } from '../contracts.ts';
import { TURN_RUN } from '../agent/turns.ts';
import { CapturedResult, capturePiece, nativeCommit } from '../db/captured.ts';
import { TenantDb } from '../db/tenant-db.ts';
import type { makeParking } from '../parking.ts';
import { claimSql } from '../queue.ts';
import { Deadlines, Live, Manifest, RunEnds } from '../services.ts';
import { Chain } from '../write/sql.ts';
import { PRUNE } from './prune.ts';
import { DRAIN_KEY_PREFIX, next_due } from './queue.ts';
import { RowSchema, RunViewRow, RUN_VIEW_COLUMNS, run_view, runPiece } from './rows.ts';
import { iso } from './time.ts';
import { enqueueBackfills, SYNC_BACKFILL } from '../sync/backfill.ts';

export const makeRunStore = Effect.fn('Runs.store')(function* (
	parking: Pick<ReturnType<typeof makeParking>, 'parked'>,
	capacities: Readonly<Record<string, number>>,
	halts: Map<string, Deferred.Deferred<void>>,
	stopping: Set<string>
) {
	const m = yield* Manifest, db = yield* TenantDb, live = yield* Live, deadlines = yield* Deadlines, ends = yield* RunEnds;
	const boot = Effect.fn('Runs.boot')(function* (overran?: string) {
			const now = yield* Clock.currentTimeMillis,
				c = new Chain(),
				at = c.p(iso(now)),
				over = c.p(overran ?? null),
				// a handed-off request's work lived in its generation's memory: it is not run again (the person asks again);
				// a run its generation stopped past the CPU budget would only overrun again. A close that interrupted a run is
				// no lost lease (only a crash writes no `interrupted`): restarts cannot use up a run's three
				closed = `error->>'code' = 'interrupted'`,
				fails = `((${over}::text IS NOT NULL AND automation <> '${TURN_RUN}') OR cause = 'handoff' OR (leases >= 3 AND ${closed} IS NOT TRUE))`;
			runPiece(c,
				'lost',
				`UPDATE sys_run SET leases = leases + CASE WHEN ${closed} THEN 0 ELSE 1 END, due_at = ${at}::timestamptz, state = CASE WHEN ${fails} THEN 'failed' ELSE 'queued' END, finished_at = CASE WHEN ${fails} THEN ${at}::timestamptz END, error = CASE WHEN ${over}::text IS NOT NULL THEN jsonb_build_object('code', 'cpu_budget', 'message', ${over}::text) WHEN cause = 'handoff' THEN '{"code":"lost_lease","message":"The host was lost before the request answered."}'::jsonb WHEN ${closed} THEN NULL WHEN leases < 3 THEN error ELSE '{"code":"lost_lease","message":"The run lost its lease 3 times."}'::jsonb END WHERE state = 'running'`,
				{ returning: 'id, state, due_at' }
			);
			// a turn no run answers any more, or that lost its run some other way: its conversation takes input again, and
			// never reads as running forever
			capturePiece(c,
				'released',
				'sys_conversation',
				`UPDATE sys_conversation c SET status = 'idle', lease_until = NULL WHERE c.status = 'running' AND (c.id::text IN (SELECT r.input->>'conversation' FROM sys_run r JOIN lost l ON l.id = r.id WHERE l.state = 'failed' AND r.automation = '${TURN_RUN}') OR (c.lease_until < ${at}::timestamptz AND NOT EXISTS (SELECT 1 FROM sys_run r WHERE r.automation = '${TURN_RUN}' AND r.state IN ('queued', 'running') AND r.input->>'conversation' = c.id::text)))`
			);
			enqueueBackfills(m, c, iso(now));
			const result = yield* nativeCommit(db.write, live.publish, c,
				Schema.Struct({
					...CapturedResult.fields,
					next: Schema.NullOr(Schema.String),
					failed: Schema.Array(Schema.String),
					released: Schema.Array(Schema.String)
				}),
					`least((SELECT min(due_at) FROM sys_run WHERE state = 'queued'), (SELECT min(due_at) FROM lost WHERE state = 'queued'), ${next_due(c)})::text AS next,
					(SELECT coalesce(jsonb_agg(id), '[]'::jsonb) FROM lost WHERE state = 'failed') AS failed,
					(SELECT coalesce(jsonb_agg(id), '[]'::jsonb) FROM released) AS released`
			);
			if (result.failed.length > 0) yield* PubSub.publish(ends, result.failed);
			yield* deadlines.settle(result.next);
			return result.released;
		});
	const claim = Effect.fn('Runs.claim')(function* (now: number, pruned: boolean = false, custom: boolean = false) {
			if (parking.parked) return { runs: [], next: null };
			const c = new Chain(),
				automations = c.p(Object.keys(m.automations)),
				capacity = c.p(capacities),
				due = c.p(iso(now));
			runPiece(c,
				'claimed',
				claimSql('runs', {
					at: due,
					where: `(NOT ${c.p(pruned)} OR q.automation <> ${c.p(PRUNE)})
						AND (SELECT count(*) FROM sys_run x WHERE x.automation = q.automation AND x.state = 'running') < coalesce((${capacity}::jsonb ->> q.automation)::int, 1)
						AND q.automation ${custom ? '' : 'NOT '}IN (SELECT jsonb_array_elements_text(${automations}::jsonb))`,
					order: 'q.due_at, q.id',
					limit: custom ? 1 : 1000,
					set: `run_key = coalesce(q.key, q.run_key), key = CASE WHEN q.automation IN (SELECT jsonb_array_elements_text(${automations}::jsonb)) OR q.key = '${DRAIN_KEY_PREFIX}' || q.automation THEN NULL ELSE q.key END`
				}),
				{ returning: 'q.*' }
			);
			return yield* nativeCommit(
				// Taken before the statement snapshot: separate runtimes must see the previous claim.
				(statement) => db.write(statement, { advisory: ['bolt:runs:claim'] }), live.publish, c,
				Schema.Struct({ ...CapturedResult.fields, runs: Schema.Array(RowSchema), next: Schema.NullOr(Schema.String) }),
				`(SELECT coalesce(jsonb_agg((to_jsonb(x) - '__bolt_capture') || jsonb_build_object('due_at', x.due_at::text) ORDER BY x.due_at, x.id), '[]'::jsonb) FROM claimed x) AS runs, (SELECT min(due_at)::text FROM sys_run WHERE state = 'queued' AND id NOT IN (SELECT id FROM claimed)) AS next`
			);
		});
	const view = (authority: Authority, id: string) =>
		db
			.one(RunViewRow, {
				text: `SELECT ${RUN_VIEW_COLUMNS} FROM sys_run WHERE id = $1`,
				params: [id]
			})
			.pipe(
				Effect.map((row) =>
					Option.flatMap(row, (value) => Option.fromNullishOr(run_view(authority, value)))
				)
			);
	const stop = Effect.fn('Runs.stop')(function* (authority: Authority, id: string) {
			const found = yield* db.one(RunViewRow, {
				text: `SELECT ${RUN_VIEW_COLUMNS} FROM sys_run WHERE id = $1`,
				params: [id]
			});
			if (Option.isNone(found) || run_view(authority, found.value)?.input === undefined)
				return Option.none();
			const c = new Chain();
			c.params.push(id, iso(yield* Clock.currentTimeMillis));
			runPiece(c, 'stopped', `UPDATE sys_run SET state = 'stopped',
				key = CASE WHEN automation = ${c.p(SYNC_BACKFILL)} THEN key ELSE NULL END,
				finished_at = $2::timestamptz, error = jsonb_build_object('code', 'stopped', 'message', 'The run was stopped.')
				WHERE id = $1 AND state IN ('queued', 'running')`,
				{ returning: RUN_VIEW_COLUMNS });
			const result = yield* nativeCommit(db.write, live.publish, c,
				Schema.Struct({ ...CapturedResult.fields, rows: Schema.Array(RunViewRow) }),
				"(SELECT coalesce(jsonb_agg(to_jsonb(s) - '__bolt_capture'), '[]'::jsonb) FROM stopped s) AS rows");
			if (result.rows.length > 0) {
				const halt = halts.get(id);
				if (halt !== undefined) {
					stopping.add(id);
					yield* Deferred.succeed(halt, undefined);
				}
				yield* PubSub.publish(ends, [id]);
			}
			return Option.fromNullishOr(run_view(authority, result.rows[0] ?? found.value));
		});
	return { boot, claim, view, stop };
});
