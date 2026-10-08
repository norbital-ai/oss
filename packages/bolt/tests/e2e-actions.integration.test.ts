// End to end through `/__bolt/act`, the engine entry and the test kit: a collection action writing two collections in
// one statement, idempotent under its key (rules 31, 33), its commit published to the live lane.
import { describe, expect, it } from 'vitest';
import type { EngineManifest, TenantDb } from '../src/engine/contracts.ts';
import { openPglite } from '../src/engine/db/pglite.ts';
import { boltHandler } from '../src/protocol/http.ts';
import type { ActReply } from '../src/protocol/wire.ts';
import { testWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		orders: { description: 'An order', label: 'title', fields: { title: { kind: 'text' } } },
		notes: { description: 'A note', label: 'text', fields: { text: { kind: 'text' } } },
	},
	relationships: { 'notes.order': { to: 'orders', inverse: 'notes' } },
	collections: {
		orders: { read: { fields: 'all' }, create: { input: { columns: ['title'] } },
			actions: { place: { description: 'Place', input: { title: { kind: 'text' } }, output: { kind: 'text' } } } },
		notes: { read: { fields: 'all' }, create: { input: { columns: ['text', 'order'] } } },
	},
	policies: { rep: { description: 'Rep', grants: { orders: { read: true, create: true, actions: ['place'] }, notes: { read: true, create: true } } } },
	integrations: {}, pipelines: {}, teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
} as unknown as EngineManifest;
const guest = { source: `export default { collection: { orders: { bodies: { actions: {
	place: async (input, ctx) => {
		const id = (await ctx.act('orders.create', { title: input.title })).records[0].id;
		await ctx.act('notes.create', { text: 'placed ' + input.title, order: id });
		return id;
	},
} } } } };` };

describe('a collection action over /__bolt/act', () => {
	it('writes two collections in one statement; the same key replays the outcome and writes nothing', async () => {
		const t = await testWorkspace({ manifest, guest });
		const rep = t.engine.authority(t.member(['rep']));
		const handle = boltHandler({ engine: t.engine, session: async () => rep, uuid: () => crypto.randomUUID(),
			bindings: () => ({ now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} }) });
		const post = async () => (await handle(new Request('http://cell/__bolt/act', { method: 'POST', headers: { 'Idempotency-Key': 'k1' },
			body: JSON.stringify({ callable: 'orders.place', input: { title: 'desk' }, issuedAt: t.clock.now() }) })))!;
		t.count.reset();
		const first = await post();
		expect(first.status).toBe(200);
		const reply = await first.json() as ActReply;
		expect(reply.outcome).toMatchObject({ kind: 'committed' });
		expect(reply.v).toBeGreaterThan(0);
		expect(reply.v).toBe(t.engine.live.v);
		expect(t.count.writes).toBe(1);
		expect(await (await post()).json()).toMatchObject({ outcome: reply.outcome });
		const n = async (c: string) => (await t.db.read([{ text: `SELECT count(*)::int AS n FROM ${c}`, params: [] }]))[0]!.rows[0]!['n'];
		expect([await n('orders'), await n('notes')]).toEqual([1, 1]);
	});
});

describe('a keyed read (`ctx.read({ … })`)', () => {
	const keyed = {
		...manifest,
		models: { ...manifest.models, orders: { description: 'An order', label: 'title', fields: { title: { kind: 'text' }, status: { kind: 'text' } } } },
		collections: { ...manifest.collections, orders: { ...manifest.collections['orders']!, queries: { board: { description: 'Board', output: { kind: 'json' } } } } },
		policies: { rep: { description: 'Rep', grants: { orders: { read: { where: { status: { eq: 'open' } } }, create: true, queries: ['board'] }, notes: { read: true, create: true } } } },
	} as unknown as EngineManifest;
	const board = { source: `export default { collection: { orders: { bodies: { queries: {
		board: async (_, ctx) => {
			const { orders, notes, first } = await ctx.read({
				orders: { collection: 'orders', all: true, select: { title: true } },
				notes: { collection: 'notes', where: { text: { eq: 'b' } }, all: true },
				first: { collection: 'orders', id: ${JSON.stringify('00000000-0000-4000-8000-000000000001')} },
			});
			return { orders: orders.rows.map((r) => r.title).sort(), notes: notes.rows.length, first: first === null ? null : first.title };
		},
	} } } } };` };

	it('reads every member in one round trip and one statement, each under the caller\'s read policy', async () => {
		let statements = 0;
		const inner = (await openPglite()).db;
		const db: TenantDb = { ...inner, read: (s, signal) => (statements += s.length, inner.read(s, signal)) };
		const t = await testWorkspace({ manifest: keyed, guest: board, db });
		const rows = [['00000000-0000-4000-8000-000000000001', 'closed', 'closed'], ['00000000-0000-4000-8000-000000000002', 'open a', 'open'], ['00000000-0000-4000-8000-000000000003', 'open b', 'open']];
		for (const [id, title, status] of rows) await t.db.write({ text: 'INSERT INTO orders (id, title, status) VALUES ($1, $2, $3)', params: [id!, title!, status!] });
		await t.db.write({ text: `INSERT INTO notes (id, text, "order") VALUES ('00000000-0000-4000-8000-000000000009', 'b', '00000000-0000-4000-8000-000000000002')`, params: [] });
		const rep = t.as(t.member(['rep']));
		await rep.query('orders.board');
		t.count.reset();
		const s0 = statements;
		expect(await rep.query('orders.board')).toEqual({ orders: ['open a', 'open b'], notes: 1, first: null });
		expect([t.count.reads, statements - s0]).toEqual([1, 1]);
	});
});

describe('several verbs as one act (`calls.acts`, `ctx.act.many`)', () => {
	it('plans every act at once — one read round trip and statement — and commits them in one statement', async () => {
		let statements = 0;
		const inner = (await openPglite()).db;
		const db: TenantDb = { ...inner, read: (s, signal) => (statements += s.length, inner.read(s, signal)) };
		const t = await testWorkspace({ manifest, guest, db });
		const order = '00000000-0000-4000-8000-0000000000a1';
		await t.db.write({ text: `INSERT INTO orders (id, title) VALUES ('${order}', 'desk')`, params: [] });
		const rep = t.engine.authority(t.member(['rep']));
		t.count.reset();
		const s0 = statements;
		const r = await t.engine.calls.acts({ name: 'probe', key: 'k-acts', issuedAt: t.clock.now(), authority: rep, invocationId: 'k-acts', from: 'server',
			bindings: { now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} },
			acts: [{ collection: 'notes', verb: 'create', input: [{ text: 'a', order }, { text: 'b', order }] }, { collection: 'orders', verb: 'create', input: { title: 'chair' } },
				{ collection: 'notes', verb: 'create', input: { text: 'c', order } }] });
		expect(r.outcome, JSON.stringify(r.outcome)).toMatchObject({ kind: 'committed' });
		expect([t.count.reads, statements - s0, t.count.writes]).toEqual([1, 1, 1]);
		const n = async (c: string) => (await t.db.read([{ text: `SELECT count(*)::int AS n FROM ${c}`, params: [] }]))[0]!.rows[0]!['n'];
		expect([await n('orders'), await n('notes')]).toEqual([2, 3]);
	});
});
