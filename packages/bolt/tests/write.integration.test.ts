// engine/write on PGlite: one guarantee per test (rules 19–29, 34, 40–43, 45 hook, 70).
import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { GuestOutcome, Invocation, Outcome, TenantDb } from '../src/engine/contracts.ts';
import { openPglite } from '../src/engine/db/pglite.ts';
import { applyPlan, plan, schemaSlice } from '../src/engine/schema/plan.ts';
import { catalogOf, toPred } from '../src/engine/access/pred.ts';
import { act, type ActRequest, type WriteEngine } from '../src/engine/write/act.ts';
import { compileCommit } from '../src/engine/write/commit.ts';
import { seed } from '../src/engine/write/seed.ts';
import { admin, arm, authority, grants, manifest, NOW, TODAY } from './write-fixture.ts';

let pg: PGlite, db: TenantDb;
const count = { reads: 0, writes: 0 };
let n = 0;
beforeEach(async () => {
	({ pg, db: db } = await openPglite());
	await applyPlan(db, plan(null, manifest), { accept: true });
	const inner = db;
	db = { read: (s) => (count.reads++, inner.read(s)), write: (s, l) => (count.writes++, inner.write(s, l)), transaction: (b, l) => inner.transaction(b, l) };
	count.reads = 0; count.writes = 0;
});

type Over = Partial<ActRequest> & Pick<ActRequest, 'verb' | 'input'>;
const run = (over: Over, engine: Partial<WriteEngine> = {}) => act({ manifest, db, ...engine },
	{ collection: 'orders', key: `key-${n}`, issuedAt: NOW, authority: admin, bindings: { now: NOW, today: TODAY, tz: 'UTC', params: {} }, invocationId: `inv-${n++}`, ...over });
const rows = async (sql: string) => (await pg.query<Record<string, Json>>(sql)).rows;
const one = async (sql: string) => (await rows(sql))[0]!;
const committed = (o: Outcome) => { if (o.kind !== 'committed' && o.kind !== 'pendingApproval') throw new Error(JSON.stringify(o)); return o; };
const order = async (title = 'desk', lines: { label: string; amount: string }[] = []) => {
	const o = committed((await run({ verb: 'create', input: { title, lines: { create: lines } } })).outcome);
	return o.records.find((r) => r.collection === 'orders')!.id;
};

