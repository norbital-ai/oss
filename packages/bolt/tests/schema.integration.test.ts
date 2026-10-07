/// <reference types="node" />
// Schema on a real Postgres (PGlite 18): the empty-DB plan, one test per §5.2 / rule 68–69 guarantee.
import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { BoltError, DbError, type TenantDb } from '../src/engine/contracts.ts';
import { openPglite } from '../src/engine/db/pglite.ts';
import { postgresDb, type PgClient } from '../src/engine/db/postgres.ts';
import { constraintIndex, type SchemaSlice } from '../src/engine/schema/ddl.ts';
import { applyPlan, plan, readApplied } from '../src/engine/schema/plan.ts';
import { refusalOf } from '../src/engine/schema/refusal.ts';
import { slice } from './schema-fixture.ts';

let db: TenantDb;
let pg: PGlite;
const U = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const exec = (text: string, params: readonly (string | number | null)[] = []) => db.write({ text, params });
const refusal = async (p: Promise<unknown>, s: SchemaSlice = slice()) => {
	const e = await p.then(() => null, (x: unknown) => x);
	expect(e).toBeInstanceOf(DbError);
	return refusalOf(e as DbError, constraintIndex(s));
};
async function migrate(s: SchemaSlice, accept?: true | readonly string[]) {
	const p = plan(await readApplied(db), s);
	await applyPlan(db, p, accept === undefined ? {} : { accept });
	return p;
}
async function seed() {
	await exec(`insert into customers (id, name, email) values ($1, 'Ada', 'ada@x.io'), ($2, 'Bob', null)`, [U(1), U(2)]);
	await exec(`insert into orders (id, customer, code, total, qty) values ($1, $2, 'SO-1', '10.50', 3)`, [U(10), U(1)]);
}

beforeEach(async () => {
	({ db, pg } = await openPglite());
	await migrate(slice());
});

