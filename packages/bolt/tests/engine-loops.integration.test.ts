// Rule 25a on PGlite: engine loops cap their pass and prove progress. `bolt.prune` deletes at most 10,000 rows per table
// and queues one continuation; a prune pass that selects rows and deletes none stops `noProgress` and queues nothing; an
// integration pull that reaches MAX_PAGES queues one continuation run carrying the cursor.
import { describe, expect, it } from 'vitest';
import type { HttpPort, HttpRequest } from '../src/engine/integrations/runner.ts';
import { integrations, MAX_PAGES } from '../src/engine/integrations/runner.ts';
import { testWorkspace, type TestWorkspace } from '../src/test/index.ts';
import { manifest } from './integrations-fixture.ts';

const NOW = '2026-09-25T10:00:00.000Z';
const OLD = '2026-09-20T10:00:00.000Z';
const sql = async (t: Pick<TestWorkspace, 'db'>, text: string) => (await t.db.read([{ text, params: [] }]))[0]!.rows;
const events = (n: number) => `INSERT INTO sys_event (at, severity, event, invocation, attributes) SELECT '${OLD}', 'info', 'aged', 'i', '{}' FROM generate_series(1, ${n})`;

describe('rule 25a: engine loops', () => {
	it('bolt.prune deletes 10,000 rows a pass, then one continuation run finishes the rest', async () => {
		const t = await testWorkspace({ manifest, now: NOW });
		await t.db.write({ text: events(10_001), params: [] });
		await t.runDue();
		expect(await sql(t, `SELECT count(*)::int AS n FROM sys_event WHERE event = 'aged'`)).toEqual([{ n: 1 }]);
		expect(await sql(t, `SELECT state FROM sys_run WHERE automation = 'bolt.prune'`)).toEqual([{ state: 'queued' }]);
		await t.runDue();
		expect(await sql(t, `SELECT count(*)::int AS n FROM sys_event WHERE event = 'aged'`)).toEqual([{ n: 0 }]);
		expect(await sql(t, `SELECT state FROM sys_run WHERE automation = 'bolt.prune'`)).toEqual([{ state: 'succeeded' }]);
	});

	it('a prune pass that deletes none of the rows it selected stops noProgress and queues nothing', async () => {
		const t = await testWorkspace({ manifest, now: NOW });
		await t.db.write({ text: events(1), params: [] });
		await t.db.write({ text: `CREATE FUNCTION keep() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`, params: [] });
		await t.db.write({ text: `CREATE TRIGGER keep BEFORE DELETE ON sys_event FOR EACH ROW EXECUTE FUNCTION keep()`, params: [] });
		await t.db.write({ text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth) VALUES ('p', 'bolt.prune', '{}', '${NOW}', 'continue', 0)`, params: [] });
		await t.runDue();
		expect(await sql(t, `SELECT state, error->>'code' AS code FROM sys_run WHERE automation = 'bolt.prune'`)).toEqual([{ state: 'failed', code: 'noProgress' }]);
		expect(await sql(t, `SELECT count(*)::int AS n FROM sys_event WHERE event = 'prune.noProgress'`)).toEqual([{ n: 1 }]); // the daily pass, inline
	});

	it('an integration pull that reaches MAX_PAGES queues one continuation run at its cursor', async () => {
		const t = await testWorkspace({ manifest, now: NOW });
		const calls: HttpRequest[] = [];
		// a source that always has another page
		const port: HttpPort = { request: async (_c, r) => (calls.push(r), { status: 200, body: { data: [], next: String(Number(r.query?.['next'] ?? 0) + 1) } }) };
		const sync = integrations({ engine: t.engine, http: port, now: () => NOW });
		expect(await sync.run('accounts', 'reconcile', 'r1')).toMatchObject({ continued: String(MAX_PAGES), pruned: 0 });
		expect(calls).toHaveLength(MAX_PAGES);
		expect(await sql(t, `SELECT input FROM sys_run WHERE automation = 'accounts.integration' AND cause = 'continue'`))
			.toEqual([{ input: { mode: 'reconcile', cursor: String(MAX_PAGES) } }]);
		calls.length = 0;
		await sync.handlers()['accounts.integration']!({ mode: 'reconcile', cursor: String(MAX_PAGES) });
		expect(calls[0]!.query).toEqual({ next: String(MAX_PAGES) });
	});
});
