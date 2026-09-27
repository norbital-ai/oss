// Rule 11a: the strict `Where`/`OrderBy` decoder, calendar-relative operands, child aggregates, json contains, `bolt.decode`.
import { describe, expect, it } from 'vitest';
import type { Pred, RowData } from '../src/engine/contracts.ts';
import { browserCatalog, catalog } from '../src/protocol/catalog.ts';
import { contains, evaluate, midnight, startOfDate } from '../src/engine/query/eval.ts';
import { decodeView, order, read, where } from '../src/protocol/ir.ts';
import { compile } from '../src/engine/query/sql.ts';
import { createBolt } from '../src/client/bolt.ts';
import { exposure } from '../src/shell/nav.ts';
import { bindings, manifest, rep } from './query.fixture.ts';

const cat = catalog(manifest);
const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as { code?: string }).code; } return 'ok'; };
const nest = (n: number): object => n === 0 ? { qty: { eq: 1 } } : { not: nest(n - 1) };

describe('rule 11a: one invalid row per shape', () => {
	const rows: [string, string, object][] = [
		['orders', 'empty operator object on a field', { status: {} }],
		['orders', 'eq: undefined (on the wire: {})', { status: { eq: undefined } }],
		['accounts', 'empty many-relation', { orders: {} }],
		['orders', 'empty one-relation', { account: {} }],
		['orders', 'empty one-relation is', { account: { is: {} } }],
		['orders', 'not: {}', { not: {} }],
		['orders', 'empty and element', { and: [{}] }],
		['orders', 'isNull not a boolean', { note: { isNull: 'yes' } }],
		['orders', 'isEmpty not a boolean', { tags: { isEmpty: 'x' } }],
		['orders', 'eq: null', { note: { eq: null } }],
		['orders', 'decimal literal of the wrong type', { total: { eq: 'abc' } }],
		['orders', 'int literal of the wrong type', { qty: { gt: 1.5 } }],
		['orders', 'undeclared enum value', { status: { eq: 'bogus' } }],
		['orders', 'bad ISO date', { placed: { eq: '2026-02-30' } }],
		['orders', 'bad instant', { at: { lt: 'soon' } }],
		['orders', 'id not a uuid', { account: { eq: 'x' } }],
		['orders', 'in not a list', { status: { in: 'open' } }],
		['orders', 'hasAny not a list', { tags: { hasAny: 'a' } }],
		['orders', 'list past WHERE_MAX_LIST', { qty: { in: Array.from({ length: 1001 }, (_, i) => i) } }],
		['accounts', 'count not an integer', { orders: { count: { eq: 1.5 } } }],
		['accounts', 'count negative', { orders: { count: { gte: -1 } } }],
		['accounts', 'count with in', { orders: { count: { in: [1] } } }],
		['orders', 'near not [point, metres]', { spot: { near: 'x' } }],
		['orders', 'near negative', { spot: { near: [{ lat: 1, lng: 1 }, -5] } }],
		['orders', 'polygon of two points', { spot: { within: { polygon: [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }] } } }],
		['orders', 'period literal with one end', { span: { overlaps: { from: '2026-09-01' } } }],
		['orders', 'now on a date', { placed: { eq: { now: '' } } }],
		['orders', 'today on an instant', { at: { lt: { today: '' } } }],
		['orders', 'startOf on text', { note: { eq: { startOf: 'month' } } }],
		['orders', 'startOf with a bad unit', { placed: { gte: { startOf: 'fortnight' } } }],
		['orders', 'actor id on a non-member id', { account: { eq: { actor: 'id' } } }],
		['orders', 'actor email on plain text', { note: { eq: { actor: 'email' } } }],
		['orders', 'teams outside in/nin', { account: { eq: { actor: 'teams' } } }],
		['orders', 'field operand of another family', { total: { gt: { field: 'note' } } }],
		['orders', 'bad offset', { placed: { gte: { today: '+-5d' } } }],
		['accounts', 'relation without a quantifier', { orders: { status: { eq: 'open' } } }],
		['orders', 'aggregate of a text field', { lines: { sum: { of: 'sku', gt: 1 } } }],
		['orders', 'aggregate with no comparison', { lines: { sum: { of: 'amount' } } }],
		['orders', 'aggregate literal of the wrong type', { lines: { max: { of: 'amount', gt: 'x' } } }],
		['orders', 'json contains on a text field', { note: { contains: 'x' } }],
		['orders', 'nested past WHERE_MAX_DEPTH', nest(17)],
	];
	it.each(rows)('%s: %s', (m, _, w) => { expect(code(() => where(cat, m, w))).toBe('invalid'); });
	it('the invalid names the path of the first fault', () => {
		expect(() => where(cat, 'accounts', { orders: { some: { lines: { every: { amount: { gt: 'x' } } } } } }))
			.toThrow(/where\.orders\.some\.lines\.every\.amount\.gt/);
	});
	it('a bare value is eq, a list in and null isNull, as a person writes it; a bad value is still refused', () => {
		expect(where(cat, 'orders', { status: 'open' })).toEqual(where(cat, 'orders', { status: { eq: 'open' } }));
		expect(where(cat, 'orders', { status: ['open'] })).toEqual(where(cat, 'orders', { status: { in: ['open'] } }));
		expect(where(cat, 'orders', { note: null })).toEqual(where(cat, 'orders', { note: { isNull: true } }));
		expect(code(() => where(cat, 'orders', { status: 'bogus' }))).toBe('invalid');
		const account = '0199a000-0000-4000-8000-0000000000a1';
		expect(where(cat, 'orders', { account })).toEqual(where(cat, 'orders', { account: { eq: account } }));
	});
	it('an empty Where is valid at the root and as a quantifier body', () => {
		expect(where(cat, 'orders', {})).toEqual({ t: 'const', value: true });
		expect(code(() => where(cat, 'accounts', { orders: { none: {} } }))).toBe('ok');
		expect(code(() => where(cat, 'orders', nest(16)))).toBe('ok');
	});
});

