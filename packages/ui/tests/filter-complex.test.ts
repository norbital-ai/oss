import { describe, expect, it } from '@effect/vitest';
import { Decimal } from '@norbital-ai/std/decimal';
import { fromWhere, toWhere } from '../src/filter/where.ts';
import { matches } from '../src/filter/local.ts';
import { taggedArg, type Node } from '../src/filter/node.ts';
import type { ModelExposure } from '../src/kinds/context.ts';
import type { Json } from '@norbital-ai/std/wire';
const catalog: Record<string, ModelExposure> = {
	accounts: {
		record_label: 'record.name',
		label: ['name'],
		fields: { name: { kind: 'text' }, active: { kind: 'bool' } },
		many: ['orders']
	},
	orders: {
		record_label: 'record.placed_on',
		label: ['placed_on'],
		fields: { placed_on: { kind: 'date' }, status: { kind: 'text' }, amount: { kind: 'number' } },
		relations: { account_id: { targets: ['accounts'], inverse: 'orders' } }
	}
};
const nodes = (where: Json) => {
	const out = fromWhere(catalog, 'accounts', where);
	if (out === null) throw Error('Valid filter rejected');
	return out;
};
const match = (where: Json, row: Parameters<typeof matches>[0]) =>
	nodes(where).every((n) => matches(row, n));
describe('complex filters in the editor and local arrays', () => {
	it('preserves both boundaries on count and aggregate ranges', () => {
		const ranges: Json[] = [
			{ orders: { count: { gte: 1, lte: 3 } } },
			{ orders: { sum: { of: 'amount', gte: 1000, lte: 3000 } } }
		];
		for (const where of ranges) {
			const read = nodes(where);
			expect(read).toHaveLength(2);
			expect(read.every((n) => toWhere(catalog, 'accounts', n) !== null)).toBe(true);
		}
		expect(match({ orders: { count: { gte: 1, lte: 3 } } }, { orders: [] })).toBe(false);
		expect(match({ orders: { count: { gte: 1, lte: 3 } } }, { orders: [{}, {}] })).toBe(true);
		expect(match({ orders: { count: { gte: 1, lte: 3 } } }, { orders: [{}, {}, {}, {}] })).toBe(
			false
		);
	});
	it('round trips and evaluates date min/max aggregates as dates', () => {
		const where = { orders: { max: { of: 'placed_on', lt: '2026-09-01' } } };
		const [node] = nodes(where);
		expect(node).toBeDefined();
		if (node) expect(toWhere(catalog, 'accounts', node)).toEqual(where);
		expect(
			match(where, { orders: [{ placed_on: '2026-08-20' }, { placed_on: '2026-09-02' }] })
		).toBe(false);
		expect(match(where, { orders: [{ placed_on: '2026-08-20' }] })).toBe(true);
		expect(match(where, { orders: [] })).toBe(false);
	});
	it('keeps same-child predicates together and handles nested empty-list alternatives', () => {
		const same: Json = {
			orders: { some: { and: [{ status: { eq: 'open' } }, { placed_on: { lt: '2026-09-01' } }] } }
		};
		expect(
			match(same, {
				orders: [
					{ status: 'open', placed_on: '2026-10-01' },
					{ status: 'closed', placed_on: '2026-08-01' }
				]
			})
		).toBe(false);
		expect(match(same, { orders: [{ status: 'open', placed_on: '2026-08-01' }] })).toBe(true);
		const nested: Json = {
			and: [
				{ active: { eq: true } },
				{
					or: [
						{ orders: { count: { eq: 0 } } },
						{ orders: { every: { status: { eq: 'fulfilled' } } } }
					]
				}
			]
		};
		expect(match(nested, { active: true, orders: [] })).toBe(true);
		expect(match(nested, { active: false, orders: [] })).toBe(false);
		expect(match(nested, { active: true, orders: [{ status: 'open' }] })).toBe(false);
	});
	it('computes sums exactly and compares averages without rounding a quotient', () => {
		const row = { orders: [{ amount: Decimal.of('0.1') }, { amount: Decimal.of('0.2') }] };
		expect(match({ orders: { sum: { of: 'amount', eq: 0.3 } } }, row)).toBe(true);
		expect(match({ orders: { avg: { of: 'amount', gt: 0.14 } } }, row)).toBe(true);
		expect(match({ orders: { avg: { of: 'amount', eq: 0.15 } } }, row)).toBe(true);
		expect(match({ orders: { sum: { of: 'amount', eq: 0 } } }, { orders: [] })).toBe(true);
		expect(match({ orders: { avg: { of: 'amount', gt: 0 } } }, { orders: [] })).toBe(false);
	});
	it('evaluates date intervals rather than accepting every row', () => {
		const range: Node = {
			t: 'cond',
			path: 'date',
			op: 'during',
			arg: taggedArg({ range: ['2026-09-01', '2026-10-01'] })
		};
		expect(matches({ date: '2026-09-01' }, range)).toBe(true);
		expect(matches({ date: '2026-10-01' }, range)).toBe(false);
	});
	it('never silently accepts unloaded relations or unsupported local predicates, including under NOT', () => {
		const rel: Node = { t: 'many', rel: 'orders', q: 'none', of: [] };
		expect(() => matches({}, rel)).toThrow(/must be loaded/);
		expect(() => matches({}, { t: 'group', join: 'and', not: true, of: [rel] })).toThrow(
			/must be loaded/
		);
		expect(() =>
			matches({}, { t: 'cond', path: '$search', op: 'search', arg: taggedArg({ lit: 'pump' }) })
		).toThrow(/query engine/);
	});
});
