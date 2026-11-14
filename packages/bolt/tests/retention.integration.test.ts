// The built-in retention pass on PGlite: what it deletes and keeps, its bounded batch, the configured retention and
// interval, and that no person, list or assistant can start it.
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import { TestWorkspace, type Kit } from '../../bolt-cli/src/test/index.ts';
import { makePruner, PRUNE } from '../src/engine/runs/prune.ts';
import { startable_automations } from '../src/shell/nav.ts';
import { manifest } from './catalogue-fixture.ts';

const NOW = '2026-09-25T10:00:00.000Z';
const DAY = 86_400_000;
const workspace = Effect.gen(function* () {
	const context = yield* Layer.build(TestWorkspace.layer({ manifest, now: NOW }));
	return { t: Context.get(context, TestWorkspace), pruner: yield* makePruner().pipe(Effect.provide(context)) };
});
const write = (t: Pick<Kit, 'db'>, text: string) => t.db.write({ text, params: [] });
const ids = (t: Pick<Kit, 'db'>, text: string) =>
	t.db.read([{ text, params: [] }]).pipe(
		Effect.map(([result]) => (result?.rows ?? []).map((row) => String(row['id'])))
	);
/** Inbox notices `[id, at, read_at]` for one member. */
const notices = (rows: readonly (readonly [string, string, string | null])[]) =>
	`INSERT INTO sys_notification (id, recipient, title, member, at, read_at) VALUES ${rows
		.map(([id, at, read]) => `('${id}', '{}', 'Notice', 'u1', '${at}', ${read === null ? 'NULL' : `'${read}'`})`)
		.join(', ')}`;

describe('built-in retention', () => {
	it.live('read notifications past 30 days go; unread and recently read ones stay', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, pruner } = yield* workspace;
				yield* write(t, notices([
					['old_read', '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z'],
					['old_unread', '2025-01-01T00:00:00Z', null],
					['young_read', '2026-09-01T00:00:00Z', '2026-09-20T00:00:00Z']
				]));
				yield* pruner.prune(Date.parse(NOW));
				expect(yield* ids(t, 'SELECT id FROM sys_notification ORDER BY id')).toEqual(['old_unread', 'young_read']);
			})
		)
	);

	it.live('finished runs past 90 days go; running, waiting and recent ones stay', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, pruner } = yield* workspace;
				yield* write(t, `INSERT INTO sys_run (id, automation, input, due_at, cause, depth, state, finished_at) VALUES
					('old_done', 'x', '{}', '2026-01-01', 'cron', 0, 'succeeded', '2026-01-01'),
					('old_failed', 'x', '{}', '2026-01-01', 'cron', 0, 'failed', '2026-01-02'),
					('old_running', 'x', '{}', '2026-01-01', 'cron', 0, 'running', NULL),
					('old_waiting', 'x', '{}', '2027-01-01', 'cron', 0, 'waiting', NULL),
					('young_done', 'x', '{}', '2026-09-01', 'cron', 0, 'succeeded', '2026-09-01')`);
				yield* pruner.prune(Date.parse(NOW));
				expect(yield* ids(t, `SELECT id FROM sys_run WHERE automation = 'x' ORDER BY id`)).toEqual([
					'old_running',
					'old_waiting',
					'young_done'
				]);
			})
		)
	);

	it.live('a pass deletes at most 10,000 rows per kind and queues its continuation', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, pruner } = yield* workspace;
				yield* write(t, `INSERT INTO sys_notification (id, recipient, title, member, at, read_at)
					SELECT 'n' || n, '{}', 'Notice', 'u1', '2026-01-01', '2026-01-02' FROM generate_series(1, 10001) n`);
				const pass = yield* pruner.prune(Date.parse(NOW));
				expect(pass.continued).toBe(Date.parse(NOW));
				expect(yield* ids(t, 'SELECT count(*)::text AS id FROM sys_notification')).toEqual(['1']);
				expect(yield* ids(t, `SELECT state AS id FROM sys_run WHERE automation = '${PRUNE}'`)).toEqual(['queued']);
			})
		)
	);

	it.live('the configured retention replaces the defaults', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, pruner } = yield* workspace;
				yield* write(t, `INSERT INTO sys_config (key, value) VALUES ('retention', '{"notifications_days":5,"runs_days":10}')`);
				yield* write(t, notices([
					['read_week_ago', '2026-09-01T00:00:00Z', '2026-09-18T00:00:00Z'],
					['read_yesterday', '2026-09-01T00:00:00Z', '2026-09-24T00:00:00Z']
				]));
				yield* write(t, `INSERT INTO sys_run (id, automation, input, due_at, cause, depth, state, finished_at) VALUES
					('three_weeks', 'x', '{}', '2026-09-04', 'cron', 0, 'succeeded', '2026-09-04'),
					('last_week', 'x', '{}', '2026-09-20', 'cron', 0, 'succeeded', '2026-09-20')`);
				yield* pruner.prune(Date.parse(NOW));
				expect(yield* ids(t, 'SELECT id FROM sys_notification')).toEqual(['read_yesterday']);
				expect(yield* ids(t, `SELECT id FROM sys_run WHERE automation = 'x'`)).toEqual(['last_week']);
			})
		)
	);

	it.live('the daily pass waits the configured interval since the last pass', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, pruner } = yield* workspace;
				yield* write(t, `INSERT INTO sys_config (key, value) VALUES ('retention', '{"every_days":7}'), ('retention.pass', '2026-09-25')`);
				yield* write(t, notices([['old_read', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z']]));
				expect(yield* pruner.daily(Date.parse(NOW) + 6 * DAY)).toBeUndefined();
				expect(yield* ids(t, 'SELECT id FROM sys_notification')).toEqual(['old_read']);
				expect(yield* pruner.daily(Date.parse(NOW) + 7 * DAY)).toBeDefined();
				expect(yield* ids(t, 'SELECT id FROM sys_notification')).toEqual([]);
				expect(yield* ids(t, `SELECT value AS id FROM sys_config WHERE key = 'retention.pass'`)).toEqual(['2026-10-02']);
			})
		)
	);

	it.live('no person, list or assistant can start the pass', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t } = yield* workspace;
				const admin = yield* t.as(t.admin);
				const name: string = PRUNE;
				expect(t.manifest.automations[name]).toBeUndefined();
				expect(startable_automations(t.manifest, admin.authority).map((a) => a.name)).not.toContain(name);
				expect(yield* Effect.flip(admin.run(name, {}, Schema.Unknown))).toMatchObject({
					_tag: 'ActRefused',
					code: 'not_found'
				});
			})
		)
	);
});
