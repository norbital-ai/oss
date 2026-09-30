// The browser path end to end on PGlite: $bolt → fetch → the /__bolt handler → engine → live hub → SSE → $bolt.
// One guarantee per test (rules 25, 32, 64–67).
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import { createBolt, patched, type Bolt } from '../src/client/bolt.ts';
import type { EventSourceLike } from '../src/client/stream.ts';
import type { Authority, Captured, Outcome, ReadIR, TenantDb } from '../src/engine/contracts.ts';
import { openPglite } from '../src/engine/db/pglite.ts';
import { postgresDb, type PgPool } from '../src/engine/db/postgres.ts';
import { engine, lowerRead, type Engine } from '../src/engine/index.ts';
import type { Frame } from '../src/protocol/wire.ts';
import { seed as restore } from '../src/engine/write/seed.ts';
import { Chain, noticeCaptures, noticeInsert } from '../src/engine/write/sql.ts';
import { boltHandler } from '../src/protocol/http.ts';
import { ACME, guest, manifest, seed, SHADY } from './engine-fixture.ts';

const NOW = '2026-09-25T10:00:00.000Z';
const bindings = () => ({ now: NOW, today: NOW.slice(0, 10), tz: 'UTC', params: {} });
type Row = { readonly [f: string]: Json };

let e: Engine, bolt: Bolt, rep: Authority;
/** Statements the engine's database answered: the hub's re-reads show here, and nowhere else between a publish and its routing. */
let reads = 0;
/** The cell under test over `base`, its reads counted. */
async function cell(base: TenantDb): Promise<void> {
	const db: TenantDb = new Proxy(base, { get: (t, k) => k === 'read' ? (s: Parameters<TenantDb['read']>[0], signal?: AbortSignal) => { reads += s.length; return t.read(s, signal); } : Reflect.get(t, k) });
	e = engine({ manifest, db, guest, transforms: ['orders'], console: () => {},
		approval: { participant: () => true, route: () => ({ requestId: randomUUID() }) }, clock: () => NOW });
	await e.migrate({ accept: true });
	await restore(manifest, db, seed, NOW);
}
beforeEach(async () => {
	await cell((await openPglite()).db);
	rep = e.authority({ actor: { kind: 'member', id: randomUUID(), email: null, phone: null, external: false, teams: [], teamPath: [], admin: false, party: null }, policies: ['rep'], admin: false });
	const handle = boltHandler({ engine: e, session: async () => rep, bindings, uuid: randomUUID });
	const fetch = async (url: string | URL | Request, init?: RequestInit) => await handle(new Request(`http://cell${String(url)}`, init)) ?? new Response(null, { status: 404 });
	bolt = createBolt({ actor: null, locale: 'en', now: () => NOW, fetch: fetch as typeof globalThis.fetch, openStream: (url) => sse(fetch, url) });
});

/** A test EventSource over the handler's SSE body. */
function sse(fetch: (url: string) => Promise<Response>, url: string): EventSourceLike {
	const source: EventSourceLike = { onmessage: null, onerror: null, close: () => void reader?.cancel() };
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	void (async () => {
		reader = (await fetch(url)).body!.getReader();
		const text = new TextDecoder();
		let buffer = '';
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return;
			buffer += text.decode(value, { stream: true });
			for (let i = buffer.indexOf('\n\n'); i >= 0; i = buffer.indexOf('\n\n')) {
				const data = buffer.slice(0, i).split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
				buffer = buffer.slice(i + 2);
				if (data !== '') source.onmessage?.(new MessageEvent('message', { data }));
			}
		}
	})();
	return source;
}
const until = async (ok: () => boolean) => {
	for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
	expect(ok()).toBe(true);
};
/** A live read of every order the rep sees, and every value it rendered. */
async function orders() {
	const view = bolt.live(bolt.read('orders', { all: true }));
	const seen: (readonly Row[])[] = [];
	view.subscribe((v) => { if (v !== undefined) seen.push((v as { rows: Row[] }).rows); });
	await until(() => view.current !== undefined);
	return { seen, rows: () => (view.current as { rows: readonly Row[] }).rows };
}
const kind = (o: Outcome) => o.kind;

