// End to end through the engine entry and the test kit: an approval flow declared in the policy grant (with `match`)
// holds, seals and restores (rules 44–47, §3.8).
import { beforeEach, describe, expect, it } from 'vitest';
import { patched } from '../src/client/bolt.ts';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest, Outcome } from '../src/engine/contracts.ts';
import { lowerRead } from '../src/engine/index.ts';
import { boltHandler } from '../src/protocol/http.ts';
import type { ActReply, Frame } from '../src/protocol/wire.ts';
import { testWorkspace, type TestWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: { orders: { description: 'An order', label: 'title', fields: { title: { kind: 'text' }, note: { kind: 'text', optional: true } } } },
	relationships: {},
	collections: { orders: { read: { fields: 'all' }, create: { input: { columns: ['title', 'note'] } }, update: { input: { columns: ['title', 'note'] } } } },
	policies: {
		sales: { description: 'Sales', grants: { orders: { read: true,
			create: { approval: [{ steps: [['Finance']] }] },
			update: { approval: [{ match: { changed: ['note'] }, steps: [['Finance']] }] } } } },
		finance: { description: 'Finance', grants: { orders: { read: true } } },
	},
	integrations: {}, pipelines: {}, teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
} as unknown as EngineManifest;

let t: TestWorkspace;
beforeEach(async () => { t = await testWorkspace({ manifest }); });
const sales = () => t.engine.authority(t.member(['sales'], { teamPath: ['Sales'] }));
const finance = () => t.engine.authority(t.member(['finance'], { teamPath: ['Finance'] }));
const held = async (id: string) => (await t.db.read([{ text: 'SELECT title, note, approval_id::text AS a FROM orders WHERE id::text = $1', params: [id] }]))[0]!.rows[0];
const request = (o: Outcome) => { if (o.kind !== 'pendingApproval') throw new Error(JSON.stringify(o)); return o.requestId; };
const decide = (requestId: string, status: 'APPROVED' | 'REJECTED') => t.engine.approvals.process({ requestId, status, authority: finance(), now: t.clock.now() });

describe('an approval flow in the policy grant', () => {
	it('a create is held, refused to a non-participant, and sealed by the approver', async () => {
		const requestId = request(await t.as(sales()).act('orders.create', { title: 'desk' }));
		const [{ id }] = (await t.db.read([{ text: 'SELECT id::text AS id FROM orders', params: [] }]))[0]!.rows as [{ id: string }];
		expect(await held(id)).toEqual({ title: 'desk', note: null, a: requestId });
		expect(await t.as(t.member(['sales'], { teamPath: ['Ops'] })).act('orders.update', { target: id, set: { title: 'x' } }))
			.toMatchObject({ kind: 'refused', code: 'approvalHeld' });
		expect(await decide(requestId, 'APPROVED')).toMatchObject({ kind: 'decided' });
		expect(await held(id)).toEqual({ title: 'desk', note: null, a: null });
	});

	it('an update matching the route is held and restored on reject; one not matching commits', async () => {
		const id = (await t.as(t.admin).act('orders.create', { title: 'desk', note: 'a' }) as Extract<Outcome, { kind: 'committed' }>).records[0]!.id;
		expect(await t.as(sales()).act('orders.update', { target: id, set: { title: 'chair' } })).toMatchObject({ kind: 'committed' });
		const requestId = request(await t.as(sales()).act('orders.update', { target: id, set: { note: 'b' } }));
		expect(await held(id)).toEqual({ title: 'chair', note: 'b', a: requestId });
		expect(await decide(requestId, 'REJECTED')).toMatchObject({ kind: 'decided' });
		expect(await held(id)).toEqual({ title: 'chair', note: 'a', a: null });
	});
});

