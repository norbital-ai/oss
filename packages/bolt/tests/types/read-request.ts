// Type corpus for nested read requests (P3): roots are models with `read`, deeper keys the layers a root declares, the
// answer typed from the named layers. Each `@ts-expect-error` line is a planted mistake.
import type { CallerQuery, Decimal, Id, Instant, ReadAnswer } from '../../src/index.ts';
import type { Eff, WriteTarget } from '../../src/decl/ctx.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(..._proof: T extends true ? [] : never): void => {};

declare const ctx: CallerQuery;
type Success<X> = X extends Eff<infer A, infer _E> ? A : never;

// ── the answer: per root a page of layer rows; a named ref layer replaces its FK, a many-layer lists its rows ──
type Answer = ReadAnswer<{
	readonly orders: {
		readonly fields: readonly ['number', 'customer'];
		readonly customer: { readonly fields: readonly ['name'] };
		readonly lines: {};
	};
	readonly notices: { readonly limit: 1 };
}>;
type Order = Answer['orders']['rows'][number];
is<
	Eq<Exclude<keyof Order, '$sync' | '$approval' | '$label'>, 'id' | 'number' | 'customer' | 'lines'>
>();
is<Eq<NonNullable<Order['customer']>['id'], Id<'customers'>>>();
is<Eq<NonNullable<Order['customer']>['name'], string>>();
is<Eq<Extract<Order['customer'], null>, null>>();
is<Eq<Order['lines'][number]['id'], Id<'order_lines'>>>();
is<Eq<'notices' extends keyof Answer ? 1 : 0, 1>>();
// a root page counts every row it matches
is<Eq<Answer['orders']['total'], number>>();
// A child belongs to its actual parent node; fields at one node never become nested relation names.
type Picked = ReadAnswer<{ readonly orders: { readonly lines: { readonly fields: readonly ['item'] } } }>;
is<Eq<Picked['orders']['rows'][number]['lines'][number]['item'], string>>();
is<Eq<Exclude<keyof Picked['orders']['rows'][number]['lines'][number], 'id'>, 'item'>>();
is<Eq<ReadAnswer<{ readonly orders: { readonly fields: readonly ['customer'] } }>['orders']['rows'][number]['customer'], Id<'customers'>>>();
// a layer field is the output's plain value: policies filter rows, never mask a field
type Tier = NonNullable<
	ReadAnswer<{ readonly orders: { readonly customer: {} } }>['orders']['rows'][number]['customer']
>['tier'];
is<Eq<Tier, 'basic' | 'gold'>>();
// a root naming an output reads that output's fixed fields and layers
type Logistics = ReadAnswer<{
	readonly orders: { readonly output: 'logistics'; readonly lines: {} };
}>['orders']['rows'][number];
type System = 'id' | 'revision' | 'created_at' | 'updated_at' | 'created_by' | 'updated_by';
is<
	Eq<
		Exclude<keyof Logistics, System | '$sync' | '$approval' | '$label'>,
		'number' | 'status' | 'customer' | 'lines'
	>
>();
is<Eq<Exclude<keyof Logistics['lines'][number], System>, 'item' | 'qty'>>();
// a grouped aggregate always carries each bucket's row count; an ungrouped one only when asked
type Grouped = ReadAnswer<{ readonly orders: { readonly aggregate: { readonly by: 'status' } } }>;
is<Eq<Grouped['orders']['rows'][number]['count'], number>>();
type GroupedLayer = ReadAnswer<{
	readonly orders: { readonly lines: { readonly aggregate: {
		readonly by: readonly ['item', 'order', 'created_by'];
		readonly sum: readonly ['qty'];
		readonly avg: readonly ['price'];
		readonly min: readonly ['item', 'created_at'];
		readonly max: readonly ['qty'];
	} } };
}>;
type LayerBucket = GroupedLayer['orders']['rows'][number]['lines'][number];
is<Eq<LayerBucket['count'], number>>();
is<Eq<LayerBucket['key'], {
	readonly item: string;
	readonly order: Id<'orders'>;
	readonly created_by: Id<'sys_user'> | null;
}>>();
is<Eq<NonNullable<LayerBucket['sum']>['qty'], Decimal | null | undefined>>();
is<Eq<NonNullable<LayerBucket['avg']>['price'], Decimal | null | undefined>>();
is<Eq<NonNullable<LayerBucket['min']>['item'], string | null | undefined>>();
is<Eq<NonNullable<LayerBucket['min']>['created_at'], Instant | null | undefined>>();
is<Eq<NonNullable<LayerBucket['max']>['qty'], Decimal | null | undefined>>();
type UngroupedLayer = ReadAnswer<{
	readonly orders: { readonly lines: { readonly aggregate: { readonly min: readonly ['item'] } } };
}>['orders']['rows'][number]['lines'];
is<Eq<UngroupedLayer['count'], number | undefined>>();
is<Eq<'key' extends keyof UngroupedLayer ? true : false, false>>();
is<Eq<NonNullable<UngroupedLayer['min']>['item'], string | null | undefined>>();
type LogisticsAggregate = ReadAnswer<{
	readonly orders: { readonly output: 'logistics'; readonly lines: { readonly aggregate: {
		readonly by: 'item'; readonly sum: readonly ['qty']; readonly max: readonly ['qty'];
	} } };
}>['orders']['rows'][number]['lines'][number];
is<Eq<LogisticsAggregate['key'], { readonly item: string }>>();
is<Eq<NonNullable<LogisticsAggregate['sum']>['qty'], Decimal | null | undefined>>();
is<Eq<'price' extends keyof NonNullable<LogisticsAggregate['sum']> ? true : false, false>>();
is<Eq<'price' extends keyof NonNullable<LogisticsAggregate['max']> ? true : false, false>>();
type Ungrouped = ReadAnswer<{
	readonly orders: { readonly aggregate: { readonly sum: readonly ['total'] } };
}>;
is<Eq<Ungrouped['orders']['count'], number | undefined>>();

