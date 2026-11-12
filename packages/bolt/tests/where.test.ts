// Rule 11a: the strict `Where`/`OrderBy` decoder, materialized time bounds, child aggregates, json contains, `bolt.decode`.
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import type { Reader, RowData } from '../src/engine/contracts.ts';
import { browser_catalog, catalog } from '../src/protocol/catalog.ts';
import { contains, evaluate, midnight, startOfDate } from '../src/engine/query/eval.ts';
import {
	catalog_for,
	compile,
	decode_view,
	order,
	read,
	where,
	type Pred
} from '@norbital-ai/store';
import { readOptions } from '../src/engine/query/reader.ts';
import { create_bolt } from '../src/page/bolt.ts';
import { exposure } from '../src/engine/access/exposure.ts';
import { bindings, clerk, manifest, rep } from './query.fixture.ts';

const present = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Missing fixture value');
	return value;
};

const cat = catalog(manifest);
const code = <E extends { readonly code: string }>(effect: Effect.Effect<unknown, E>) =>
	effect.pipe(
		Effect.as('ok'),
		Effect.catch((error) => Effect.succeed(error.code))
	);
const nest = (n: number): object => (n === 0 ? { qty: { eq: 1 } } : { not: nest(n - 1) });

describe('one invalid row per shape', () => {
	const rows: [string, string, object][] = [
		['orders', 'empty operator object on a field', { status: {} }],
		['orders', 'eq: undefined (on the wire: {})', { status: { eq: undefined } }],
		['accounts', 'empty many-relation', { orders: {} }],
		['orders', 'empty one-relation', { account: {} }],
		['orders', 'empty one-relation is', { account: { is: {} } }],
		['orders', 'not: {}', { not: {} }],
		['orders', 'empty and element', { and: [{}] }],
		['orders', 'is_null not a boolean', { note: { is_null: 'yes' } }],
		['orders', 'isEmpty not a boolean', { tags: { isEmpty: 'x' } }],
		['orders', 'eq: null', { note: { eq: null } }],
		['orders', 'decimal literal of the wrong type', { total: { eq: 'abc' } }],
		['orders', 'int literal of the wrong type', { qty: { gt: 1.5 } }],
		['orders', 'undeclared enum value', { status: { eq: 'bogus' } }],
		['orders', 'bad ISO date', { placed: { eq: '2026-02-30' } }],
		['orders', 'bad instant', { at: { lt: 'soon' } }],
		['orders', 'decimal tag with extra keys', { total: { eq: { $dec: '1.20', extra: true } } }],
		['orders', 'malformed decimal tag', { total: { eq: { $dec: '1e3' } } }],
		[
			'orders',
			'reversed date period',
			{ span: { overlaps: { from: '2026-01-02', to: '2026-01-01' } } }
		],
		['orders', 'former parameter operand', { span: { overlaps: { param: 'window' } } }],
		['orders', 'former actor operand', { note: { eq: { actor: 'id' } } }],
		['orders', 'time variable', { placed: { gte: { var: 'today - days(7)' } } }],
		['orders', 'requestor email on a date', { placed: { eq: { var: 'requestor.email' } } }],
		['orders', 'unknown requestor member', { note: { eq: { var: 'requestor.boss' } } }],
		['orders', 'id not a uuid', { account: { eq: 'x' } }],
		['orders', 'in not a list', { status: { in: 'open' } }],
		['orders', 'hasAny not a list', { tags: { hasAny: 'a' } }],
		['orders', 'retired nin', { status: { nin: ['open'] } }],
		['orders', 'retired hasAll', { tags: { hasAll: ['a'] } }],
		['orders', 'retired hasAny', { tags: { hasAny: ['a'] } }],
		['orders', 'retired isEmpty', { tags: { isEmpty: true } }],
		[
			'orders',
			'list past WHERE_MAX_LIST',
			{ qty: { in: Array.from({ length: 1001 }, (_, i) => i) } }
		],
		['accounts', 'count not an integer', { orders: { count: { eq: 1.5 } } }],
		['accounts', 'count negative', { orders: { count: { gte: -1 } } }],
		['accounts', 'count with in', { orders: { count: { in: [1] } } }],
		['orders', 'near not [point, metres]', { spot: { near: 'x' } }],
		['orders', 'near negative', { spot: { near: [{ lat: 1, lng: 1 }, -5] } }],
		[
			'orders',
			'polygon of two points',
			{
				spot: {
					within: {
						polygon: [
							{ lat: 1, lng: 1 },
							{ lat: 2, lng: 2 }
						]
					}
				}
			}
		],
		['orders', 'period literal with one end', { span: { overlaps: { from: '2026-09-01' } } }],
		['orders', 'now on a date', { placed: { eq: { now: '' } } }],
		['orders', 'today on an instant', { at: { lt: { today: '' } } }],
		['orders', 'startOf on text', { note: { eq: { startOf: 'month' } } }],
		['orders', 'startOf with a bad unit', { placed: { gte: { startOf: 'fortnight' } } }],
		['orders', 'actor id on a non-member id', { account: { eq: { var: 'requestor.id' } } }],
		['orders', 'actor email on plain text', { note: { eq: { var: 'requestor.email' } } }],
		['orders', 'teams outside in/nin', { account: { eq: { var: 'requestor.teams' } } }],
		['orders', 'field operand of another family', { total: { gt: { field: 'note' } } }],
		['orders', 'bad offset', { placed: { gte: { today: '+-5d' } } }],
		['accounts', 'relation without a quantifier', { orders: { status: { eq: 'open' } } }],
		['orders', 'aggregate of a text field', { lines: { sum: { of: 'sku', gt: 1 } } }],
		['orders', 'aggregate with no comparison', { lines: { sum: { of: 'amount' } } }],
		[
			'orders',
			'aggregate literal of the wrong type',
			{ lines: { max: { of: 'amount', gt: 'x' } } }
		],
		['orders', 'json contains on a text field', { note: { contains: 'x' } }],
		['orders', 'nested past WHERE_MAX_DEPTH', nest(17)]
	];
	it.effect.each(rows)('%s: %s', ([m, _, w]) =>
		Effect.gen(function* () {
			expect(yield* code(where(cat, m, w))).toBe('invalid');
		})
	);
	it.effect('the invalid names the path of the first fault', () =>
		Effect.gen(function* () {
			expect(
				(yield* Effect.flip(
					where(cat, 'accounts', {
						orders: { some: { lines: { every: { amount: { gt: 'x' } } } } }
					})
				)).message
			).toMatch(/where\.orders\.some\.lines\.every\.amount\.gt/);
		})
	);
	it.effect(
		'a bare value is eq, a list in and null is_null, as a person writes it; a bad value is still refused',
		() =>
			Effect.gen(function* () {
				expect(yield* where(cat, 'orders', { status: 'open' })).toEqual(
					yield* where(cat, 'orders', { status: { eq: 'open' } })
				);
				expect(yield* where(cat, 'orders', { status: ['open'] })).toEqual(
					yield* where(cat, 'orders', { status: { in: ['open'] } })
				);
				expect(yield* where(cat, 'orders', { note: null })).toEqual(
					yield* where(cat, 'orders', { note: { is_null: true } })
				);
				expect(yield* code(where(cat, 'orders', { status: 'bogus' }))).toBe('invalid');
				const account = '0199a000-0000-4000-8000-0000000000a1';
				expect(yield* where(cat, 'orders', { account })).toEqual(
					yield* where(cat, 'orders', { account: { eq: account } })
				);
			})
	);
	it.effect('an empty Where is valid at the root and as a quantifier body', () =>
		Effect.gen(function* () {
			expect(yield* where(cat, 'orders', {})).toEqual({ t: 'const', value: true });
			expect(yield* code(where(cat, 'accounts', { orders: { none: {} } }))).toBe('ok');
			expect(yield* code(where(cat, 'orders', nest(16)))).toBe('ok');
		})
	);
});

