import { Context, Effect, Layer } from 'effect';
// Rule 25a on PGlite: engine loops cap their pass and prove progress. `bolt.prune` deletes at most 10,000 rows per table
// and queues one continuation; a prune pass that selects rows and deletes none stops `noProgress` and queues nothing.
import { describe, expect, it } from '@effect/vitest';
import { TestWorkspace, type Kit } from '../src/test/index.ts';
import { manifest } from './catalogue-fixture.ts';

const NOW = '2026-09-25T10:00:00.000Z';
const OLD = '2026-09-20T10:00:00.000Z';
const sql = (t: Pick<Kit, 'db'>, text: string) =>
	t.db.read([{ text, params: [] }]).pipe(
		Effect.map(([result]) => {
			if (result === undefined) throw new Error('Missing SQL result');
			return result.rows;
		})
	);
/** Rate windows older than a day are what the prune deletes. */
const aged = (n: number) =>
	`INSERT INTO bolt_rate SELECT 'act', 'k' || n, '${OLD}', 1 FROM generate_series(1, ${n}) n`;

describe('rule 25a: engine loops', () => {
	it.live(
		'bolt.prune deletes 10,000 rows a pass, then one continuation run finishes the rest',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const t = Context.get(
						yield* Layer.build(TestWorkspace.layer({ manifest, now: NOW })),
						TestWorkspace
					);
					yield* t.db.write({ text: aged(10_001), params: [] });
					yield* t.runDue();
					expect(
						yield* sql(t, `SELECT count(*)::int AS n FROM bolt_rate WHERE bucket LIKE 'k%'`)
					).toEqual([{ n: 1 }]);
					expect(
						yield* sql(t, `SELECT state FROM sys_run WHERE automation = 'bolt.prune'`)
					).toEqual([{ state: 'queued' }]);
					yield* t.runDue();
					expect(
						yield* sql(t, `SELECT count(*)::int AS n FROM bolt_rate WHERE bucket LIKE 'k%'`)
					).toEqual([{ n: 0 }]);
					expect(
						yield* sql(t, `SELECT state FROM sys_run WHERE automation = 'bolt.prune'`)
					).toEqual([{ state: 'succeeded' }]);
				})
			)
	);

	it.live(
		'a prune pass that deletes none of the rows it selected stops noProgress and queues nothing',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const t = Context.get(
						yield* Layer.build(TestWorkspace.layer({ manifest, now: NOW })),
						TestWorkspace
					);
					yield* t.db.write({ text: aged(1), params: [] });
					yield* t.db.write({
						text: `CREATE FUNCTION keep() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
						params: []
					});
					yield* t.db.write({
						text: `CREATE TRIGGER keep BEFORE DELETE ON bolt_rate FOR EACH ROW EXECUTE FUNCTION keep()`,
						params: []
					});
					yield* t.db.write({
						text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth) VALUES ('p', 'bolt.prune', '{}', '${NOW}', 'continue', 0)`,
						params: []
					});
					yield* t.runDue();
					expect(
						yield* sql(
							t,
							`SELECT state, error->>'code' AS code FROM sys_run WHERE automation = 'bolt.prune'`
						)
					).toEqual([{ state: 'failed', code: 'noProgress' }]);
					expect(t.fakes.logs.filter((r) => r.event === 'prune.noProgress')).toHaveLength(1); // the daily pass, inline
				})
			)
	);
});
