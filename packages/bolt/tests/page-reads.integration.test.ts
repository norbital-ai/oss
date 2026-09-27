// Page reads over `/__bolt/q` as migrated templates make them: a collection query and a named similarity by name, a
// browser `history`, a single-record `get` with its heavy fields, and `sys_user` read by its text id.
import { beforeAll, describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { Authority, EngineManifest } from '../src/engine/contracts.ts';
import { boltHandler } from '../src/protocol/http.ts';
import type { WireRead } from '../src/protocol/wire.ts';
import { testWorkspace, type TestWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		orders: { description: 'An order', label: 'title', fields: {
			title: { kind: 'text' }, doc: { kind: 'json', optional: true }, color: { kind: 'vector', dim: 3, metric: 'l2', optional: true },
			code: { kind: 'seq', pattern: 'O-{0000}' } }, search: { text: ['code', 'title'] } },
	},
	relationships: {},
	collections: {
		orders: {
			read: { fields: 'all' },
			create: { input: { columns: ['title', 'doc', 'color'] } },
			update: { input: { columns: ['title'] } },
			queries: { titled: { description: 'Titles', input: { prefix: { kind: 'text' } }, output: { kind: 'json' } } },
			similarity: { hue: { description: 'Hue', input: { r: { kind: 'number' } }, candidates: 2 } },
		},
	},
	integrations: {}, pipelines: {},
	policies: { rep: { description: 'Rep', grants: { orders: { read: true, create: true, update: true, history: true, queries: ['titled'] } } } },
	teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, customFields: {}, agent: { skills: {} }, apps: {},
} as unknown as EngineManifest;

const guest = { source: `export default { collection: { orders: { bodies: {
	queries: { titled: async (input, ctx) => (await ctx.read('orders', { all: true, orderBy: 'title' })).rows.map((r) => r.title).filter((t) => t.startsWith(input.prefix)) },
	similarity: { hue: {
		probe: (q) => ({ field: 'color', vector: [q.r, 0, 0] }),
		// the exact score: nearest to 0.5 on the first channel, whatever the probe
		rerank: (q, row) => Math.abs(row.color[0] - 0.5),
	} },
} } } };` };

let t: TestWorkspace, rep: Authority;
const ids: string[] = [];
const q = async (reads: WireRead[], who: Authority = rep) => {
	const handle = boltHandler({ engine: t.engine, session: async () => who, uuid: () => crypto.randomUUID(),
		bindings: () => ({ now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} }) });
	const res = (await handle(new Request('http://cell/__bolt/q', { method: 'POST', body: JSON.stringify({ reads }) })))!;
	return { status: res.status, body: await res.json() as { answers: Json[] } & { error?: { code: string; message: string } } };
};

beforeAll(async () => {
	t = await testWorkspace({ manifest, guest });
	rep = t.engine.authority(t.member(['rep']));
	for (const [title, r] of [['alpha', 0.1], ['alder', 0.45], ['beta', 0.9], ['bravo', 0.6]] as const) {
		const o = await t.as(rep).act('orders.create', { title, doc: { lines: [title] }, color: [r, 0, 0] });
		if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
		ids.push(o.records[0]!.id);
	}
	await t.as(rep).act('orders.update', { target: ids[0]!, set: { title: 'alpha 2' } });
	await t.db.write({ text: `INSERT INTO sys_user (id, email, name, kind) VALUES ('ada', 'ada@x.test', 'Ada', 'staff')`, params: [] });
});

describe('/q page reads', () => {
	it('serves a collection query by name as the caller', async () => {
		const r = await q([{ m: 'query', a: ['orders', 'titled', { prefix: 'al' }] }]);
		expect(r.status).toBe(200);
		expect(r.body.answers).toEqual([['alder', 'alpha 2']]);
	});

	it('a query with invalid input is a 400 naming the problem, not a 500', async () => {
		const r = await q([{ m: 'query', a: ['orders', 'titled', {}] }]);
		expect(r.status).toBe(400);
		expect(r.body.error).toMatchObject({ code: 'invalidInput', message: expect.stringContaining('prefix') });
	});

	it('serves a named similarity: probe through the index, rerank by the exact score, nearest first', async () => {
		const r = await q([{ m: 'similar', a: ['orders', 'hue', { r: 0 }, { limit: 1, select: { title: true } }] }]);
		expect(r.status).toBe(200);
		// the index pages 2 candidates nearest r=0 (alpha 2, alder); the rerank keeps the one nearest 0.5
		expect((r.body.answers[0] as { title: string }[]).map((x) => x.title)).toEqual(['alder']);
	});

	it('answers a browser history with no `at` or a null `at`', async () => {
		for (const a of [['orders', ids[0]!], ['orders', ids[0]!, null]] as Json[][]) {
			const r = await q([{ m: 'history', a }]);
			expect(r.status).toBe(200);
			expect((r.body.answers[0] as { revision: number }[]).map((x) => x.revision)).toEqual([1, 2]);
		}
	});

	it('a single-record get carries json, file and custom fields; a list read leaves them out (X-33)', async () => {
		const r = await q([{ m: 'get', a: ['orders', ids[1]!] }, { m: 'read', a: ['orders', { where: { id: { eq: ids[1]! } }, limit: 1 }] }]);
		expect(r.status).toBe(200);
		expect(r.body.answers[0]).toMatchObject({ title: 'alder', doc: { lines: ['alder'] } });
		expect((r.body.answers[1] as { rows: object[] }).rows[0]).not.toHaveProperty('doc');
		// two gets of one shape merge into one statement and keep the same projection
		const two = await q([{ m: 'get', a: ['orders', ids[1]!] }, { m: 'get', a: ['orders', ids[2]!] }]);
		expect(two.body.answers.map((x) => (x as { doc: Json }).doc)).toEqual([{ lines: ['alder'] }, { lines: ['beta'] }]);
	});

	it('text search matches a patterned seq', async () => {
		const r = await q([{ m: 'read', a: ['orders', { search: '0002', limit: 5, select: { title: true, code: true } }] }]);
		expect(r.status).toBe(200);
		expect((r.body.answers[0] as { rows: { title: string; code: string }[] }).rows.map((x) => [x.code, x.title])).toEqual([['O-0002', 'alder']]);
	});

	it('reads sys_user by its text id, filtered and by get', async () => {
		const admin = t.engine.authority(t.admin);
		const r = await q([{ m: 'read', a: ['sys_user', { where: { id: { eq: 'ada' } }, limit: 1, select: { name: true } }] }, { m: 'get', a: ['sys_user', 'ada'] },
			{ m: 'read', a: ['sys_user', { where: { id: { in: ['ada', 'nobody'] } }, limit: 5 }] }], admin);
		expect(r.status).toBe(200);
		expect((r.body.answers[0] as { rows: { name: string }[] }).rows.map((x) => x.name)).toEqual(['Ada']);
		expect(r.body.answers[1]).toMatchObject({ id: 'ada', name: 'Ada' });
		expect((r.body.answers[2] as { rows: object[] }).rows).toHaveLength(1);
	});
});