describe('decisions over /__bolt/act reach the live lane (rules 46, 47, 66)', () => {
	const post = (t: TestWorkspace, who: () => ReturnType<typeof sales>, callable: string, input: unknown) => boltHandler({ engine: t.engine, session: async () => who(),
		uuid: () => crypto.randomUUID(), bindings: () => ({ now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} }) })(
		new Request('http://cell/__bolt/act', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
			body: JSON.stringify({ callable, input, issuedAt: t.clock.now() }) })).then(async (r) => ({ status: r!.status, reply: await r!.json() as ActReply }));
	/** A live view of committed orders only, as a sales member reads it. */
	const committedView = async () => {
		const frames: Frame[] = [];
		const conn = t.engine.live.connect(sales(), (f) => frames.push(f), () => {});
		await t.engine.live.register(conn, 'v', { read: lowerRead(t.manifest, 'read', ['orders', { all: true, where: { approval_id: { isNull: true } }, select: { title: true } }]) });
		// the view as the client holds it: its answer with every later patch applied, at the last frame's `v`
		return async () => {
			await t.engine.live.settled();
			return frames.reduce<{ v: number; value: Json | undefined }>((x, f) => f.t === 'answer' ? { v: f.v, value: f.value }
				: f.t === 'patch' ? { v: f.v, value: patched(x.value, f.ops) } : x, { v: 0, value: undefined });
		};
	};

	it('a held create is 202; a non-participant write is 403 approvalHeld { requestId }; the approval seals and the view sees the row', async () => {
		const last = await committedView();
		const held = await post(t, sales, 'orders.create', { title: 'desk' });
		expect(held.status).toBe(202);
		const requestId = request(held.reply.outcome);
		const [{ id }] = (await t.db.read([{ text: 'SELECT id::text AS id FROM orders', params: [] }]))[0]!.rows as [{ id: string }];
		const ops = () => t.engine.authority(t.member(['sales'], { teamPath: ['Ops'] }));
		const refused = await post(t, ops, 'orders.update', { target: id, set: { title: 'x' } });
		expect(refused).toMatchObject({ status: 403, reply: { outcome: { kind: 'refused', code: 'approvalHeld', data: { requestId } } } });
		expect((await last()).value).toEqual({ rows: [], next: null });
		const decided = await post(t, finance, 'approvals.process', { requestId, status: 'APPROVED' });
		expect(decided).toMatchObject({ status: 200, reply: { outcome: { kind: 'committed', output: { requestId, status: 'APPROVED' } } } });
		const frame = await last();
		expect(frame.value).toMatchObject({ rows: [{ title: 'desk' }] });
		expect(frame.v).toBe(decided.reply.v);
	});

	it('a rejection restores and the live view follows; a second decision is 409; withdraw is the requestor\'s', async () => {
		const id = (await t.as(t.admin).act('orders.create', { title: 'desk', note: 'a' }) as Extract<Outcome, { kind: 'committed' }>).records[0]!.id;
		const last = await committedView();
		const requestId = request((await post(t, sales, 'orders.update', { target: id, set: { note: 'b' } })).reply.outcome);
		expect((await last()).value).toEqual({ rows: [], next: null });
		expect((await post(t, finance, 'approvals.process', { requestId, status: 'REJECTED' })).reply.outcome).toMatchObject({ output: { status: 'REJECTED' } });
		expect((await last()).value).toMatchObject({ rows: [{ title: 'desk' }] });
		expect((await post(t, finance, 'approvals.process', { requestId, status: 'APPROVED' })).status).toBe(409);
		const rep = sales();
		const again = request((await post(t, () => rep, 'orders.update', { target: id, set: { note: 'c' } })).reply.outcome);
		expect((await post(t, finance, 'approvals.withdraw', { requestId: again })).reply.outcome).toMatchObject({ code: 'forbidden' });
		expect((await post(t, () => rep, 'approvals.withdraw', { requestId: again })).reply.outcome).toMatchObject({ output: { status: 'WITHDRAWN' } });
		expect(await held(id)).toEqual({ title: 'desk', note: 'a', a: null });
	});

	it('a final decision seals in its own statement and queues nothing; collections.resume stays a once-only fallback', async () => {
		const requestId = request(await t.as(sales()).act('orders.create', { title: 'desk' }));
		expect(await decide(requestId, 'APPROVED')).toMatchObject({ kind: 'decided' });
		expect(await t.engine.approvals.handlers()['collections.resume']!({ requestId })).toEqual({ sealed: false, records: [] });
		expect((await t.db.read([{ text: `SELECT automation, state FROM sys_run WHERE cause = 'approval'`, params: [] }]))[0]!.rows)
			.toEqual([]);
	});
});