describe('engine/write: one statement per act (rule 20)', () => {
	it('a plain create commits in one write statement with its seq, roll-ups and history', async () => {
		const { outcome, captured } = await run({ verb: 'create', input: { title: 'desk', lines: { create: [{ label: 'a', amount: '40' }, { label: 'b', amount: '110.50' }] } } });
		expect(count).toEqual({ reads: 0, writes: 1 });
		expect(committed(outcome).records).toHaveLength(3);
		expect(await one(`select number, total::text, big_lines, revision from orders`)).toEqual({ number: 'PO-2026-0001', total: '150.50', big_lines: 1, revision: 1 });
		expect(Number((await one(`select count(*) from bolt_history where cause = 'direct'`))['count'])).toBe(3);
		expect(captured.map((c) => c.op)).toEqual(['create', 'create', 'create']);
	});

	it('an unmarked replay writes nothing and returns the first outcome byte for byte; a new body is keyReuse (rule 31)', async () => {
		const first = await run({ verb: 'create', input: { title: 'desk' }, key: 'same', invocationId: 'a' });
		const again = await run({ verb: 'create', input: { title: 'desk' }, key: 'same', invocationId: 'b' });
		expect(JSON.stringify(again.outcome)).toBe(JSON.stringify(first.outcome));
		expect(again.captured).toEqual([]);
		expect(await one(`select count(*)::int n from orders`)).toEqual({ n: 1 });
		expect(await one(`select value from bolt_seq`)).toEqual({ value: 1 });
		const marked = await run({ verb: 'create', input: { title: 'desk' }, key: 'same', retry: true });
		expect(JSON.stringify(marked.outcome)).toBe(JSON.stringify(first.outcome));
		expect((await run({ verb: 'create', input: { title: 'chair' }, key: 'same' })).outcome).toMatchObject({ kind: 'refused', code: 'keyReuse' });
	});

	it('a Postgres refusal is one failed commit plus one outcome record, and a replay answers it', async () => {
		await order('desk');
		count.writes = 0;
		const refused = await run({ verb: 'create', input: { title: 'desk' }, key: 'dup' });
		expect(refused.outcome).toMatchObject({ kind: 'refused', code: 'unique' });
		expect(count.writes).toBe(2);
		const replay = await run({ verb: 'create', input: { title: 'desk' }, key: 'dup', retry: true });
		expect(JSON.stringify(replay.outcome)).toBe(JSON.stringify(refused.outcome));
	});

	it('a refusal before guest code writes nothing (decode, rule 36)', async () => {
		count.writes = 0;
		expect((await run({ verb: 'create', input: { title: 'x', total: '9' } })).outcome).toMatchObject({ kind: 'refused', code: 'invalidInput', field: 'total' });
		expect((await run({ collection: 'lines', verb: 'create', input: { label: 'a', amount: '1', order: '0199a000-0000-7000-8000-0000000000ff' } })).outcome)
			.toMatchObject({ kind: 'refused', code: 'notFound', field: 'order' });
		expect(count.writes).toBe(0);
	});

	it('rateLimited at the commit re-check is a failed commit and is never recorded (rule 38)', async () => {
		const rate = [{ rule: 'act', bucket: 'a', limit: 1, windowStart: NOW }];
		committed((await run({ verb: 'create', input: { title: 'a' }, rate })).outcome);
		expect((await run({ verb: 'create', input: { title: 'b' }, rate, key: 'r2' })).outcome).toMatchObject({ kind: 'refused', code: 'rateLimited' });
		expect(await rows(`select 1 from bolt_idem_outcome o join bolt_idem i using (key) where i.key <> ''`)).toHaveLength(1);
	});
});

