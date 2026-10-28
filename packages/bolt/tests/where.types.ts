// Type corpus for the P34 filter language (§3.3.9, rule 11a): each `@ts-expect-error` is a shape the decoder refuses too.
import { datePeriod, Instant, PlainDate } from '@norbital-ai/std/date';
import type { OrderBy, Sortable, Where } from '../src/decl/where.ts';
import './types/registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(value: T): T => value;

const ok: Where<'orders'>[] = [
	{ due: { gte: PlainDate('2026-03-01'), lt: PlainDate('2026-04-01') } }, // a materialized month
	{
		placed_at: {
			gte: Instant('2026-03-16T00:00:00.000Z'),
			lt: Instant('2026-03-23T00:00:00.000Z')
		}
	}, // a materialized week, on an instant
	{ lines: { sum: { of: 'amount', gte: 100 }, max: { of: 'qty', lt: '5' }, count: { gte: 1 } } },
	{ lines: { none: {} } }
];
const ok2: Where<'sites'>[] = [{ open: { overlaps: datePeriod('2026-03-01', '2026-03-25') } }];
void ok;
void ok2;
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
void p1;
void p2;
void p3;
void p4;
void p5;

// ── OrderBy<C> ──
is<Eq<Sortable<'sites'>, 'name' | 'customer' | 'created_at' | 'updated_at'>>(true); // point, period and unexposed fields are not sortable
const o: OrderBy<'orders'>[] = ['due', { placed_at: 'desc' }, ['status', { created_at: 'asc' }]];
void o;
// @ts-expect-error O1 a vector field has no order
const o1: OrderBy<'orders'> = { colour: 'asc' };
// @ts-expect-error O2 one field per key
const o2: OrderBy<'orders'> = { due: 'asc', note: 'desc' };
// @ts-expect-error O3 a direction is asc or desc
const o3: OrderBy<'orders'> = { due: 'up' };
void o1;
void o2;
void o3;

// ── related sort keys: through one-relations, at most two hops; the target field is `Sortable` on its model ──
const r: OrderBy<'orders'>[] = [
	{ customer: { name: 'asc' } },
	[{ customer: { order_count: 'desc' } }, { due: 'asc' }],
	{ customer: 'asc' }
];
// @ts-expect-error R0 a sort crosses only declared layers (order_lines declares no order layer)
const r0: OrderBy<'order_lines'> = { order: { customer: { name: 'desc' } } };
void r;
void r0;
// @ts-expect-error R1 a many field on the target has no order
const r1: OrderBy<'orders'> = { customer: { tags: 'asc' } };
// @ts-expect-error R2 one field per related key
const r2: OrderBy<'orders'> = { customer: { name: 'asc', tier: 'desc' } };
// @ts-expect-error R3 nor a one-relation its read does not declare (sites declares no customer layer)
const r3: OrderBy<'sites'> = { customer: { name: 'asc' } };
// @ts-expect-error R4 a direction is asc or desc
const r4: OrderBy<'orders'> = { customer: { name: 'up' } };
// @ts-expect-error R5 a dotted key is not the grammar
const r5: OrderBy<'orders'> = { 'customer.name': 'asc' };
// @ts-expect-error R6 the target's id is not a sort key (order by the relation itself)
const r6: OrderBy<'orders'> = { customer: { id: 'asc' } };
// @ts-expect-error R7 a field is not a hop
const r7: OrderBy<'order_lines'> = { order: { note: { name: 'asc' } } };
void r1;
void r2;
void r3;
void r4;
void r5;
void r6;
void r7;
// Context operands: the requestor is a typed actor operand (types/data.ts W1–W7); `{ clock }` is only an edge form (agent
// read, UI filter state, a described filter), materialized before lowering, so authored reads take `bolt.clock` values.
const v1: Where<'orders'> = { owner: { eq: { var: 'requestor.id' } } };
// @ts-expect-error V1 `{ clock }` is no authored operand: materialize the day first
const v2: Where<'orders'> = { due: { eq: { var: 'today' } } };
// @ts-expect-error V2 nor on an instant
const v3: Where<'orders'> = { placed_at: { lt: { var: 'now - hours(1)' } } };
void v1;
void v2;
void v3;