describe('live + protocol + $bolt on PGlite', () => {
	it('an act resolves only once its committed row is on the live read (rule 66)', async () => {
		const view = await orders();
		expect(kind(await bolt.act('orders.create', { title: 'desk', region: 'north', customer: ACME }))).toBe('committed');
		expect(view.rows().map((r) => r['title'])).toEqual(['desk']);
		expect(view.rows()[0]!['id']).not.toMatch(/^pending:/);
	});

	it('a refused optimistic write painted while in flight and leaves no painted row (rule 67)', async () => {
		const view = await orders();
		const o = await bolt.act('orders.create', { title: 'shady', region: 'north', customer: SHADY });
		expect(o).toMatchObject({ kind: 'refused', message: 'Shady is blocked', field: 'customer' });
		expect(view.seen.some((rows) => rows.some((r) => r['title'] === 'shady'))).toBe(true);
		expect(view.rows()).toEqual([]);
	});

	it('a 202 leaves the held row on the page (rule 67)', async () => {
		const view = await orders();
		// the rep's create grant now routes to approval (§3.8)
		const grant = rep.collections['orders']!;
		rep = { ...rep, collections: { ...rep.collections, orders: { ...grant, create: grant.create.map((a) => ({ ...a, approval: [{ steps: [['finance']] }] })) } } };
		expect(kind(await bolt.act('orders.create', { title: 'held', region: 'north', customer: ACME }))).toBe('pendingApproval');
		expect(view.rows().map((r) => r['title'])).toEqual(['held']);
	});

	it('an update carries the revision the page read; a row that moved since is conflict and the paint lifts (rule 25)', async () => {
		const view = await orders();
		await bolt.act('orders.create', { title: 'desk', region: 'north', customer: ACME });
		const id = String(view.rows()[0]!['id']);
		// another cell's writer moves the row: this cell's live lane never sees it
		const moved = await engine({ manifest, db: e.db, console: () => {} }).act({ collection: 'orders', verb: 'update', input: { target: id, set: { title: 'moved' } }, key: randomUUID(), issuedAt: NOW,
			authority: rep, bindings: bindings(), invocationId: randomUUID() });
		expect(kind(moved.outcome)).toBe('committed');
		expect(kind(await bolt.act('orders.update', { target: id, set: { title: 'mine' } }))).toBe('conflict');
		expect(view.rows()[0]!['title']).toBe('desk');
	});

	it('await q reads once through /q', async () => {
		await bolt.act('orders.create', { title: 'desk', region: 'north', customer: ACME });
		const page = await bolt.read<{ rows: Row[] }>('orders', { all: true });
		expect(await bolt.get('orders', String(page.rows[0]!['id']))).toMatchObject({ title: 'desk' });
		await expect(bolt.read('nope', { all: true })).rejects.toMatchObject({ code: expect.any(String) });
	});
});

