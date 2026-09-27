// P38 on PGlite: every run ends (rule 12: a loop on a cheap facility call ends `crossingBudget`), a drain interrupts
// what it waits on (rule 71a: aborting the generation disposes a guest stuck on a facility that never answers, and the
// run is re-queued as a lost lease), and engine loops prove progress (rule 25a: `bolt.embed` stops `noProgress` when its
// guarded write stores 0 rows; a revision guard writes a row whose `updated_at` has microseconds). Plus the source gate:
// no optimistic guard compares a `*_at` column with a value bound from JS.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type EmbeddingsPort, type EngineManifest } from '../src/engine/contracts.ts';
import { openPglite } from '../src/engine/db/pglite.ts';
import { engine } from '../src/engine/index.ts';
import { embedRun } from '../src/engine/integrations/embed.ts';
import { testWorkspace, type TestWorkspace } from '../src/test/index.ts';
import { loadPack, type Pack } from '../src/engine/write/pack.ts';
import { randomUUID } from 'node:crypto';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: { docs: { description: 'A doc', label: 'title', fields: { title: { kind: 'text' } },
		search: { text: ['title'], semantic: { fields: ['title'], model: 'small', dim: 3 } } } },
	relationships: {},
	collections: { docs: { read: { fields: 'all' }, create: { input: { columns: ['title'] } } } },
	policies: { p: { description: 'P', grants: { docs: { read: true, create: true } }, automations: ['loop', 'hang', 'pair', 'relay'] } },
	automations: { loop: { description: 'Reads forever', runAs: ['p'] }, hang: { description: 'Waits on a call nobody answers', runAs: ['p'] },
		pair: { description: 'Two reads at once', runAs: ['p'] },
		relay: { description: 'A fast branch beside a slow one', runAs: ['p'] } },
	integrations: {}, pipelines: {}, teams: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
} as unknown as EngineManifest;
const guest = { source: `export default { automation: {
	loop: { body: async (_, ctx) => { for (;;) await ctx.web.read('https://a.test'); } },
	hang: { body: async (_, ctx) => { await ctx.web.read('https://never.test'); return 'unreachable'; } },
	pair: { body: async (_, ctx) => { await Promise.all([ctx.web.read('https://a.test'), ctx.web.read('https://b.test')]); } },
	relay: { body: async (_, ctx) => { await Promise.all([ctx.web.read('https://slow.test'), (async () => { await ctx.web.read('https://fast.test'); await ctx.web.read('https://next.test'); })()]); } },
} };` };
const sql = async (t: Pick<TestWorkspace, 'db'>, text: string) => (await t.db.read([{ text, params: [] }]))[0]!.rows;
const queue = (automation: string) => `INSERT INTO sys_run (id, automation, input, due_at, cause, depth)
	VALUES (gen_random_uuid()::text, '${automation}', '{}'::jsonb, '2000-01-01T00:00:00Z', 'start', 0)`;

