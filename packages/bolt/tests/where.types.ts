// Type corpus for the P34 filter language (§3.3.9, rule 11a): each `@ts-expect-error` is a shape the decoder refuses too.
import type { OrderBy, Sortable, Where } from '../src/decl/where.ts';
import './types/registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const is = <T extends true>(): T => true as T;

const ok: Where<'orders'>[] = [
	{ due: { gte: { startOf: 'month' }, lt: { startOf: 'month', shift: 1 } } },       // this month
	{ placed_at: { gte: { startOf: 'week', shift: -1 }, lt: { startOf: 'week' } } },  // last week, on an instant
	{ lines: { sum: { of: 'amount', gte: 100 }, max: { of: 'qty', lt: '5' }, count: { gte: 1 } } },
	{ lines: { none: {} } },
];
const ok2: Where<'sites'>[] = [{ open: { overlaps: { from: { startOf: 'month' }, to: { today: '+0d' } } } }];
void ok; void ok2;
// @ts-expect-error P1 a count takes eq…gte only (rule 11a: type and decoder admit the same shapes)
const p1: Where<'customers'> = { sites: { count: { in: [1] } } };
// @ts-expect-error P2 `startOf` on text
const p2: Where<'orders'> = { note: { eq: { startOf: 'month' } } };
// @ts-expect-error P3 an aggregate of a text child field
const p3: Where<'orders'> = { lines: { sum: { of: 'item', gt: 1 } } };
// @ts-expect-error P4 min of a date literal compared with a number field's kind
const p4: Where<'orders'> = { lines: { min: { of: 'qty', gt: { today: '' } } } };
// @ts-expect-error P5 `startOf` in a static position is not a literal... nor a period end past `to`
const p5: Where<'sites'> = { open: { overlaps: { from: { startOf: 'month' } } } };
void p1; void p2; void p3; void p4; void p5;

// ── OrderBy<C> ──
is<Eq<Sortable<'sites'>, 'name' | 'customer' | 'created_at' | 'updated_at'>>();   // point, period and unexposed fields are not sortable
const o: OrderBy<'orders'>[] = ['due', { placed_at: 'desc' }, ['status', { created_at: 'asc' }]];
void o;
// @ts-expect-error O1 a vector field has no order
const o1: OrderBy<'orders'> = { colour: 'asc' };
// @ts-expect-error O2 one field per key
const o2: OrderBy<'orders'> = { due: 'asc', note: 'desc' };
// @ts-expect-error O3 a direction is asc or desc
const o3: OrderBy<'orders'> = { due: 'up' };
void o1; void o2; void o3;

// ── related sort keys: through one-relations, at most two hops; the target field is `Sortable` on its collection ──
const r: OrderBy<'orders'>[] = [{ customer: { name: 'asc' } }, [{ customer: { order_count: 'desc' } }, { due: 'asc' }], { customer: 'asc' }];
const r0: OrderBy<'order_lines'> = { order: { customer: { name: 'desc' } } };   // two hops
void r; void r0;
// @ts-expect-error R1 a many field on the target has no order
const r1: OrderBy<'orders'> = { customer: { tags: 'asc' } };
// @ts-expect-error R2 one field per related key
const r2: OrderBy<'orders'> = { customer: { name: 'asc', tier: 'desc' } };
// @ts-expect-error R3 `sites` exposes no relation to cross
const r3: OrderBy<'sites'> = { customer: { name: 'asc' } };
// @ts-expect-error R4 a direction is asc or desc
const r4: OrderBy<'orders'> = { customer: { name: 'up' } };
// @ts-expect-error R5 a dotted key is not the grammar
const r5: OrderBy<'orders'> = { 'customer.name': 'asc' };
// @ts-expect-error R6 the target's id is not a sort key (order by the relation itself)
const r6: OrderBy<'orders'> = { customer: { id: 'asc' } };
// @ts-expect-error R7 a field is not a hop
const r7: OrderBy<'order_lines'> = { order: { note: { name: 'asc' } } };
void r1; void r2; void r3; void r4; void r5; void r6; void r7;