describe('live deltas on PGlite (rule 65)', () => {
	const b = () => bindings();
	/** A connection whose views are kept by applying every frame, as `$bolt` does. */
	function watcher(authority: Authority) {
		const held = new Map<string, Json | undefined>();
		const frames: Frame[] = [];
		const conn = e.live.connect(authority, (f) => {
			frames.push(f);
			if (f.t === 'answer') held.set(f.view, f.value);
			if (f.t === 'patch') held.set(f.view, patched(held.get(f.view), f.ops));
		}, () => {});
		return { conn, held, frames };
	}
	const write = async (a: Authority, verb: 'create' | 'update' | 'delete', input: Json) => {
		const r = await e.act({ collection: 'orders', verb, input, key: randomUUID(), issuedAt: NOW, authority: a, bindings: b(), invocationId: randomUUID() });
		expect(r.outcome.kind).toBe('committed');
		await e.live.settled();
		return r.outcome.kind === 'committed' ? r.outcome.records.map((x) => x.id) : [];
	};

	it('a commit that hits a simple view is patched with 0 view reads', async () => {
		const w = watcher(rep);
		await e.live.register(w.conn, 'simple', { read: lowerRead(manifest, 'read', ['orders', { select: { title: true, status: true }, all: true }]) });
		// another cell's writer commits; its RETURNING set is then routed through this hub alone
		const other = engine({ manifest, db: e.db, guest, transforms: ['orders'], console: () => {} });
		const r = await other.act({ collection: 'orders', verb: 'create', input: { title: 'desk', region: 'north', customer: ACME }, key: randomUUID(), issuedAt: NOW,
			authority: rep, bindings: b(), invocationId: randomUUID() });
		reads = 0;
		e.live.publish(r.captured);
		await e.live.settled();
		expect(reads).toBe(0);
		expect(w.frames.at(-2)).toMatchObject({ t: 'patch', view: 'simple' });
		expect(w.held.get('simple')).toEqual((await e.read([lowerRead(manifest, 'read', ['orders', { select: { title: true, status: true }, all: true }])], { as: 'caller', authority: rep }, b()))[0]);
	});

	it('the inbox is a live read: a new notice and a read_at change are patched with 0 view reads (L-BOLT-354)', async () => {
		const me = (rep.actor as { id: string }).id;
		await e.db.write({ text: `INSERT INTO sys_user (id, email, name) VALUES ($1, 'rep@acme.test', 'rep')`, params: [me] });
		const w = watcher(rep);
		const inbox: ReadIR = { kind: 'inbox', collection: 'sys_notification', member: me };
		await e.live.register(w.conn, 'inbox', { read: inbox });
		const fresh = async () => (await e.read([inbox], { as: 'caller', authority: rep }, b()))[0];
		expect(w.held.get('inbox')).toEqual({ rows: [] });
		// the one writer (L-BOLT-356) hands its inserted rows to the lane, as every writer's statement does
		const c = new Chain();
		noticeInsert(c, 'n', [{ id: 'n1', to: { user: me }, title: 'To you' }, { id: 'n2', to: { team: 'nobody' }, title: 'Nobody' }], NOW, manifest.teams, 'true');
		reads = 0;
		e.live.publish((await e.db.write(c.sql(`${noticeCaptures(c)} AS notices`))).rows[0]!['notices'] as unknown as Captured[]);
		await e.live.settled();
		expect(reads).toBe(0);
		expect(w.frames.at(-2)).toMatchObject({ t: 'patch', view: 'inbox' });
		expect((w.held.get('inbox') as { rows: Row[] }).rows).toMatchObject([{ id: `n1:${me}`, title: 'To you', read: false }]);
		expect(w.held.get('inbox')).toEqual(await fresh());
		// markRead publishes the member's changed rows: `read` flips without a reload
		expect(kind(await bolt.act('sys_notification.markRead', { ids: [`n1:${me}`] }))).toBe('committed');
		await e.live.settled();
		expect((w.held.get('inbox') as { rows: Row[] }).rows).toMatchObject([{ id: `n1:${me}`, read: true }]);
		expect(w.held.get('inbox')).toEqual(await fresh());
	});

	it('a decimal and a roll-up sum keep their scale in the patch, with 0 reads (numerics cross the RETURNING image as text)', async () => {
		const w = watcher(rep);
		const totals = lowerRead(manifest, 'read', ['orders', { select: { title: true, total: true }, all: true }]);
		await e.live.register(w.conn, 'totals', { read: totals });
		const other = engine({ manifest, db: e.db, guest, transforms: ['orders'], console: () => {} });
		const r = await other.act({ collection: 'orders', verb: 'create', input: { title: 'desk', region: 'north', customer: ACME,
			lines: { create: [{ label: 'a', amount: '1.20' }, { label: 'b', amount: '2.00' }] } }, key: randomUUID(), issuedAt: NOW,
			authority: rep, bindings: b(), invocationId: randomUUID() });
		expect(r.captured.find((x) => x.collection === 'lines')?.new?.['amount']).toBe('1.20');
		reads = 0;
		e.live.publish(r.captured);
		await e.live.settled();
		expect(reads).toBe(0);
		expect((w.held.get('totals') as { rows: Row[] }).rows.map((x) => x['total'])).toEqual([{ $dec: '3.20' }]);
		expect(w.held.get('totals')).toEqual((await e.read([totals], { as: 'caller', authority: rep }, b()))[0]);
	});

	/** Every view shape stays equal to a fresh read through creates, moves, masks, filters and deletes. */
	async function shapes() {
		const both = e.authority({ actor: rep.actor, policies: ['rep', 'auditor'], admin: false });
		const w = watcher(both);
		const shapes: { [view: string]: Json } = {
			newest: ['orders', { select: { title: true, note: true, status: true, created_at: true }, orderBy: { created_at: 'desc' }, all: true }],
			drafts: ['orders', { where: { status: { eq: 'draft' } }, select: { title: true, note: true }, limit: 2 }],
			whole: ['orders', { all: true }],
			related: ['orders', { select: { title: true, customer: { select: { name: true } } }, all: true }],
			byTitle: ['orders', { select: { title: true }, orderBy: { title: 'asc' }, limit: 10 }],
		};
		const irs: { [view: string]: ReadIR } = Object.fromEntries(Object.entries(shapes).map(([k, a]) => [k, lowerRead(manifest, 'read', a as Json[])]));
		for (const [view, read] of Object.entries(irs)) await e.live.register(w.conn, view, { read });
		const check = async () => {
			for (const [view, read] of Object.entries(irs)) expect([view, w.held.get(view)]).toEqual([view, (await e.read([read], { as: 'caller', authority: both }, b()))[0]]);
		};
		const a = (await write(both, 'create', { title: 'desk', region: 'north', customer: ACME }))[0]!;
		const c = (await write(both, 'create', { title: 'chair', region: 'north', note: 'mine', customer: ACME }))[0]!;
		await write(both, 'create', { title: 'lamp', region: 'north', customer: ACME });
		await check();
		await write(both, 'update', { target: a, set: { title: 'bench' } });
		await check();
		await write(both, 'update', { target: c, set: { status: 'submitted' } });
		await check();
		await write(both, 'update', { target: c, set: { note: 'edited' } });
		await check();
		await write(both, 'delete', { target: a });
		await check();
		// then a seeded random walk: every commit, whatever it does, leaves every view equal to a fresh read
		let seed = 7;
		const pick = <T>(xs: readonly T[]): T => xs[(seed = (seed * 48_271) % 2_147_483_647) % xs.length]!;
		for (let i = 0; i < 16; i++) {
			const ids = ((await e.read([irs['whole']!], { as: 'caller', authority: both }, b()))[0] as { rows: { id: string }[] }).rows.map((r) => r.id);
			const input: Json = ids.length === 0 || pick([0, 1, 2]) === 0 ? { title: pick(['oak', 'Ash', 'elm', 'fir']), region: 'north', customer: ACME }
				: pick([{ target: pick(ids), set: { title: pick(['yew', 'Box', 'ash']) } }, { target: pick(ids), set: { status: 'submitted' } }, { target: pick(ids), set: { note: pick(['n1', 'n2']) } }, { target: pick(ids) }]);
			const verb = 'set' in (input as object) ? 'update' : 'target' in (input as object) ? 'delete' : 'create';
			await e.act({ collection: 'orders', verb, input, key: randomUUID(), issuedAt: NOW, authority: both, bindings: b(), invocationId: randomUUID() });
			await e.live.settled();
			await check();
		}
		const patchedViews = new Set(w.frames.flatMap((f) => f.t === 'patch' ? [f.view] : []));
		expect([...patchedViews].sort()).toEqual(['byTitle', 'drafts', 'newest', 'related', 'whole']);
	}
	it('every view shape stays equal to a fresh read (PGlite)', shapes);

	const url = process.env['BOLT_TEST_PG'];
	it.skipIf(url === undefined)('every view shape stays equal to a fresh read (Postgres, BOLT_TEST_PG)', async () => {
		// bolt names no Postgres driver; the host's (bolt-server's) is borrowed for this spec
		const pg = createRequire(new URL('../../bolt-server/package.json', import.meta.url))('pg') as {
			Pool: new (o: { connectionString: string; max?: number; options?: string }) => PgPool & { query(t: string): Promise<unknown>; end(): Promise<void>; on(e: 'error', f: () => void): void } };
		const name = `bolt_live_${process.pid}_${Date.now()}`, admin = new pg.Pool({ connectionString: url!, max: 1 });
		await admin.query(`create database ${name}`);
		const target = new URL(url!);
		target.pathname = `/${name}`;
		const pool = new pg.Pool({ connectionString: target.toString(), max: 4, options: '-c TimeZone=UTC' });
		pool.on('error', () => {});
		try {
			await cell(postgresDb(pool));
			await shapes();
		} finally {
			await pool.end();
			await admin.query(`drop database if exists ${name} with (force)`);
			await admin.end();
		}
	}, 60_000);

	it('the agent transcript takes each written message as a patch, with no re-read', async () => {
		const id = await e.agents.start({ owner: rep.actor.kind === 'member' ? rep.actor.id : null });
		const w = watcher(rep);
		await e.live.register(w.conn, 't', { read: { kind: 'transcript', collection: 'sys_message', conversation: id, thread: false } });
		expect(w.held.get('t')).toEqual({ rows: [] });
		reads = 0;
		const row = await e.agents.post({ conversation: id, as: { member: 'someone' }, text: 'hello', author: 'Ann' });
		await e.live.settled();
		await e.agents.stop(id); // cancels the queued input: it leaves the transcript
		await e.live.settled();
		expect(reads).toBe(0);
		expect(w.frames.filter((f) => f.t === 'patch').map((f) => (f as Extract<Frame, { t: 'patch' }>).ops)).toEqual([
			[{ op: 'upsert', index: 0, row: expect.objectContaining({ id: row.id, role: 'user', text: 'hello', state: 'queued', author: 'Ann' }) }],
			[{ op: 'remove', id: row.id }]]);
		expect(w.held.get('t')).toEqual({ rows: [] });
	});

	it('a transcript window `from` a seq holds only the messages from it on; older ones are read by page', async () => {
		const id = await e.agents.start({ owner: rep.actor.kind === 'member' ? rep.actor.id : null });
		const a = await e.agents.post({ conversation: id, as: { member: 'someone' }, text: 'first', author: 'Ann' });
		const seqA = Number((await e.agents.transcript(id)).find((r) => r.id === a.id)!.seq);
		const w = watcher(rep);
		await e.live.register(w.conn, 'w', { read: { kind: 'transcript', collection: 'sys_message', conversation: id, thread: false, from: seqA + 1 } });
		expect(w.held.get('w')).toEqual({ rows: [], from: seqA + 1 });
		const b = await e.agents.post({ conversation: id, as: { member: 'someone' }, text: 'second', author: 'Ann' });
		await e.live.settled();
		expect(((w.held.get('w') as { rows: { id: string }[] }).rows).map((r) => r.id)).toEqual([b.id]);
		const seqB = Number((await e.agents.transcript(id)).find((r) => r.id === b.id)!.seq);
		expect((await e.agents.transcript(id, { before: seqB, limit: 1 })).map((r) => r.id)).toEqual([a.id]);
		await e.agents.stop(id);
	});
});