describe('P38: every run ends, drains interrupt, loops prove progress', () => {
	it('a run looping on a cheap facility call ends with crossingBudget at its 10,001st call (rule 12)', async () => {
		let calls = 0;
		const t = await testWorkspace({ manifest, guest, runs: { facility: async () => (calls++, { ok: true, value: null }) } });
		await t.db.write({ text: queue('loop'), params: [] });
		await t.runDue();
		expect(await sql(t, `SELECT state, error->>'code' AS code FROM sys_run WHERE automation = 'loop'`)).toEqual([{ state: 'failed', code: 'crossingBudget' }]);
		expect(calls).toBe(10_000);
	}, 60_000);

	it('a seed pack loaded into a semantic collection queues the embed pass (a pack writes past the acts that would)', async () => {
		const t = await testWorkspace({ manifest, guest });
		expect(await loadPack(t.db, manifest, { dir: '', meta: {} as Pack['meta'], rows: { docs: [{ id: randomUUID(), title: 'seeded' }] } }, '2026-09-27T00:00:00.000Z')).toBe(true);
		expect(await sql(t, `SELECT automation, state FROM sys_run WHERE automation = 'bolt.embed'`)).toEqual([{ automation: 'bolt.embed', state: 'queued' }]);
	});

	it('facility calls a body issues together run together at the host, not one after the other', async () => {
		let inflight = 0, peak = 0;
		const t = await testWorkspace({ manifest, guest, runs: { facility: async () => {
			peak = Math.max(peak, ++inflight);
			await new Promise((r) => setTimeout(r, 20));
			inflight--;
			return { ok: true, value: null };
		} } });
		await t.db.write({ text: queue('pair'), params: [] });
		await t.runDue();
		expect(await sql(t, `SELECT state FROM sys_run WHERE automation = 'pair'`)).toEqual([{ state: 'succeeded' }]);
		expect(peak).toBe(2);
	});

	it('a branch whose call answered goes on while a sibling still waits: batches land as they finish, not in lockstep', async () => {
		let release!: () => void;
		const next = new Promise<void>((r) => { release = r; });
		const t = await testWorkspace({ manifest, guest, runs: { facility: async (call) => {
			const url = String(call.args[0]);
			if (url.includes('slow')) await next; // answers only once the fast branch made its second call
			if (url.includes('next')) release();
			return { ok: true, value: null };
		} } });
		await t.db.write({ text: queue('relay'), params: [] });
		await t.runDue();
		expect(await sql(t, `SELECT state FROM sys_run WHERE automation = 'relay'`)).toEqual([{ state: 'succeeded' }]);
	});

	it('aborting the generation interrupts a guest stuck on a facility that never answers; the run is re-queued (rule 71a)', async () => {
		const { db } = await openPglite();
		const generation = new AbortController();
		const deadlines = { announce: () => {}, settle: () => {}, teardown: () => {} };
		const e = engine({ manifest, db, guest, console: () => {}, deadlines, scope: 'ws', signal: generation.signal,
			runs: { facility: () => new Promise(() => {}) } });
		await e.migrate({ accept: true });
		await db.write({ text: queue('hang'), params: [] });
		const tick = e.runs!.tick();
		await new Promise((r) => setTimeout(r, 200));
		const started = Date.now();
		generation.abort();
		await tick;
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(await sql({ db }, `SELECT state, error->>'code' AS code FROM sys_run`)).toEqual([{ state: 'running', code: 'interrupted' }]);
		await e.runs!.boot();
		expect(await sql({ db }, `SELECT state, leases FROM sys_run`)).toEqual([{ state: 'queued', leases: 1 }]);
	});

	it('a host call that ignores its signal still ends at its wall; the run does not hang (rule 72)', async () => {
		const t = await testWorkspace({ manifest, guest, runs: { facility: () => new Promise(() => {}) } });
		await t.db.write({ text: queue('hang'), params: [] });
		const started = Date.now();
		await t.runDue();
		expect(Date.now() - started).toBeLessThan(15_000);
		expect(await sql(t, `SELECT state FROM sys_run WHERE automation = 'hang'`)).not.toEqual([{ state: 'running' }]);
	}, 30_000);

	it('bolt.embed stops noProgress after one pass whose guarded write stores 0 rows, and queues nothing (rule 25a)', async () => {
		const t = await testWorkspace({ manifest });
		await t.as(t.admin).act('docs.create', { title: 'desk' });
		const before = await sql(t, `SELECT count(*)::int AS n FROM sys_run WHERE automation = 'bolt.embed'`);
		let passes = 0;
		// a write lands between the read and the guarded write, every time
		const port: EmbeddingsPort = { embed: async (texts) => { passes++; await t.db.write({ text: 'UPDATE docs SET revision = revision + 1', params: [] }); return texts.map(() => [1, 0, 0]); } };
		await expect(embedRun(t.manifest, t.db, port)({})).rejects.toMatchObject({ code: 'noProgress', phase: 'commit' });
		expect(passes).toBe(1);
		expect(await sql(t, `SELECT count(*)::int AS n FROM sys_run WHERE automation = 'bolt.embed'`)).toEqual(before);
	});

	it('a revision guard writes a row whose updated_at has microseconds exactly once (rule 25a)', async () => {
		const t = await testWorkspace({ manifest });
		await t.as(t.admin).act('docs.create', { title: 'desk' });
		await t.db.write({ text: `UPDATE docs SET updated_at = '2026-09-25T10:00:00.123456Z'`, params: [] });
		const port: EmbeddingsPort = { embed: async (texts) => texts.map(() => [1, 0, 0]) };
		expect(await embedRun(t.manifest, t.db, port)({})).toEqual({ embedded: 1 });
		expect(await embedRun(t.manifest, t.db, port)({})).toEqual({ embedded: 0 });
	});

	it('no optimistic guard in the engine compares a *_at column with a value bound from JS (rule 25a)', () => {
		const roots = ['../src', '../../bolt-server/src', '../../ui/src'].map((r) => join(import.meta.dirname, r));
		const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.(ts|svelte)$/.test(f) ? [join(dir, f)] : []);
		// `WHERE|AND|OR <col>_at = | IS NOT DISTINCT FROM <$n | ${…} | v.x>`: compare `revision`, or both sides `::text`
		const guard = /\b(?:WHERE|AND|OR)\s+[\w."]*_at"?\s*(?:=|IS NOT DISTINCT FROM)\s*(?:\$\d|\$\{|[a-z]\.)/i;
		const hits = roots.flatMap(files).flatMap((f) => readFileSync(f, 'utf8').split('\n').flatMap((line, i) => guard.test(line) ? [`${f}:${i + 1}: ${line.trim()}`] : []));
		expect(hits).toEqual([]);
	});
});