describe('one wire literal per kind', () => {
	const instants = catalog({
		...manifest,
		models: {
			clock: {
				description: 'Clock intervals',
				record_label: 'record.at',
				fields: {
					at: { kind: 'instant' },
					slot: { kind: 'period', of: 'instant' }
				}
			}
		},
		relationships: {},
		exposures: { clock: { outputs: { default: { clock: { fields: 'all' } } } } }
	});
	it.effect('keeps exact decimal text and scale through the canonical tag and shorthand', () =>
		Effect.gen(function* () {
			const value = { $dec: '9007199254740993.123456789000' };
			const expected = {
				t: 'cmp',
				field: 'total',
				op: 'eq',
				arg: { _tag: 'Lit', value }
			} satisfies Pred;
			expect(yield* where(cat, 'orders', { total: { eq: value } })).toEqual(expected);
			expect(yield* where(cat, 'orders', { total: value })).toEqual(expected);
		})
	);
	it.effect('preserves ISO date, instant and open date-period values', () =>
		Effect.gen(function* () {
			expect(yield* where(cat, 'orders', { placed: '2026-01-02' })).toEqual({
				t: 'cmp',
				field: 'placed',
				op: 'eq',
				arg: { _tag: 'Lit', value: '2026-01-02' }
			} satisfies Pred);
			expect(yield* where(cat, 'orders', { at: { eq: '2026-01-02T03:04:05.123Z' } })).toEqual({
				t: 'cmp',
				field: 'at',
				op: 'eq',
				arg: { _tag: 'Lit', value: '2026-01-02T03:04:05.123Z' }
			} satisfies Pred);
			expect(
				yield* where(cat, 'orders', { span: { overlaps: { from: '2026-01-01', to: null } } })
			).toEqual({
				t: 'period',
				field: 'span',
				op: 'overlaps',
				lo: { _tag: 'Lit', value: '2026-01-01' },
				hi: { _tag: 'Lit', value: null }
			} satisfies Pred);
		})
	);
	it.effect('preserves instant-period ends and compares their actual instants', () =>
		Effect.gen(function* () {
			const value = { start: '2026-01-02T10:00:00.123+08:00', end: '2026-01-02T03:00:00.456Z' };
			expect(yield* where(instants, 'clock', { slot: { contained_by: value } })).toEqual({
				t: 'period',
				field: 'slot',
				op: 'contained_by',
				lo: { _tag: 'Lit', value: value.start },
				hi: { _tag: 'Lit', value: value.end }
			} satisfies Pred);
			expect(
				yield* where(instants, 'clock', { slot: { overlaps: { start: value.start, end: null } } })
			).toEqual({
				t: 'period',
				field: 'slot',
				op: 'overlaps',
				lo: { _tag: 'Lit', value: value.start },
				hi: { _tag: 'Lit', value: null }
			} satisfies Pred);
			expect(
				yield* code(
					where(instants, 'clock', { slot: { overlaps: { start: value.end, end: value.start } } })
				)
			).toBe('invalid');
		})
	);
});