// Generic model projections retain the same concrete target brands and revision requirements.
is<Eq<WriteTarget<'orders'>['id'], Id<'orders'>>>();
is<Eq<WriteTarget<'orders'>['revision'], number>>();
is<Eq<WriteTarget<'sys_user'>['id'], Id<'sys_user'>>>();
is<Eq<WriteTarget<'sys_user'>['revision'], number | undefined>>();
is<Eq<WriteTarget<'orders'> extends WriteTarget<'customers'> ? true : false, false>>();

const inferred = ctx.query({ orders: {
	fields: ['number'],
	customer: { fields: ['name'] },
	lines: { fields: ['item', 'qty'] }
} });
type InferredOrder = Success<typeof inferred>['orders']['rows'][number];
is<Eq<InferredOrder['id'], Id<'orders'>>>();
is<Eq<NonNullable<InferredOrder['customer']>['name'], string>>();
is<Eq<InferredOrder['lines'][number]['id'], Id<'order_lines'>>>();
is<Eq<InferredOrder['lines'][number]['qty'], Decimal>>();
is<Eq<'fields' extends keyof InferredOrder ? true : false, false>>();

// ── valid calls ──
export const reads = [
	ctx.query({
		orders: {
			where: { status: { eq: 'draft' } },
			fields: ['number', 'total'],
			order_by: 'due',
			limit: 100,
			lines: { where: { item: { ne: '' } }, limit: 50 },
			customer: {}
		},
		notices: { limit: 1 }
	}),
	ctx.query({
		orders: { aggregate: { count: true }, lines: { aggregate: { sum: ['qty'] } } }
	}),
	ctx.query({
		orders: { output: 'logistics', where: { status: { eq: 'submitted' } }, fields: ['number'],
			lines: { where: { qty: { gt: 0 } } } }
	}),
	ctx.query({ orders: { output: 'default', customer: {} } }),
	ctx.query({ orders: { lines: { aggregate: {
		by: ['item', 'order', 'created_by'], sum: ['qty', 'price'], avg: ['amount'], min: ['item', 'created_at'], max: ['qty']
	} } } }),
	ctx.query({ orders: { output: 'logistics', lines: { aggregate: { by: 'item', sum: ['qty'], avg: ['qty'], max: ['qty'] } } } })
];

// ── refused ──
// @ts-expect-error a root that is no model with `read`
ctx.query({ sys_session: {} });
// @ts-expect-error a path the root does not declare
ctx.query({ orders: { owner: {} } });
// @ts-expect-error a sixth level is no declared path
ctx.query({ orders: { lines: { order: { lines: { order: { lines: {} } } } } } });
// @ts-expect-error an unknown option
ctx.query({ orders: { limt: 5 } });
// @ts-expect-error a field from another layer
ctx.query({ orders: { customer: { fields: ['note'] } } });
// @ts-expect-error `as_of` belongs to a root
ctx.query({ orders: { lines: { as_of: '2026-01-01T00:00:00Z' } } });
// @ts-expect-error a read request is JSON: no function value
ctx.query({ orders: { where: () => ({}) } });
// @ts-expect-error a layer `where` over a field that layer does not expose (orders.customer exposes name and tier)
ctx.query({ orders: { customer: { where: { email: { eq: 'a@b.c' } } } } });
// @ts-expect-error a root `where` cannot name a field outside the model
ctx.query({ orders: { where: { secret: { eq: 1 } } } });
// @ts-expect-error an output the model does not declare
ctx.query({ orders: { output: 'full' } });
// @ts-expect-error a layer outside the named output (logistics declares no orders.customer)
ctx.query({ orders: { output: 'logistics', customer: {} } });
// @ts-expect-error a field outside the named output
ctx.query({ orders: { output: 'logistics', fields: ['note'] } });
// @ts-expect-error a root `where` over a field outside the named output
ctx.query({ orders: { output: 'logistics', where: { note: { is_null: true } } } });
// @ts-expect-error a nested sum requires a scalar numeric child field
ctx.query({ orders: { lines: { aggregate: { sum: ['item'] } } } });
// @ts-expect-error foreign keys retain their identity type and are not numeric measures
ctx.query({ orders: { lines: { aggregate: { avg: ['order'] } } } });
// @ts-expect-error a nested measure cannot read a numeric field outside the selected output
ctx.query({ orders: { output: 'logistics', lines: { aggregate: { sum: ['price'] } } } });
// @ts-expect-error minimum/maximum fields also belong to the selected layer output
ctx.query({ orders: { output: 'logistics', lines: { aggregate: { max: ['price'] } } } });