describe('P34: the widened language', () => {
	it('startOf: Monday weeks, months, quarters, years, shifted; an instant is that day 00:00 in the zone', () => {
		expect(startOfDate({ startOf: 'week' }, '2026-09-27')).toBe('2026-09-21'); // a Sunday belongs to the week of Monday the 21st
		expect(startOfDate({ startOf: 'week', shift: -1 }, '2026-09-21')).toBe('2026-09-14');
		expect(startOfDate({ startOf: 'month', shift: 1 }, '2026-12-15')).toBe('2027-01-01');
		expect(startOfDate({ startOf: 'quarter', shift: -1 }, '2026-02-10')).toBe('2025-10-01');
		expect(startOfDate({ startOf: 'year' }, '2026-09-25')).toBe('2026-01-01');
		expect(midnight('2026-09-01', 'Asia/Kuala_Lumpur')).toBe('2026-08-31T16:00:00.000Z');
		expect(midnight('2026-03-29', 'Europe/Berlin')).toBe('2026-03-28T23:00:00.000Z');
	});
	it('this month, as a date range and as an overlapping period, in SQL and JS', () => {
		const p = where(cat, 'orders', { placed: { gte: { startOf: 'month' }, lt: { startOf: 'month', shift: 1 } },
			span: { overlaps: { from: { startOf: 'month' }, to: { today: '' } } }, at: { gte: { startOf: 'week' } } });
		const env = { cat, bindings };
		const row = { id: 'x', placed: '2026-09-02', span: { from: '2026-08-20', to: '2026-09-01' }, at: '2026-09-21T00:00:00.000Z' };
		expect(evaluate(env, 'orders', p, row)).toBe(true);
		expect(evaluate(env, 'orders', p, { ...row, placed: '2026-08-31' })).toBe(false);
		expect(evaluate(env, 'orders', p, { ...row, at: '2026-09-20T15:59:59.000Z' })).toBe(false); // before Monday 00:00 in KL
		const sql = compile(cat, read(cat, 'orders', { limit: 1, where: { placed: { gte: { startOf: 'month' } } } }), { as: 'workspace' }, bindings).sql;
		expect(sql.params).toContain('2026-09-01');
	});
	it('child aggregates: sum of none is 0, min/max/avg of none match nothing; a masked of is forbidden', () => {
		const env = { cat, bindings, related: (_c: string, _r: string, _t: string, row: RowData): RowData[] => row.id === 'a' ? [] : [{ id: 'l1', amount: { $dec: '10.10' } }, { id: 'l2', amount: '10.20' }] };
		const is = (w: object, id: string) => evaluate(env, 'orders', where(cat, 'orders', w), { id });
		expect(is({ lines: { sum: { of: 'amount', eq: 0 } } }, 'a')).toBe(true);
		expect(is({ lines: { avg: { of: 'amount', ne: 1 } } }, 'a')).toBe(false);
		expect(is({ lines: { sum: { of: 'amount', eq: '20.3' } } }, 'b')).toBe(true);
		expect(is({ lines: { max: { of: 'amount', gte: '10.2' }, min: { of: 'amount', lt: 10.2 } } }, 'b')).toBe(true);
		expect(code(() => compile(cat, read(cat, 'accounts', { limit: 1, where: { orders: { sum: { of: 'total', gt: 1 } } } }), { as: 'caller', authority: rep }, bindings))).toBe('forbidden');
	});
	it('json contains is jsonb @>', () => {
		expect(where(cat, 'orders', { doc: { contains: { big: 'x' } } })).toEqual({ t: 'json', field: 'doc', contains: { big: 'x' } } satisfies Pred);
		expect(contains({ a: [1, 2, { b: null }], c: 'x' }, { a: [{ b: null }, 2] }, true)).toBe(true);
		expect(contains([1, 2], 2, true)).toBe(true);
		expect(contains({ a: 1 }, { a: 2 }, true)).toBe(false);
	});
	it('OrderBy: at most 4 keys, one field each, no field twice, sortable fields only', () => {
		expect(order([{ total: 'desc' }, 'placed', { created_at: 'asc' }], cat, 'orders')).toEqual([
			{ field: 'total', dir: 'desc' }, { field: 'placed', dir: 'asc' }, { field: 'created_at', dir: 'asc' }]);
		for (const bad of [['qty', 'placed', 'at', 'total', 'note'], ['qty', { qty: 'desc' }], { qty: 'asc', at: 'desc' }, 'tags', 'span', 'doc', 'spot', 'revision', { qty: 'up' }])
			expect(code(() => order(bad, cat, 'orders'))).toBe('invalid');
	});
	it('OrderBy: a related key nests through one-relations (≤ 2 hops) to a sortable target field; the IR path is dotted', () => {
		expect(order([{ account: { name: 'asc' } }, { account: { region: 'desc' } }, 'account'], cat, 'orders')).toEqual([
			{ field: 'account.name', dir: 'asc' }, { field: 'account.region', dir: 'desc' }, { field: 'account', dir: 'asc' }]);
		expect(order({ order: { account: { name: 'desc' } } }, cat, 'lines')).toEqual([{ field: 'order.account.name', dir: 'desc' }]);
		for (const bad of [{ account: { name: 'asc', region: 'asc' } }, { account: {} }, { account: { name: 'up' } }, { account: { id: 'asc' } },
			{ account: { bogus: 'asc' } }, { 'account.name': 'asc' }, 'account.name', { status: { name: 'asc' } }, [{ account: { name: 'asc' } }, { account: { name: 'desc' } }]])
			expect(code(() => order(bad, cat, 'orders'))).toBe('invalid');
		expect(code(() => order({ about: { name: 'asc' } }, cat, 'notes'))).toBe('invalid'); // an arc is not a hop
		expect(code(() => order({ order: { account: { name: { x: 'asc' } } } }, cat, 'lines'))).toBe('invalid'); // three hops
	});
	it('rule 14: a related key compiles to a subselect only where the caller reads the target field unmasked, else invalidInput', () => {
		const sql = (orderBy: unknown, reader: Parameters<typeof compile>[2] = { as: 'caller', authority: rep }) =>
			compile(cat, read(cat, 'orders', { limit: 5, orderBy }), reader, bindings);
		const ok = sql({ account: { name: 'asc' } }).sql.text;
		expect(ok).toMatch(/ORDER BY \(SELECT \w+\."name" FROM "accounts"/);
		expect(ok).toMatch(/jsonb_build_array\(\(SELECT \w+\."name"/); // the cursor carries the related value
		expect(code(() => sql({ account: { secret: 'asc' } }))).toBe('invalidInput');
		expect(code(() => sql({ account: { secret: 'asc' } }, { as: 'workspace' }))).toBe('ok');
		const unread = { ...rep, collections: { ...rep.collections, accounts: undefined as never } };
		expect(code(() => sql({ account: { name: 'asc' } }, { as: 'caller', authority: unread }))).toBe('invalidInput');
		expect(code(() => sql({ account: { name: 'asc' } }, { as: 'caller', authority: { ...rep, admin: true } }))).toBe('ok');
	});
});

describe('bolt.decode (rule 11a in the browser, rule 16b)', () => {
	it('keeps valid conditions and sort keys, drops each invalid one alone with its path', () => {
		const out = decodeView(cat, 'orders', { where: { status: { eq: 'open' }, qty: {}, lines: { some: { amount: { gt: 'x' } } } }, orderBy: ['placed', 'tags', 'placed', { total: 'desc' }] });
		expect(out.where).toEqual({ status: { eq: 'open' } });
		expect(out.orderBy).toEqual(['placed', { total: 'desc' }]);
		expect(out.dropped.map((d) => d.path)).toEqual(['where.qty', 'where.lines', 'orderBy[1]', 'orderBy[2]']);
	});
	it('the client decodes against the shell boot exposure: relations included, unreadable fields dropped', () => {
		const bolt = createBolt({ actor: null, locale: 'en', catalog: exposure(manifest, rep), openStream: () => ({ close() {} }) as never });
		const out = bolt.decode('accounts', { where: { name: { like: 'a%' }, bogus: { isNull: true }, orders: { some: { status: { eq: 'open' } } } } });
		expect(out.where).toEqual({ name: { like: 'a%' }, orders: { some: { status: { eq: 'open' } } } });
		expect(out.dropped.map((d) => d.path)).toEqual(['where.bogus']);
		expect(browserCatalog(exposure(manifest, rep)).models.get('notes')?.one.get('about')?.targets).toEqual(['accounts', 'orders']);
	});
});
