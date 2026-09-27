// The runs area on PGlite (rules 48–56a, 70): the one queue, the deadlines port, buckets, event triggers written in the
// causing statement, re-queues, attempts, the journal, webhooks, visibility, restart recovery.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { Holder } from '../src/engine/access/authority.ts';
import { BoltError, type CrossCall, type EngineManifest, type GuestPort, type Invocation, type Rows, type TenantDb } from '../src/engine/contracts.ts';
import { openPglite } from '../src/engine/db/pglite.ts';
import { engine, type Engine } from '../src/engine/index.ts';
import { runs, type Runs, type RunsConfig } from '../src/engine/runs/index.ts';
import type { Verb } from '../src/engine/write/act.ts';

const base = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: { quotes: { description: 'A quote', label: 'title',
		fields: { title: { kind: 'text' }, status: { kind: 'enum', values: ['draft', 'sent'], default: 'draft' } } } },
	relationships: {},
	collections: { quotes: { read: { fields: 'all' }, create: { input: { columns: ['title', 'status'] } }, update: { input: { columns: ['title', 'status'] } }, delete: {} } },
	integrations: {}, pipelines: {}, teams: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
	policies: { ops: { description: 'Ops', grants: { quotes: { read: true, create: true, update: true, delete: true } }, automations: ['classify'] } },
	automations: {
		remind: { description: 'Remind 3 days after a quote', on: { created: 'quotes', delay: '3d' }, runAs: ['ops'] },
		sent: { description: 'A quote was sent', on: { updated: 'quotes', fields: ['status'], where: { status: { eq: 'sent' } } }, runAs: ['ops'] },
		gone: { description: 'A quote was deleted', on: { deleted: 'quotes' }, runAs: ['ops'] },
		classify: { description: 'Re-queues itself while work is left', runAs: ['ops'] },
		flaky: { description: 'Fails transiently twice', runAs: ['ops'], retry: { attempts: 3, backoff: '1min' } },
		hook: { description: 'A webhook', on: { webhook: '/in', verify: { scheme: 'bearer', secret: 'HOOK' } }, runAs: ['ops'] },
	},
} as unknown as EngineManifest;
const withCron = { ...base, automations: { ...base.automations, digest: { description: 'Daily', on: { cron: '0 6 * * *' }, runAs: ['ops'] } } } as EngineManifest;
const empty = { ...base, automations: {} } as EngineManifest;