describe('engine/write: rows (rules 21, 22, 25, 29, 43)', () => {
	it('a child change moves its parent roll-up in one derived write; nothing is deleted by omission', async () => {
		const id = await order('desk', [{ label: 'a', amount: '40' }, { label: 'b', amount: '60' }]);
		const [a] = await rows(`select id::text from lines order by label`);
		committed((await run({ verb: 'update', input: { target: id, set: { note: 'n', lines: {} } } })).outcome);
		expect(await one(`select count(*)::int n from lines`)).toEqual({ n: 2 });
		const { captured } = await run({ verb: 'update', input: { target: id, set: { note: 'm', lines: { update: [{ target: String(a!['id']), set: { amount: '140' } }] } } } });
		expect(captured.filter((c) => c.collection === 'orders').map((c) => c.cause)).toEqual(['direct']);
		expect(await one(`select total::text, big_lines, revision from orders`)).toEqual({ total: '200', big_lines: 1, revision: 3 });
		committed((await run({ collection: 'lines', verb: 'update', input: { target: String(a!['id']), set: { amount: '1' } } })).outcome);
		expect(await one(`select total::text, big_lines, revision from orders`)).toEqual({ total: '61', big_lines: 0, revision: 4 });
		expect(await one(`select count(*)::int n from bolt_history where cause = 'derived'`)).toEqual({ n: 1 });
	});

	it('an explicit delete removes one row, and deleting the parent cascades owned children and nulls tags', async () => {
		const id = await order('desk', [{ label: 'a', amount: '40' }, { label: 'b', amount: '60' }]);
		const [a] = await rows(`select id::text from lines order by label`);
		committed((await run({ verb: 'update', input: { target: id, set: { lines: { delete: [String(a!['id'])] } } } })).outcome);
		expect(await one(`select total::text from orders`)).toEqual({ total: '60' });
		const tag = committed((await run({ collection: 'tags', verb: 'create', input: { name: 't' } })).outcome).records[0]!.id;
		committed((await run({ verb: 'update', input: { target: id, set: { tags: { link: [tag] } } } })).outcome);
		const { captured } = await run({ verb: 'delete', input: { target: id } });
		expect(captured.map((c) => `${c.collection}:${c.op}:${c.cause}`).sort()).toEqual(['lines:delete:cascade', 'orders:delete:direct', 'tags:update:cascade']);
		expect(await one(`select (select count(*)::int from lines) l, (select "order" from tags) t`)).toEqual({ l: 0, t: null });
	});

	it('an update equal to the stored values writes nothing and commits empty (rule 29)', async () => {
		const id = await order('desk');
		const o = committed((await run({ verb: 'update', input: { target: id, set: { title: 'desk' } } })).outcome);
		expect(o.records).toEqual([]);
		expect(await one(`select revision from orders`)).toEqual({ revision: 1 });
	});

	it('a moved revision fails the act conflict (rule 25)', async () => {
		const id = await order('desk');
		committed((await run({ verb: 'update', input: { target: id, set: { note: 'a' } }, observed: { [id]: 1 } })).outcome);
		expect((await run({ verb: 'update', input: { target: id, set: { note: 'b' } }, observed: { [id]: 1 } })).outcome)
			.toEqual({ kind: 'conflict', records: [{ collection: 'orders', id, fields: [] }] });
	});

	it('upsert matches by id, creates without one, and keep writes nothing (rule 28)', async () => {
		const id = await order('desk');
		const kept = committed((await run({ verb: 'upsert', input: { id, note: 'x' }, onConflict: 'keep' })).outcome);
		expect(kept).toMatchObject({ output: [id], records: [] });
		const updated = committed((await run({ verb: 'upsert', input: { id, note: 'x' }, onConflict: 'update' })).outcome);
		expect(updated).toMatchObject({ output: [id], records: [{ id, revision: 2 }] });
		const made = (await run({ verb: 'upsert', input: { title: 'chair' }, onConflict: 'update' })).outcome;
		if (made.kind !== 'committed') throw new Error(JSON.stringify(made));
		expect(made.output).toEqual([made.records[0]!.id]);
		expect((await run({ verb: 'upsert', input: { id: '0199a000-0000-7000-8000-0000000000aa', note: 'x' }, onConflict: 'update' })).outcome)
			.toMatchObject({ code: 'notFound', field: 'id' });
		expect((await run({ verb: 'upsert', input: null, onConflict: 'update' })).outcome).toMatchObject({ code: 'invalidInput' });
		expect((await run({ verb: 'upsert', input: { id: 4, note: 'x' }, onConflict: 'update' })).outcome)
			.toMatchObject({ code: 'invalidInput', field: 'id' });
	});

	it('upserts a collection without a natural key', async () => {
		const parent = await order('desk');
		const made = committed((await run({ collection: 'lines', verb: 'upsert', input: { order: parent, label: 'part', amount: '1' }, onConflict: 'update' })).outcome);
		const id = made.records[0]!.id;
		expect(made).toMatchObject({ output: [id] });
		const changed = committed((await run({ collection: 'lines', verb: 'upsert', input: { id, amount: '2' }, onConflict: 'update' })).outcome);
		expect(changed).toMatchObject({ output: [id], records: [{ id, revision: 2 }] });
	});
});

