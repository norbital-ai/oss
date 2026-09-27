// End to end through `/__bolt/act`, the engine entry and the test kit: a collection action writing two collections in
// one statement, idempotent under its key (rules 31, 33), its commit published to the live lane.
import { describe, expect, it } from 'vitest';
import type { EngineManifest } from '../src/engine/contracts.ts';
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