describe('the widened language', () => {
	it('materializes Monday weeks, months, quarters, years and zoned midnight as ISO values', () => {
		expect(startOfDate({ unit: 'week' }, '2026-09-27')).toBe('2026-09-21'); // a Sunday belongs to the week of Monday the 21st
		expect(startOfDate({ unit: 'week', shift: -1 }, '2026-09-21')).toBe('2026-09-14');
		expect(startOfDate({ unit: 'month', shift: 1 }, '2026-12-15')).toBe('2027-01-01');
		expect(startOfDate({ unit: 'quarter', shift: -1 }, '2026-02-10')).toBe('2025-10-01');
		expect(startOfDate({ unit: 'year' }, '2026-09-25')).toBe('2026-01-01');
		expect(midnight('2026-09-01', 'Asia/Kuala_Lumpur')).toBe('2026-08-31T16:00:00.000Z');
		expect(midnight('2026-03-29', 'Europe/Berlin')).toBe('2026-03-28T23:00:00.000Z');
	});
	it.effect('decodes materialized date, period and instant bounds identically in SQL and JS', () =>
		Effect.gen(function* () {
			const month = startOfDate({ unit: 'month' }, bindings.today);
			const nextMonth = startOfDate({ unit: 'month', shift: 1 }, bindings.today);
			const week = midnight(startOfDate({ unit: 'week' }, bindings.today), bindings.tz);
			const filter = {
				placed: { gte: month, lt: nextMonth },
				span: { overlaps: { from: month, to: bindings.today } },
				at: { gte: week }
			};
			const p = yield* where(cat, 'orders', filter);
			const env = { cat, bindings };
			const row = {
				id: 'x',
				placed: '2026-09-02',
				span: { from: '2026-08-20', to: '2026-09-01' },
				at: '2026-09-21T00:00:00.000Z'
			};
			expect(evaluate(env, 'orders', p, row)).toBe(true);
			expect(evaluate(env, 'orders', p, { ...row, placed: '2026-08-31' })).toBe(false);
			expect(evaluate(env, 'orders', p, { ...row, at: '2026-09-20T15:59:59.000Z' })).toBe(false); // before Monday 00:00 in KL
			const sql = (yield* compile(
				cat,
				yield* read(cat, 'orders', { limit: 1, where: filter }),
				readOptions({ as: 'workspace' }, bindings)
			)).sql;
			expect(sql.params).toContain(month);
			expect(sql.params).toContain(nextMonth);
			expect(sql.params).toContain(week);
		})
	);
	it.effect('child aggregates: sum of none is 0, min/max/avg of none match nothing', () =>
		Effect.gen(function* () {
			const env = {
				cat,
				bindings,
				related: (_c: string, _r: string, _t: string, row: RowData): RowData[] =>
					row.id === 'a'
						? []
						: [
								{ id: 'l1', amount: { $dec: '10.10' } },
								{ id: 'l2', amount: '10.20' }
							]
			};
			const is = (w: object, id: string) =>
				where(cat, 'orders', w).pipe(Effect.map((p) => evaluate(env, 'orders', p, { id })));
			expect(yield* is({ lines: { sum: { of: 'amount', eq: 0 } } }, 'a')).toBe(true);
			expect(yield* is({ lines: { avg: { of: 'amount', ne: 1 } } }, 'a')).toBe(false);
			expect(yield* is({ lines: { sum: { of: 'amount', eq: '20.3' } } }, 'b')).toBe(true);
			expect(
				yield* is(
					{ lines: { max: { of: 'amount', gte: '10.2' }, min: { of: 'amount', lt: 10.2 } } },
					'b'
				)
			).toBe(true);
		})
	);
	it.effect('json contains is jsonb @>', () =>
		Effect.gen(function* () {
			expect(yield* where(cat, 'orders', { doc: { contains: { big: 'x' } } })).toEqual({
				t: 'json',
				field: 'doc',
				contains: { big: 'x' }
			} satisfies Pred);
			expect(contains({ a: [1, 2, { b: null }], c: 'x' }, { a: [{ b: null }, 2] }, true)).toBe(
				true
			);
			expect(contains([1, 2], 2, true)).toBe(true);
			expect(contains({ a: 1 }, { a: 2 }, true)).toBe(false);
		})
	);
	it.effect('OrderBy: at most 4 keys, one field each, no field twice, sortable fields only', () =>
		Effect.gen(function* () {
			expect(
				yield* order([{ total: 'desc' }, 'placed', { created_at: 'asc' }], cat, 'orders')
			).toEqual([
				{ field: 'total', dir: 'desc' },
				{ field: 'placed', dir: 'asc' },
				{ field: 'created_at', dir: 'asc' }
			]);
			for (const bad of [
				['qty', 'placed', 'at', 'total', 'note'],
				['qty', { qty: 'desc' }],
				{ qty: 'asc', at: 'desc' },
				'tags',
				'span',
				'doc',
				'spot',
				'revision',
				{ qty: 'up' }
			])
				expect(yield* code(order(bad, cat, 'orders'))).toBe('invalid');
		})
	);
	it.effect(
		'OrderBy: a related key nests through one-relations (≤ 2 hops) to a sortable target field; the IR path is dotted',
		() =>
			Effect.gen(function* () {
				expect(
					yield* order(
						[{ account: { name: 'asc' } }, { account: { region: 'desc' } }, 'account'],
						cat,
						'orders'
					)
				).toEqual([
					{ field: 'account.name', dir: 'asc' },
					{ field: 'account.region', dir: 'desc' },
					{ field: 'account', dir: 'asc' }
				]);
				expect(yield* order({ order: { account: { name: 'desc' } } }, cat, 'lines')).toEqual([
					{ field: 'order.account.name', dir: 'desc' }
				]);
				for (const bad of [
					{ account: { name: 'asc', region: 'asc' } },
					{ account: {} },
					{ account: { name: 'up' } },
					{ account: { id: 'asc' } },
					{ account: { bogus: 'asc' } },
					{ 'account.name': 'asc' },
					'account.name',
					{ status: { name: 'asc' } },
					[{ account: { name: 'asc' } }, { account: { name: 'desc' } }]
				])
					expect(yield* code(order(bad, cat, 'orders'))).toBe('invalid');
				expect(yield* code(order({ about: { name: 'asc' } }, cat, 'notes'))).toBe('invalid'); // an arc is not a hop
				expect(
					yield* code(order({ order: { account: { name: { x: 'asc' } } } }, cat, 'lines'))
				).toBe('invalid'); // three hops
			})
	);
	it.effect(
		"a related key compiles to a subselect only through a layer the caller's output reads, else invalidInput",
		() =>
			Effect.gen(function* () {
				const sql = (order_by: unknown, reader: Reader = { as: 'caller', authority: rep }) =>
					read(cat, 'orders', { limit: 5, order_by }).pipe(
						Effect.flatMap((ir) => compile(cat, ir, readOptions(reader, bindings)))
					);
				const ok = (yield* sql({ account: { name: 'asc' } })).sql.text;
				expect(ok).toMatch(/ORDER BY \(SELECT \w+\."name" FROM "accounts"/);
				expect(ok).toMatch(/jsonb_build_array\(\(SELECT \w+\."name"/); // the cursor carries the related value
				expect(yield* code(sql({ account: { secret: 'asc' } }))).toBe('ok');
				// the `brief` output's account layer omits `secret`: no ordering by it
				const brief = yield* catalog_for(cat, 'orders', 'brief');
				const asClerk = (order_by: unknown) =>
					read(brief, 'orders', { limit: 5, order_by }).pipe(
						Effect.flatMap((ir) =>
							compile(
								brief,
								{ ...ir, output: 'brief' },
								readOptions({ as: 'caller', authority: clerk }, bindings)
							)
						)
					);
				expect(yield* code(asClerk({ account: { secret: 'asc' } }))).toBe('invalid_input');
				expect(yield* code(asClerk({ account: { name: 'asc' } }))).toBe('ok');
				// authority is per access point: the root's arms for its account layer decide, never the accounts model's own
				const orders = present(rep.models['orders']);
				const unread = {
					...rep,
					models: {
						...rep.models,
						orders: {
							...orders,
							read: {
								default: Object.fromEntries(
									Object.entries(present(orders.read['default'])).filter(
										([path]) => path === 'orders'
									)
								)
							}
						}
					}
				};
				expect(
					yield* code(sql({ account: { name: 'asc' } }, { as: 'caller', authority: unread }))
				).toBe('invalid_input');
				expect(
					yield* code(
						sql({ account: { name: 'asc' } }, { as: 'caller', authority: { ...rep, admin: true } })
					)
				).toBe('ok');
			})
	);
});

describe('bolt.decode in the browser', () => {
	it.effect(
		'keeps valid conditions and sort keys, drops each invalid one alone with its path',
		() =>
			Effect.gen(function* () {
				const out = yield* decode_view(cat, 'orders', {
					where: { status: { eq: 'open' }, qty: {}, lines: { some: { amount: { gt: 'x' } } } },
					order_by: ['placed', 'tags', 'placed', { total: 'desc' }]
				});
				expect(out.where).toEqual({ status: { eq: 'open' } });
				expect(out.order_by).toEqual(['placed', { total: 'desc' }]);
				expect(out.dropped.map((d) => d.path)).toEqual([
					'where.qty',
					'where.lines',
					'order_by[1]',
					'order_by[2]'
				]);
			})
	);
	it.effect(
		'the client decodes against the shell boot exposure: relations included, unreadable fields dropped',
		() =>
			Effect.gen(function* () {
				const bolt = yield* create_bolt({
					actor: null,
					locale: 'en',
					operation_outputs: { automations: {} },
					catalog: yield* exposure(manifest, rep),
					open_stream: () => ({ onmessage: null, onerror: null, close() {} })
				});
				const out = bolt.decode('accounts', {
					where: {
						name: { like: 'a%' },
						bogus: { is_null: true },
						orders: { some: { status: { eq: 'open' } } }
					}
				});
				expect(out.where).toEqual({
					name: { like: 'a%' },
					orders: { some: { status: { eq: 'open' } } }
				});
				expect(out.dropped.map((d) => d.path)).toEqual(['where.bogus']);
				expect(
					browser_catalog(yield* exposure(manifest, rep))
						.models.get('notes')
						?.one.get('about')?.targets
				).toEqual(['accounts', 'orders']);
			})
	);
});