describe('engine/write: model rules (rules 34, 40, 41)', () => {
	it('a state moves only along `to`, and a create lands in initial', async () => {
		expect((await run({ verb: 'create', input: { title: 'x', status: 'submitted' } })).outcome).toMatchObject({ code: 'invalidInput', field: 'status' });
		const id = await order('desk');
		committed((await run({ verb: 'update', input: { target: id, set: { status: 'submitted' } } })).outcome);
		committed((await run({ verb: 'update', input: { target: id, set: { status: 'draft' } } })).outcome);
	});

	it('per-state edit locks updates for administrators too; a delete is not locked', async () => {
		const id = await order('desk', [{ label: 'a', amount: '1' }]);
		committed((await run({ verb: 'update', input: { target: id, set: { status: 'submitted' } } })).outcome);
		expect((await run({ verb: 'update', input: { target: id, set: { title: 'y' } } })).outcome).toMatchObject({ code: 'locked', field: 'title' });
		committed((await run({ verb: 'update', input: { target: id, set: { note: 'allowed' } } })).outcome);
		// the owned child re-tests its parent's state under FOR SHARE inside the statement: a recorded refusal
		const [line] = await rows(`select id::text from lines`);
		count.writes = 0;
		expect((await run({ collection: 'lines', verb: 'update', input: { target: String(line!['id']), set: { amount: '2' } } })).outcome).toMatchObject({ code: 'locked' });
		expect(count.writes).toBe(2);
		committed((await run({ verb: 'delete', input: { target: id } })).outcome);
	});

	it('a caller moves a state only along edges its grant lists (moves)', async () => {
		const id = await order('desk');
		const caller = authority({ orders: grants({ moves: {} }) });
		expect((await run({ verb: 'update', input: { target: id, set: { status: 'submitted' } }, authority: caller })).outcome).toMatchObject({ code: 'forbidden', field: 'status' });
	});
});

describe('engine/write: the caller (rules 13, 19, 35)', () => {
	it('out of read scope is notFound, out of write scope is forbidden, a field outside `fields` is named', async () => {
		const id = await order('secret');
		const notMine = { t: 'cmp', field: 'title', op: 'ne', arg: { lit: 'secret' } } as const;
		expect((await run({ verb: 'update', input: { target: id, set: { note: 'x' } }, authority: authority({ orders: grants({ read: [arm(notMine)] }) }) })).outcome)
			.toMatchObject({ code: 'notFound' });
		expect((await run({ verb: 'update', input: { target: id, set: { note: 'x' } }, authority: authority({ orders: grants({ update: [arm(notMine)] }) }) })).outcome)
			.toMatchObject({ code: 'forbidden' });
		expect((await run({ verb: 'update', input: { target: id, set: { note: 'x' } }, authority: authority({ orders: grants({ update: [arm(undefined, ['title'])] }) }) })).outcome)
			.toMatchObject({ code: 'forbidden', field: 'note' });
	});

	it('a create is scoped on its post-image, after the transform (rule 35)', async () => {
		const onlyUpper = { t: 'cmp', field: 'title', op: 'eq', arg: { lit: 'DESK' } } as const;
		const caller = authority({ orders: grants({ create: [arm(onlyUpper)] }) });
		expect((await run({ verb: 'create', input: { title: 'desk' }, authority: caller })).outcome).toMatchObject({ code: 'forbidden' });
		const upper = transformEngine((inv) => ({ kind: 'ok', cpuMs: 1, output: (inv.input as { title: string }[]).map((x) => ({ ...x, title: x.title.toUpperCase() })) }));
		committed((await run({ verb: 'create', input: { title: 'desk' }, authority: caller }, upper)).outcome);
	});
});

function transformEngine(body: (inv: Invocation) => GuestOutcome, calls: Invocation[] = []): Partial<WriteEngine> {
	return { transforms: new Set(['orders']), guest: { invoke: async (inv) => (calls.push(inv), body(inv)) } };
}