const T0 = Date.parse('2026-09-25T09:00:00Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

type Body = (input: Json, ctx: { attempt: string; act(callable: string, input: Json): Promise<Json>;
	schedule(name: string, input: Json, o?: { at?: string | { now: string }; key?: string }): Promise<Json>; notify(notices: Json): Promise<Json> }) => Promise<Json | void>;

/** A guest without an isolate: bodies are plain functions; a throw is a failure the way the prelude reports one. */
function fakeGuest(bodies: { [name: string]: Body }, calls: Invocation[]): GuestPort {
	return {
		async invoke(inv, bridge) {
			calls.push(inv);
			const cross = async (call: CrossCall): Promise<Json> => {
				const [a] = await bridge.cross([call], AbortSignal.timeout(5_000));
				if (!a!.ok) throw a!.error;
				return a!.value;
			};
			try {
				const out = await bodies[inv.target]!(inv.input, { attempt: inv.id,
					act: async (callable, input) => {
						const o = await cross({ op: 'act', callable, input }) as { kind: string };
						if (o.kind !== 'committed') throw o;
						return o as Json;
					},
					schedule: (automation, input, o = {}) => cross({ op: 'schedule', automation, input, ...o } as CrossCall),
					notify: (notices) => cross({ op: 'notify', notices } as CrossCall) });
				return { kind: 'ok', output: out ?? null, cpuMs: 0 };
			} catch (e) {
				return { kind: 'failed', error: new BoltError('guestError', 'guest', e instanceof Error ? e.message : JSON.stringify(e)), cpuMs: 0 };
			}
		},
	};
}

type World = { e: Engine; r: Runs; db: TenantDb; statements: { at: number; text: string }[]; calls: Invocation[]; wakes: number[];
	clock: { ms: number }; act(collection: string, verb: Verb, input: Json): Promise<unknown>; until(ms: number): Promise<void>;
	sql(text: string, params?: Json[]): Promise<Rows['rows']> };

async function world(manifest: EngineManifest, bodies: { [name: string]: Body } = {}, extra: Partial<RunsConfig> = {}): Promise<World> {
	const inner = (await openPglite()).db;
	const clock = { ms: T0 };
	const statements: { at: number; text: string }[] = [];
	const db: TenantDb = {
		read: (s, signal) => (statements.push(...s.map((x) => ({ at: clock.ms, text: x.text }))), inner.read(s, signal)),
		write: (s, lock, signal) => (statements.push({ at: clock.ms, text: s.text }), inner.write(s, lock, signal)),
		transaction: (body, lock) => inner.transaction(body, lock),
	};
	// the host: one next-due instant in memory, woken by `until` (a simulated clock), never polled
	let next: number | null = null;
	const deadlines = {
		announce: (_: string, at: string) => { next = Math.min(next ?? Infinity, Date.parse(at)); },
		settle: (_: string, at: string | null) => { next = at === null ? null : Date.parse(at); },
		teardown: () => { next = null; },
	};
	const e = engine({ manifest, db, deadlines, scope: 'ws', console: () => {} });
	await e.migrate({ accept: true });
	const calls: Invocation[] = [];
	const r = runs({ engine: e, deadlines, scope: 'ws', guest: fakeGuest(bodies, calls), clock: () => clock.ms, env: (n) => n === 'HOOK' ? 'tok' : undefined, ...extra });
	const admin: Holder = { actor: { kind: 'member', id: randomUUID(), email: null, external: false, teams: [], teamPath: [], admin: true, party: null }, policies: [], admin: true };
	const wakes: number[] = [];
	await r.boot();
	statements.length = 0;
	return {
		e, r, db, statements, calls, wakes, clock,
		act: async (collection, verb, input) => (await e.act({ collection, verb, input, key: randomUUID(), issuedAt: iso(clock.ms), authority: e.authority(admin),
			bindings: { now: iso(clock.ms), today: iso(clock.ms).slice(0, 10), tz: 'UTC', params: {} }, invocationId: randomUUID() })).outcome,
		async until(end) {
			while (next !== null && next <= end) {
				clock.ms = Math.max(clock.ms, next);
				next = null;
				wakes.push(clock.ms);
				await r.tick();
			}
			clock.ms = end;
		},
		sql: async (text, params = []) => (await inner.read([{ text, params }]))[0]!.rows,
	};
}
const setNow = (w: World, ms: number) => { w.clock.ms = ms; };

describe('the deadlines port and the idle workspace (rule 52a)', () => {
	it('an idle workspace issues zero statements over a simulated week', async () => {
		const w = await world(empty);
		await w.until(T0 + 7 * DAY);
		expect(w.statements).toEqual([]);
		expect(w.wakes).toEqual([]);
	});

	it('a daily cron wakes once per slot and issues statements only at its slots, pruning included', async () => {
		const w = await world(withCron, { digest: async () => ({ ok: true }) });
		await w.until(T0 + 7 * DAY);
		const slots = Array.from({ length: 7 }, (_, i) => Date.parse('2026-09-26T06:00:00Z') + i * DAY);
		expect(w.wakes).toEqual(slots);
		expect(new Set(w.statements.map((s) => s.at))).toEqual(new Set(slots));
		expect(w.calls).toHaveLength(7);
	});

	it('the daily prune drops aged events, closed rate windows and spent host nonces (rule 56, §5.11.6)', async () => {
		const w = await world(withCron, { digest: async () => ({ ok: true }) });
		const old = iso(T0 - 4 * DAY);
		for (const text of [`INSERT INTO sys_event (at, severity, event, invocation, attributes) VALUES ('${old}', 'info', 'old', 'i', '{}'), ('${iso(T0)}', 'info', 'new', 'i', '{}')`,
			`INSERT INTO bolt_rate VALUES ('act', 'b', '${old}', 1), ('act', 'b', '${iso(T0)}', 1)`,
			`INSERT INTO bolt_host_nonce VALUES ('nonce:a', '${iso(T0 - 3_600_000)}'), ('run:a', '${iso(T0 - 3_600_000)}'), ('run:b', '${iso(T0 - 31 * DAY)}')`])
			await w.db.write({ text, params: [] });
		await w.until(T0 + DAY);
		expect(await w.sql(`SELECT event FROM sys_event WHERE event IN ('old', 'new')`)).toEqual([{ event: 'new' }]);
		expect(await w.sql(`SELECT count(*)::int AS n FROM bolt_rate`)).toEqual([{ n: 1 }]);
		expect(await w.sql(`SELECT key FROM bolt_host_nonce`)).toEqual([{ key: 'run:a' }]);
	});

	it('the daily prune enforces the history horizon of 256 revisions per row (rule 17, L-BOLT-182)', async () => {
		const w = await world(withCron, { digest: async () => ({ ok: true }) });
		await w.db.write({ text: `INSERT INTO bolt_history (collection, record, revision, op, cause) SELECT 'quotes', '00000000-0000-4000-8000-000000000001', g, 'update', 'direct' FROM generate_series(1, 260) g`, params: [] });
		await w.until(T0 + DAY);
		expect(await w.sql(`SELECT count(*)::int AS n, min(revision) AS lo FROM bolt_history WHERE record = '00000000-0000-4000-8000-000000000001'`)).toEqual([{ n: 256, lo: 5 }]);
	});

	it('a restart re-arms from one statement; a run that lost its lease is re-queued at once', async () => {
		const w = await world(base, { classify: async () => {} });
		await w.sql(`INSERT INTO sys_run (id, automation, input, due_at, cause, depth, state, attempts) VALUES ('lost', 'classify', '{}', now(), 'start', 0, 'running', 1)`);
		await w.r.boot();
		expect(w.statements).toHaveLength(1);
		await w.until(T0);
		expect(w.wakes).toEqual([T0]);
		expect(await w.sql(`SELECT state, leases FROM sys_run WHERE id = 'lost'`)).toEqual([{ state: 'succeeded', leases: 1 }]);
	});
});

describe('event triggers (rules 49, 50)', () => {
	it('a created + 3d delay over many rows is written by each causing statement and wakes once per bucket', async () => {
		const w = await world(base, { remind: async (input) => ({ n: (input as { ids: string[] }).ids.length }) });
		// 60 quotes created 09:01:00–09:04:56 share the bucket 3 days after 09:05
		for (let i = 0; i < 60; i++) {
			setNow(w, T0 + 60_000 + i * 4_000);
			const before = w.statements.length;
			expect(await w.act('quotes', 'create', { title: `q${i}` })).toMatchObject({ kind: 'committed' });
			expect(w.statements.length - before).toBe(1);
		}
		expect(await w.sql(`SELECT count(*)::int AS n, count(DISTINCT due_at)::int AS dues, min(due_at)::text AS due FROM sys_run WHERE automation = 'remind'`))
			.toEqual([{ n: 60, dues: 1, due: '2026-09-28 09:05:00+00' }]);
		await w.until(T0 + 4 * DAY);
		expect(w.wakes).toEqual([Date.parse('2026-09-28T09:05:00Z')]);
		expect(w.calls.map((c) => (c.input as { ids: string[] }).ids.length)).toEqual([60]);
	});

	it('without delay the run is due at its exact commit; `where` and `fields` are judged once on the firing write', async () => {
		const w = await world(base, { sent: async () => {}, gone: async () => {}, remind: async () => {} });
		setNow(w, T0 + 17_000);
		const id = ((await w.act('quotes', 'create', { title: 'a' })) as { records: { id: string }[] }).records[0]!.id;
		await w.act('quotes', 'update', { target: id, set: { title: 'b' } });             // status unchanged: no run
		expect(await w.sql(`SELECT count(*)::int AS n FROM sys_run WHERE automation = 'sent'`)).toEqual([{ n: 0 }]);
		setNow(w, T0 + 23_000);
		await w.act('quotes', 'update', { target: id, set: { status: 'sent' } });
		await w.act('quotes', 'delete', { target: id });
		await w.until(T0 + 60_000);
		expect(w.wakes).toEqual([T0 + 23_000]);
		const byName = Object.fromEntries(w.calls.map((c) => [c.target, c.input]));
		expect(byName['sent']).toEqual({ ids: [id] });
		expect(byName['gone']).toMatchObject({ ids: [id], rows: [{ id, title: 'b', status: 'sent' }] });
	});
});

describe('re-queues, attempts and the journal (rules 51, 54, 55, 70)', () => {
	it('a 1-minute re-queue is due at its exact time; the same key replaces; the chain ends by itself', async () => {
		let left = 2;
		const w = await world(base, { classify: async (_, ctx) => {
			if (left-- <= 0) return;
			await ctx.schedule('classify', {}, { at: { now: '+1min' }, key: 'classify_retry' });
			await ctx.schedule('classify', {}, { at: { now: '+1min' }, key: 'classify_retry' });
		} }, { start: ['classify'] });
		await w.r.boot();   // the seed's first admission queued one run; a second boot queues nothing
		await w.until(T0 + DAY);
		expect(w.wakes).toEqual([T0, T0 + 60_000, T0 + 120_000]);
		expect(await w.sql(`SELECT state, count(*)::int AS n FROM sys_run GROUP BY state`)).toEqual([{ state: 'succeeded', n: 3 }]);
	});

	it('only a Transient failure retries, on the same run; each effect happens once', async () => {
		const w = await world(base, { flaky: async (_, ctx) => {
			await ctx.act('quotes.create', { title: 'once' });
			if (!ctx.attempt.endsWith(':3')) throw { kind: 'upstream', message: '502' };
			return 'done';
		} }, { start: ['flaky'] });
		await w.until(T0 + DAY);
		expect(w.wakes).toHaveLength(3);
		expect(await w.sql(`SELECT state, attempts, output, jsonb_array_length(results) AS results FROM sys_run WHERE automation = 'flaky'`))
			.toEqual([{ state: 'succeeded', attempts: 3, output: 'done', results: 3 }]);
		expect(await w.sql(`SELECT count(*)::int AS n FROM quotes WHERE title = 'once'`)).toEqual([{ n: 1 }]);
	});

	it('a notice that names no recipient is refused and writes nothing (L-BOLT-340)', async () => {
		const w = await world(base, { flaky: async (_, ctx) => {
			try { await ctx.notify({ to: [], title: 'nowhere' }); return 'sent'; } catch (e) { return (e as { code: string }).code; }
		} }, { start: ['flaky'] });
		await w.until(T0 + DAY);
		expect(await w.sql(`SELECT state, output FROM sys_run WHERE automation = 'flaky'`)).toEqual([{ state: 'succeeded', output: 'invalidInput' }]);
		expect(await w.sql(`SELECT count(*)::int AS n FROM sys_notification`)).toEqual([{ n: 0 }]);
	});

	it('an inbox notice that reaches no member is not refused; the attempt reports it (L-BOLT-340, rule 21)', async () => {
		const w = await world(base, { flaky: async (_, ctx) => { await ctx.notify({ to: { team: 'nobody' }, title: 'unheard' }); return 'sent'; } }, { start: ['flaky'] });
		await w.until(T0 + DAY);
		expect(await w.sql(`SELECT state, output, results->0->'warnings' AS warnings FROM sys_run WHERE automation = 'flaky'`))
			.toEqual([{ state: 'succeeded', output: 'sent', warnings: [`notify: 'unheard' reached no member`] }]);
		expect(await w.sql(`SELECT count(*)::int AS n FROM sys_notification`)).toEqual([{ n: 0 }]);
	});

	it('a refusal or a bug is never retried', async () => {
		const w = await world(base, { flaky: async () => { throw new Error('bug'); } }, { start: ['flaky'] });
		await w.until(T0 + DAY);
		expect(await w.sql(`SELECT state, attempts, error->>'code' AS code FROM sys_run`)).toEqual([{ state: 'failed', attempts: 1, code: 'guestError' }]);
	});
});

describe('webhooks and visibility (rules 56, 56a)', () => {
	it('verifies before reading, dedupes deliveries, and acknowledges after the run row commits', async () => {
		const w = await world(base, { hook: async (input) => input });
		const body = new TextEncoder().encode('{"order":1}');
		expect(await w.r.webhook('/in', { method: 'POST', headers: { authorization: 'Bearer nope' }, body })).toEqual({ status: 401 });
		expect(w.statements).toEqual([]);
		const ok = { method: 'POST', headers: { authorization: 'Bearer tok' }, body };
		expect(await w.r.webhook('/in', ok)).toEqual({ status: 200 });
		expect(await w.r.webhook('/in', ok)).toEqual({ status: 200 });
		expect(await w.r.webhook('/in', { ...ok, body: new TextEncoder().encode('not json') })).toEqual({ status: 400 });
		await w.until(T0);
		expect(w.calls.map((c) => c.input)).toEqual([{ order: 1 }]);
		expect(await w.sql(`SELECT state, count(*)::int AS n FROM sys_run GROUP BY state ORDER BY state`))
			.toEqual([{ state: 'failed', n: 1 }, { state: 'succeeded', n: 1 }]);
	});

	it('a run is readable in full by automations holders and admins; the causing actor sees status and error code only', async () => {
		const w = await world(base, { sent: async () => { throw new Error('secret detail'); } });
		const member: Holder = { actor: { kind: 'member', id: randomUUID(), email: null, external: false, teams: [], teamPath: [], admin: false, party: null },
			policies: ['ops'], admin: false };
		const id = ((await w.e.act({ collection: 'quotes', verb: 'create', input: { title: 'x', status: 'draft' }, key: randomUUID(), issuedAt: iso(T0),
			authority: w.e.authority(member), bindings: { now: iso(T0), today: '2026-09-25', tz: 'UTC', params: {} }, invocationId: randomUUID() })).outcome as unknown as { records: { id: string }[] }).records[0]!.id;
		await w.e.act({ collection: 'quotes', verb: 'update', input: { target: id, set: { status: 'sent' } }, key: randomUUID(), issuedAt: iso(T0),
			authority: w.e.authority(member), bindings: { now: iso(T0), today: '2026-09-25', tz: 'UTC', params: {} }, invocationId: randomUUID() });
		await w.until(T0);
		const [run] = await w.sql(`SELECT id FROM sys_run WHERE automation = 'sent'`);
		const runId = String(run!['id']);
		expect(await w.r.view(w.e.authority(member), runId)).toEqual(expect.objectContaining({ status: 'failed', error: { code: 'guestError' } }));
		expect(await w.r.view(w.e.authority(member), runId)).not.toHaveProperty('input');
		const other = w.e.authority({ ...member, actor: { ...member.actor, id: randomUUID() } as Holder['actor'] });
		expect(await w.r.view(other, runId)).toBeNull();
		const admin = w.e.authority({ ...member, admin: true });
		expect(await w.r.view(admin, runId)).toMatchObject({ error: { code: 'guestError', message: 'secret detail' }, input: { ids: [id] } });
	});
});

describe('lanes: a long automation never holds an agent.triage decision (rules 48, 51)', () => {
	const queue = (w: World, id: string, automation: string, due: number) => w.db.write({ text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth)
		VALUES ($1, $2, '{"conversation":"c","waits":0}'::jsonb, $3::timestamptz, 'schedule', 0)`, params: [id, automation, iso(due)] });
	const states = (w: World) => w.sql(`SELECT automation, state FROM sys_run WHERE automation IN ('classify', 'agent.triage') ORDER BY automation`);
	/** `classify` holds until `agent.triage` has run: run one after the other, the wake never ends (the test times out). */
	const gated = () => {
		let release!: () => void;
		const released = new Promise<void>((r) => { release = r; });
		return { released, platform: { 'agent.triage': async () => { release(); return { decided: true }; } } };
	};

	it('a triage due with a long automation completes while the automation still runs', async () => {
		const g = gated();
		const w = await world(base, { classify: async () => { await g.released; return { done: true }; } }, { platform: g.platform });
		await queue(w, randomUUID(), 'classify', T0 - 1_000); // claimed first
		await queue(w, randomUUID(), 'agent.triage', T0);
		await w.r.tick();
		expect(await states(w)).toEqual([{ automation: 'agent.triage', state: 'succeeded' }, { automation: 'classify', state: 'succeeded' }]);
	});

	it('workspace automations due together run one after the other, never side by side (no revision conflict between them)', async () => {
		const order: string[] = [];
		const body = (name: string) => async () => { order.push(`${name}:start`); await new Promise((r) => setTimeout(r, 5)); order.push(`${name}:end`); return { done: true }; };
		const w = await world(base, { classify: body('a'), flaky: body('b') });
		await queue(w, randomUUID(), 'classify', T0 - 1_000);
		await queue(w, randomUUID(), 'flaky', T0 - 1_000);
		await w.r.tick();
		expect(order).toEqual(order[0] === 'a:start' ? ['a:start', 'a:end', 'b:start', 'b:end'] : ['b:start', 'b:end', 'a:start', 'a:end']);
	});

	it('a triage queued while the long automation runs is claimed by the open wake', async () => {
		const g = gated();
		const w: World = await world(base, { classify: async () => {
			await queue(w, randomUUID(), 'agent.triage', w.clock.ms);
			w.r.nudge(iso(w.clock.ms));
			await g.released;
			return { done: true };
		} }, { platform: g.platform });
		await queue(w, randomUUID(), 'classify', T0);
		await w.r.tick();
		expect(await states(w)).toEqual([{ automation: 'agent.triage', state: 'succeeded' }, { automation: 'classify', state: 'succeeded' }]);
	});
});