describe('next schema on PGlite', () => {
	it('applies the empty-database plan and records the slice; planning again is empty', async () => {
		expect(await readApplied(db)).toEqual(JSON.parse(JSON.stringify(slice())));
		expect(plan(await readApplied(db), slice()).steps).toEqual([]);
	});

	it('the empty-database plan creates the built-in layer\'s and the engine\'s tables; a re-apply keeps them and their rows', async () => {
		const [t] = await db.read([{ text: `select count(*)::int as n from pg_tables where tablename in ('sys_user', 'sys_team', 'sys_run', 'sys_message', 'approval_request', 'bolt_idem')`, params: [] }]);
		expect(t?.rows[0]?.n).toBe(6);
		await exec(`insert into sys_user (id, name) values ('u1', 'Ada')`);
		const again = await migrate(slice());
		expect(again.steps).toEqual([]);
		const [u] = await db.read([{ text: `select name from sys_user where id = 'u1'`, params: [] }]);
		expect(u?.rows).toEqual([{ name: 'Ada' }]);
	});

	it('re-planning after the slice round-trips through jsonb is empty; an unrelated field adds only its column', async () => {
		// `bolt_schema.slice` is jsonb: `states` and predicate fields come back in another key order than declared
		const s: SchemaSlice = { ...slice(), models: { ...slice().models, signings: { description: 'signings', label: 'status', fields: {
			status: { kind: 'state', initial: 'unstamped', states: { unstamped: { to: ['voided'] }, counterparty_stamped: {}, acknowledged: {}, voided: {} } },
			reason: { kind: 'text', optional: true },
		}, check: { void_needs_reason: { status: { ne: 'voided', in: ['unstamped', 'voided'] }, reason: { isNull: false } } } } } };
		await migrate(s);
		expect(plan(await readApplied(db), s).steps).toEqual([]);
		const signings = s.models.signings!;
		const next: SchemaSlice = { ...s, models: { ...s.models, signings: { ...signings, fields: { ...signings.fields, nickname: { kind: 'text', optional: true } } } } };
		expect((await migrate(next)).steps.map((x) => x.id)).toEqual(['create:column:signings.nickname']);
		expect(plan(await readApplied(db), next).steps).toEqual([]);
	});

	it('computes every operator immutably and emits JSON values', async () => {
		await seed();
		const [r] = await db.read([{ text: `select * from orders where id = $1`, params: [U(10)] }]);
		expect(r?.rows[0]).toMatchObject({
			gross: '11.45', total: '10.50', qty: 3, big: false, per: expect.stringMatching(/^3\.5/), status: 'open',
			slug: 'so-1', head: 'SO', placed: expect.stringMatching(/^\d{4}-\d\d-\d\d$/), at: expect.stringMatching(/Z$/),
		});
		const row = r?.rows[0] as { placed: string; due: string; month: string; label: string };
		expect(row.label).toBe(`SO-1 / ${row.placed} / 3`);
		expect(row.month).toBe(`${row.placed.slice(0, 8)}01`);
		const [c] = await db.read([{ text: `select bolt_search::text as doc, tags from customers where id = $1`, params: [U(1)] }]);
		expect(c?.rows[0]).toEqual({ doc: `'#ad' 'ada'`, tags: [] }); // the multilingual document: the word and its Latin skeleton
	});

	it('maps every constraint violation to its refusal through the constraint name', async () => {
		await seed();
		expect(await refusal(exec(`insert into customers (id, name) values ($1, 'Ada')`, [U(3)]))).toMatchObject({ code: 'unique', field: 'name' });
		expect(await refusal(exec(`insert into customers (id, name, email) values ($1, 'Cy', 'ada@x.io')`, [U(3)]))).toMatchObject({ code: 'unique', field: 'email' });
		expect(await refusal(exec(`insert into customers (id, name, email) values ($1, 'Cy', 'nope')`, [U(3)]))).toMatchObject({ code: 'check', field: 'email' });
		expect(await refusal(exec(`insert into customers (id, name) values ($1, 'a name that is far too long')`, [U(3)]))).toMatchObject({ code: 'check', field: 'name' });
		expect(await refusal(exec(`insert into orders (id, customer, code, total, qty) values ($1, $2, 'SO-2', '1', 1)`, [U(11), U(99)]))).toMatchObject({ code: 'missingRef', field: 'customer' });
		expect(await refusal(exec(`delete from customers where id = $1`, [U(1)]))).toMatchObject({ code: 'restricted' });
		expect(await refusal(exec(`insert into orders (id, code, total, qty) values ($1, 'SO-2', '1', 1)`, [U(11)]))).toMatchObject({ code: 'required', field: 'customer' });
		expect(await refusal(exec(`update orders set status = 'closed', qty = 0 where id = $1`, [U(10)]))).toMatchObject({ code: 'check', message: expect.stringContaining('closed_has_qty') });
		expect(await refusal(exec(`update orders set status = 'lost' where id = $1`, [U(10)]))).toMatchObject({ code: 'check', field: 'status' });
		expect(await refusal(exec(`update orders set qty = 3000000000 where id = $1`, [U(10)]))).toMatchObject({ code: 'overflow' });
	});

	it('money and decimals refuse excess precision instead of rounding (rule 68)', async () => {
		await seed();
		expect(await refusal(exec(`update orders set total = '1.005' where id = $1`, [U(10)]))).toMatchObject({ code: 'check', field: 'total' });
		expect(await refusal(exec(`update orders set jpy = '1.5' where id = $1`, [U(10)]))).toMatchObject({ code: 'check', field: 'jpy' });
		expect(await refusal(exec(`update orders set rate = '1.234' where id = $1`, [U(10)]))).toMatchObject({ code: 'check', field: 'rate' });
		expect(await refusal(exec(`update orders set rate = '1000' where id = $1`, [U(10)]))).toMatchObject({ code: 'check', field: 'rate' });
		await exec(`update orders set jpy = '150', rate = '999.99' where id = $1`, [U(10)]);
	});

	it('an exclusive arc takes exactly one target', async () => {
		await seed();
		await exec(`insert into notes (id, body, about__orders) values ($1, 'hi', $2)`, [U(20), U(10)]);
		expect(await refusal(exec(`insert into notes (id, body) values ($1, 'none')`, [U(21)]))).toMatchObject({ code: 'check', field: 'about' });
		expect(await refusal(exec(`insert into notes (id, body, about__orders, about__customers) values ($1, 'two', $2, $3)`, [U(21), U(10), U(1)]))).toMatchObject({ code: 'check', field: 'about' });
	});

	it('noOverlap: null is a value, periods are valid, and a successor may close its predecessor in one statement', async () => {
		await seed();
		const term = (id: number, from: string, to: string | null, scope: string | null, grade: string | null, customer = U(1)) =>
			exec(`insert into terms (id, customer, period, scope, grade) values ($1, $2, daterange($3::date, $4::date, '[]'), $5, $6)`, [U(id), customer, from, to, scope, grade]);
		await term(30, '2024-01-01', null, null, 'g30');
		expect(await refusal(term(31, '2024-06-01', null, null, 'g31'))).toMatchObject({ code: 'overlap' });
		await term(31, '2024-06-01', null, 'other', 'g31');
		expect(await refusal(exec(`insert into terms (id, customer, period) values ($1, $2, 'empty')`, [U(32), U(1)]))).toMatchObject({ code: 'check', field: 'period' });
		// successor first, predecessor closed after, in one statement: the EXCLUDE is deferrable
		await exec(`with s as (insert into terms (id, customer, period, grade) values ($1, $2, daterange('2025-01-01', null, '[]'), 'g33') returning id)
			update terms set period = daterange('2024-01-01', '2024-12-31', '[]') where id = $3`, [U(33), U(1), U(30)]);
		// composite unique: a null grade is a value
		await term(34, '2030-01-01', '2030-01-02', 'a', null);
		expect(await refusal(term(35, '2031-01-01', '2031-01-02', 'b', null))).toMatchObject({ code: 'unique' });
		// a partial unique is an EXCLUDE and reports as `unique`
		await term(36, '2032-01-01', '2032-01-02', 'x', 'g1');
		expect(await refusal(term(37, '2033-01-01', '2033-01-02', 'x', 'g1', U(2)))).toMatchObject({ code: 'unique', message: expect.stringContaining('one_x_grade') });
	});

	it('builds the search GIN, the vector HNSW and the point GiST indexes', async () => {
		const [r] = await db.read([{ text: `select indexdef from pg_indexes where tablename = 'customers' order by 1`, params: [] }]);
		const defs = r?.rows.map((x) => String(x.indexdef)).join('\n');
		expect(defs).toMatch(/USING gin \(bolt_search\)/);
		expect(defs).toMatch(/USING hnsw \(colour vector_l2_ops\)/);
		expect(defs).toMatch(/USING gist \(place\)/);
		expect(defs).toMatch(/USING gin \(tags\)/);
	});

	it('a required column on a populated table is refused naming the constraint and row count; nothing changes', async () => {
		await seed();
		const s = slice();
		const next: SchemaSlice = { ...s, models: { ...s.models, notes: { ...s.models.notes!, fields: { body: { kind: 'text' }, pinned: { kind: 'bool' } } } } };
		await exec(`insert into notes (id, body, about__customers) values ($1, 'a', $2), ($3, 'b', $2)`, [U(40), U(1), U(41)]);
		const p = plan(await readApplied(db), next);
		expect(p.steps.find((x) => x.id === 'create:notNull:notes.pinned')?.class).toBe('validating');
		const e = await applyPlan(db, p).catch((x: unknown) => x);
		expect(e).toBeInstanceOf(BoltError);
		expect((e as BoltError).message).toBe('notNull:notes.pinned refuses 2 existing rows');
		expect(await readApplied(db)).toEqual(JSON.parse(JSON.stringify(s)));
		// with a default the same change applies
		const withDefault: SchemaSlice = { ...s, models: { ...s.models, notes: { ...s.models.notes!, fields: { body: { kind: 'text' }, pinned: { kind: 'bool', default: false } } } } };
		await migrate(withDefault);
		const [r] = await db.read([{ text: 'select count(*)::int as n from notes where pinned = false', params: [] }]);
		expect(r?.rows[0]?.n).toBe(2);
	});

	it('a destructive step needs acceptance; accepted, it drops the column', async () => {
		await seed();
		const s = slice();
		const { note: _, ...fields } = s.models.orders!.fields;
		const next: SchemaSlice = { ...s, models: { ...s.models, orders: { ...s.models.orders!, fields } } };
		await expect(migrate(next)).rejects.toMatchObject({ code: 'destructiveNotAccepted' });
		await migrate(next, ['drop:column:orders.note']);
		const [r] = await db.read([{ text: `select count(*)::int as n from information_schema.columns where table_name = 'orders' and column_name = 'note'`, params: [] }]);
		expect(r?.rows[0]?.n).toBe(0);
	});

	it('a new roll-up is backfilled from existing children; a changed enum is validated against rows', async () => {
		await seed();
		const s = slice();
		const cust = s.models.customers!;
		const next: SchemaSlice = { ...s, models: { ...s.models, customers: { ...cust, fields: { ...cust.fields, all_orders: { kind: 'count', of: 'orders' }, tags: { kind: 'enum', values: ['new'], many: true, default: [] } } } } };
		await exec(`update customers set tags = '{vip}' where id = $1`, [U(1)]);
		const p = plan(await readApplied(db), next);
		expect(p.steps.find((x) => x.id === 'create:backfill:customers.all_orders')?.class).toBe('backfill');
		await expect(applyPlan(db, p)).rejects.toMatchObject({ code: 'schemaInvalid', message: expect.stringMatching(/refuses 1 existing row$/) });
		await exec(`update customers set tags = '{}'`);
		await applyPlan(db, plan(await readApplied(db), next));
		const [r] = await db.read([{ text: 'select all_orders from customers where id = $1', params: [U(1)] }]);
		expect(r?.rows[0]?.all_orders).toBe(1);
	});

	it('a plan made against an older schema is refused once another apply has moved it', async () => {
		const s = slice();
		const stale = plan(await readApplied(db), { ...s, tz: 'UTC' });
		await migrate({ ...s, tz: 'Europe/Paris' });
		await expect(applyPlan(db, stale)).rejects.toMatchObject({ code: 'schemaMoved' });
	});

	it('write takes the sorted table and advisory locks in the same transaction as its statement', async () => {
		await seed();
		const r = await db.write({ text: `select count(*)::int as n from pg_locks where locktype in ('relation', 'advisory') and granted and mode in ('ShareRowExclusiveLock', 'ExclusiveLock')`, params: [] },
			{ tables: ['orders', 'customers'], advisory: ['k'] });
		expect(r.rows[0]?.n).toBeGreaterThanOrEqual(3);
	});

	it('the node-postgres adapter sends read batches and a locked write as one round trip each', async () => {
		await seed();
		let calls = 0;
		const client: PgClient = {
			async query(q) {
				calls++;
				if (q.values !== undefined) return pg.query(q.text, q.values).then((r) => ({ rows: r.rows as never, rowCount: r.affectedRows ?? 0 }));
				return (await pg.exec(q.text)).map((r) => ({ rows: r.rows as never, rowCount: r.affectedRows ?? 0 }));
			},
			release() {},
		};
		const remote = postgresDb({ connect: async () => client });
		const rows = await remote.read([{ text: 'select name from customers where id = $1', params: [U(1)] }, { text: `select code from orders where customer = $1 and code = $2`, params: [U(1), "SO-1"] }]);
		expect(rows.map((r) => r.rows)).toEqual([[{ name: 'Ada' }], [{ code: 'SO-1' }]]);
		expect(calls).toBe(1);
		const w = await remote.write({ text: `update customers set name = $1 where id = $2 returning name`, params: ["O'Brien", U(2)] }, { tables: ['customers'], advisory: ['x'] });
		expect(w.rows).toEqual([{ name: "O'Brien" }]);
		expect(calls).toBe(3);
		await expect(remote.write({ text: `insert into customers (id, name) values ($1, 'Ada')`, params: [U(5)] })).rejects.toMatchObject({ sqlstate: '23505' });
		expect((await db.read([{ text: 'select count(*)::int as n from customers', params: [] }]))[0]?.rows[0]?.n).toBe(2);
	});

	it('a locked write PREPAREs once then EXECs inside the lock batch', async () => {
		await seed();
		const texts: string[] = [];
		const client: PgClient = {
			async query(q) {
				texts.push(q.text);
				if (q.values !== undefined) return pg.query(q.text, q.values).then((r) => ({ rows: r.rows as never, rowCount: r.affectedRows ?? 0 }));
				return (await pg.exec(q.text)).map((r) => ({ rows: r.rows as never, rowCount: r.affectedRows ?? 0 }));
			},
			release() {},
		};
		const remote = postgresDb({ connect: async () => client });
		const sql = { text: `update customers set name = $1 where id = $2 returning name`, params: ['Eve', U(1)] };
		const lock = { tables: ['customers'] as const };
		expect((await remote.write(sql, lock)).rows).toEqual([{ name: 'Eve' }]);
		expect(texts[0]).toMatch(/^prepare /i);
		expect(texts[1]).toMatch(/execute /i);
		expect(texts[1]).toMatch(/^begin/i);
		expect((await remote.write({ ...sql, params: ['Fay', U(1)] }, lock)).rows).toEqual([{ name: 'Fay' }]);
		expect(texts.filter((t) => /^prepare /i.test(t))).toHaveLength(1);
	});

	it('an unlocked write is a named extended-protocol statement', async () => {
		await seed();
		const seen: { name?: string; values?: (string | null)[] }[] = [];
		const client: PgClient = {
			async query(q) {
				seen.push(q);
				if (q.values !== undefined) return pg.query(q.text, q.values).then((r) => ({ rows: r.rows as never, rowCount: r.affectedRows ?? 0 }));
				return (await pg.exec(q.text)).map((r) => ({ rows: r.rows as never, rowCount: r.affectedRows ?? 0 }));
			},
			release() {},
		};
		const remote = postgresDb({ connect: async () => client });
		const w = await remote.write({ text: `update customers set name = $1 where id = $2 returning name`, params: ['Ada 2', U(1)] });
		expect(w.rows).toEqual([{ name: 'Ada 2' }]);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.name).toMatch(/^b/);
		expect(seen[0]?.values).toEqual(['Ada 2', U(1)]);
	});
});