describe('engine/write: the transform (rules 19, 27)', () => {
	it('gives an id upsert its stored row, without passing id to the transform payload', async () => {
		const calls: Invocation[] = [];
		const engine = transformEngine((inv) => ({ kind: 'ok', cpuMs: 1, output: inv.input }), calls);
		const id = await order('desk');
		const changed = committed((await run({ verb: 'upsert', input: { id, note: 'measured', lines: { create: [{ label: 'tile', amount: '2' }] } }, onConflict: 'update' }, engine)).outcome);
		expect(changed).toMatchObject({ output: [id] });
		expect(calls[0]!.input).toEqual([{ note: 'measured', lines: { create: [{ label: 'tile', amount: '2' }] } }]);
		expect(calls[0]!.ctx.existing![0]).toMatchObject({ id, title: 'desk' });
		expect(await rows(`select note from orders`)).toEqual([{ note: 'measured' }]);
		expect(await rows(`select label from lines`)).toEqual([{ label: 'tile' }]);
	});

	it('runs once per batch with ctx.existing, and its payload is the write', async () => {
		const calls: Invocation[] = [];
		const engine = transformEngine((inv) => ({ kind: 'ok', cpuMs: 1, output: (inv.input as object[]).map((x) => ({ ...x, note: 'derived' })) }), calls);
		const id = await order('a');
		committed((await run({ verb: 'update', input: [{ target: id, set: { title: 'b' } }] }, engine)).outcome);
		committed((await run({ verb: 'create', input: [{ title: 'c' }, { title: 'd' }] }, engine)).outcome);
		expect(calls.map((c) => (c.input as unknown[]).length)).toEqual([1, 2]);
		expect(calls[0]!.ctx.existing![0]).toMatchObject({ title: 'a' });
		expect(await rows(`select note from orders order by title`)).toEqual([{ note: 'derived' }, { note: 'derived' }, { note: 'derived' }]);
	});

	it('a refusal is recorded, so a replay answers it without running guest code again', async () => {
		const calls: Invocation[] = [];
		const engine = transformEngine(() => ({ kind: 'refused', message: 'no desks', field: 'title', cpuMs: 1 }), calls);
		const first = await run({ verb: 'create', input: { title: 'desk' }, key: 'g' }, engine);
		expect(first.outcome).toEqual({ kind: 'refused', code: 'refused', message: 'no desks', field: 'title', rule: 'orders.transform' });
		const replay = await run({ verb: 'create', input: { title: 'desk' }, key: 'g', retry: true }, engine);
		expect(replay.outcome).toEqual(first.outcome);
		expect(calls).toHaveLength(1);
	});
});

describe('engine/write: locks and queued pieces (rules 26, 49)', () => {
	it('a transform that read takes one sorted SHARE ROW EXCLUSIVE lock over write and read tables', async () => {
		const locks: unknown[] = [];
		const inner = db;
		db = { ...inner, write: (s, l) => (locks.push(l), inner.write(s, l)) };
		const engine = { ...transformEngine((inv) => ({ kind: 'ok', cpuMs: 1, output: inv.input })),
			bridge: () => ({ cross: async () => [], tables: () => ['tags'] }) };
		committed((await run({ verb: 'create', input: { title: 'a' } }, engine)).outcome);
		expect(locks).toEqual([{ tables: ['orders', 'tags'], mode: 'SHARE ROW EXCLUSIVE' }]);
	});

	it('queued runs, notices and outbox rows are pieces of the statement, behind the gate', async () => {
		const x = { key: 'q', digest: 'd', issuedAt: NOW, now: NOW, today: TODAY, actor: admin.actor, writes: [], owned: [], rate: [], output: null,
			runs: [{ id: 'r1', automation: 'remind', input: { a: 1 }, dueAt: NOW, cause: 'act', depth: 0, key: 'once' }],
			notices: [{ id: 'n1', to: { channel: 'mail', recipients: [{ user: 'u' }] }, title: 'Hi' }], outbox: [{ id: 'm1', channel: 'mail', message: { to: 'x' } }] };
		await db.write(compileCommit(manifest, catalogOf(manifest), x));
		await db.write(compileCommit(manifest, catalogOf(manifest), { ...x, runs: [{ ...x.runs[0]!, id: 'r2' }] }));
		// the mail notice queues its own delivery run, once, like the rest
		expect(await one(`select (select count(*)::int from sys_run where automation = 'remind') r, (select count(*)::int from sys_run where automation = 'notifications.deliver') d,
			(select count(*)::int from sys_notification) n, (select count(*)::int from bolt_outbox) o`))
			.toEqual({ r: 1, d: 1, n: 1, o: 1 });
	});
});

