// Type corpus for layer-map read requests (P3): roots are models with `read`, deeper keys the layers a root declares, the
// answer typed from the named layers. Each `@ts-expect-error` line is a planted mistake.
import type { CallerQuery, Id, ReadAnswer } from '../../src/index.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(): T => true as T;

declare const ctx: CallerQuery;

// ── the answer: per root a page of layer rows; a named ref layer replaces its FK, a many-layer lists its rows ──
type Answer = ReadAnswer<{
	readonly orders: { readonly fields: readonly ['number', 'customer'] };
	readonly 'orders.customer': { readonly fields: readonly ['name'] };
	readonly 'orders.lines': {};
	readonly notices: { readonly limit: 1 };
}>;
type Order = Answer['orders']['rows'][number];
is<Eq<Exclude<keyof Order, '$sync' | '$approval'>, 'id' | 'number' | 'customer' | 'lines'>>();
is<Eq<NonNullable<Order['customer']>['id'], Id<'customers'>>>();
is<Eq<NonNullable<Order['customer']>['name'], string>>();
is<Eq<Order['lines'][number]['id'], Id<'order_lines'>>>();
is<Eq<'notices' extends keyof Answer ? 1 : 0, 1>>();
// a root page counts every row it matches
is<Eq<Answer['orders']['total'], number>>();
// a deep path implies its parents, the root included
type Implied = ReadAnswer<{ readonly 'orders.lines': { readonly fields: readonly ['item'] } }>;
is<Eq<Implied['orders']['rows'][number]['lines'][number]['item'], string>>();
// a layer field is the output's plain value: policies filter rows, never mask a field
type Tier = NonNullable<
	ReadAnswer<{ readonly 'orders.customer': {} }>['orders']['rows'][number]['customer']
>['tier'];
is<Eq<Tier, 'basic' | 'gold'>>();
// a root naming an output reads that output's fixed fields and layers
type Logistics = ReadAnswer<{
	readonly orders: { readonly output: 'logistics' };
	readonly 'orders.lines': {};
}>['orders']['rows'][number];
type System = 'id' | 'revision' | 'created_at' | 'updated_at' | 'created_by' | 'updated_by';
is<Eq<Exclude<keyof Logistics, System | '$sync' | '$approval'>, 'number' | 'status' | 'customer' | 'lines'>>();
is<Eq<Exclude<keyof Logistics['lines'][number], System>, 'item' | 'qty'>>();
// a grouped aggregate always carries each bucket's row count; an ungrouped one only when asked
type Grouped = ReadAnswer<{ readonly orders: { readonly aggregate: { readonly by: 'status' } } }>;
is<Eq<Grouped['orders']['rows'][number]['count'], number>>();
type GroupedLayer = ReadAnswer<{
	readonly 'orders.lines': { readonly aggregate: { readonly by: 'item' } };
}>;
is<Eq<GroupedLayer['orders']['rows'][number]['lines'][number]['count'], number>>();
type Ungrouped = ReadAnswer<{
	readonly orders: { readonly aggregate: { readonly sum: readonly ['total'] } };
}>;
is<Eq<Ungrouped['orders']['count'], number | undefined>>();

// ── valid calls ──
export const reads = [
	ctx.query({
		orders: {
			where: { status: { eq: 'draft' } },
			fields: ['number', 'total'],
			orderBy: 'due',
			limit: 100
		},
		'orders.lines': { where: { item: { ne: '' } }, limit: 50 },
		'orders.customer': {},
		notices: { limit: 1 }
	}),
	ctx.query({
		orders: { aggregate: { count: true } },
		'orders.lines': { aggregate: { sum: ['qty'] } }
	}),
	ctx.query({
		orders: { output: 'logistics', where: { status: { eq: 'submitted' } }, fields: ['number'] },
		'orders.lines': { where: { qty: { gt: 0 } } }
	}),
	ctx.query({ orders: { output: 'default' }, 'orders.customer': {} })
];

// ── refused ──
// @ts-expect-error a root that is no model with `read`
ctx.query({ sys_session: {} });
// @ts-expect-error a path the root does not declare
ctx.query({ 'orders.owner': {} });
// @ts-expect-error a sixth level is no declared path
ctx.query({ 'orders.lines.order.lines.order.lines': {} });
// @ts-expect-error an unknown option
ctx.query({ orders: { limt: 5 } });
// @ts-expect-error a field from another layer
ctx.query({ 'orders.customer': { fields: ['note'] } });
// @ts-expect-error `asOf` belongs to a root
ctx.query({ 'orders.lines': { asOf: '2026-01-01T00:00:00Z' } });
// @ts-expect-error a read request is JSON: no function value
ctx.query({ orders: { where: () => ({}) } });
// @ts-expect-error a layer `where` over a field that layer does not expose (orders.customer exposes name and tier)
ctx.query({ orders: {}, 'orders.customer': { where: { email: { eq: 'a@b.c' } } } });
// @ts-expect-error a root `where` cannot name a field outside the model
ctx.query({ orders: { where: { secret: { eq: 1 } } } });
// @ts-expect-error an output the model does not declare
ctx.query({ orders: { output: 'full' } });
// @ts-expect-error a layer outside the named output (logistics declares no orders.customer)
ctx.query({ orders: { output: 'logistics' }, 'orders.customer': {} });
// @ts-expect-error a field outside the named output
ctx.query({ orders: { output: 'logistics', fields: ['note'] } });
// @ts-expect-error a root `where` over a field outside the named output
ctx.query({ orders: { output: 'logistics', where: { note: { isNull: true } } } });