describe('engine/write: approval hook points (rules 44–46, P3)', () => {
	it('a routed act commits provisionally under the hook\'s request; a held row refuses a non-participant', async () => {
		const requestId = '0199a000-0000-7000-8000-0000000000aa';
		const routed = authority({ orders: grants({ create: [{ ...arm(), approval: [{ steps: [['finance']] }] }] }) });
		const engine: Partial<WriteEngine> = { approval: { participant: () => false, route: () => ({ requestId }) } };
		const o = (await run({ verb: 'create', input: { title: 'held' }, authority: routed }, engine)).outcome;
		expect(o).toMatchObject({ kind: 'pendingApproval', requestId });
		const [row] = await rows(`select id::text, approval_id::text from orders`);
		expect(row!['approval_id']).toBe(requestId);
		expect((await run({ verb: 'update', input: { target: String(row!['id']), set: { note: 'x' } }, authority: authority({ orders: grants() }) }, engine)).outcome)
			.toMatchObject({ code: 'approvalHeld' });
	});
});

describe('engine/write: seed mode (rule 70, X-13)', () => {
	it('restores rows as given, derives roll-ups, refuses drift, and the next number follows the highest seeded', async () => {
		const o = '0199a000-0000-4000-8000-000000000001';
		const pack = {
			orders: [{ id: o, title: 'seeded', number: 'PO-2026-0042', status: 'submitted', total: '5.00' }],
			lines: [{ id: '0199a000-0000-4000-8000-000000000002', label: 'a', amount: '5', order: o }],
		};
		expect(await seed(manifest, db, pack, NOW)).toEqual({ inserted: 2 });
		expect(await seed(manifest, db, pack, NOW)).toEqual({ inserted: 0 });
		expect(await one(`select status, total::text from orders`)).toEqual({ status: 'submitted', total: '5' });
		await expect(seed(manifest, db, { orders: [{ ...pack.orders[0]!, id: '0199a000-0000-4000-8000-000000000003', title: 'x', number: 'PO-2026-0001', total: '9' }] }, NOW))
			.rejects.toThrow(/SeedDrift|total/);
		committed((await run({ verb: 'create', input: { title: 'next' } })).outcome);
		expect(await one(`select number from orders where title = 'next'`)).toEqual({ number: 'PO-2026-0043' });
	});
});


describe('engine/write: grants walk relation hops to any depth (rules 35, 36)', () => {
	it('a supplied ref is readable through its parent, and a create scope through two hops, in one extra round trip', async () => {
		const ext = { ...manifest,
			models: { ...manifest.models, notes: { description: 'A note', label: 'body', fields: { body: { kind: 'text' } } } },
			relationships: { ...manifest.relationships, 'notes.line': { to: 'lines', inverse: 'notes' } },
			collections: { ...manifest.collections, notes: { read: { fields: 'all' }, create: { input: { columns: ['body', 'line'] } } } },
		} as typeof manifest;
		await applyPlan(db, plan(schemaSlice(manifest), ext), { accept: true });
		const id = await order('desk', [{ label: 'a', amount: '1' }]);
		const line = String((await one(`select id::text from lines where "order" = '${id}'`))['id']);
		const desk = { title: { eq: 'desk' } };
		const caller = (title: object) => authority({
			lines: grants({ read: [arm(toPred(ext, 'lines', { order: { is: title } }))] }),
			notes: grants({ create: [arm(toPred(ext, 'notes', { line: { is: { order: { is: title } } } }))] }),
		});
		const note = (who: ReturnType<typeof caller>) => act({ manifest: ext, db }, { collection: 'notes', verb: 'create', input: { body: 'hi', line },
			key: `key-${n}`, issuedAt: NOW, authority: who, bindings: { now: NOW, today: TODAY, tz: 'UTC', params: {} }, invocationId: `inv-${n++}` });
		count.reads = 0;
		committed((await note(caller(desk))).outcome);
		expect(count.reads).toBe(2);
		expect((await note(caller({ title: { eq: 'chair' } }))).outcome).toMatchObject({ kind: 'refused', code: 'notFound', field: 'line' });
	});
});
