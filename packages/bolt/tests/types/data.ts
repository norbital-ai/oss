// Type corpus for the data layer (§3.3.2–§3.3.4, §3.3.9, rules 3–5, 9, 10, P14). Each `@ts-expect-error` line is a
// planted mistake; a clean tsc proves every valid line compiles and every mistake is refused at its literal.
import { collection, customField, model, relationship } from '../../src/index.ts';
import type { Decimal, Id, Insert, Masked, Patch, PlainDate, Row, Where } from '../../src/index.ts';
import type { DateLiteral, ValueOf } from '../../src/decl/fields.ts';
import type { KindOfExpr } from '../../src/decl/model.ts';
import type { StoredRow } from '../../src/decl/names.ts';
import * as c from './fixture/collections.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const is = <T extends true>(): T => true as T;

// ── rows, inputs and values inferred from the literals ──
is<Eq<Row<'orders'>['status'], 'draft' | 'submitted' | 'ordered'>>();
is<Eq<Row<'orders'>['number'], string>>();                       // seq with a pattern
is<Eq<Row<'orders'>['total'], Decimal>>();                       // sum roll-up
is<Eq<Row<'orders'>['due_soon'], PlainDate>>();                  // computed
is<Eq<Row<'orders'>['customer'], Id<'customers'>>>();            // FK from +relationship.ts
is<Eq<Row<'orders'>['owner'], Id<'sys_user'> | null>>();
is<Eq<Row<'customers'>['tier'], 'basic' | 'gold'>>();
is<Eq<Row<'customers'>['tags'], readonly string[] | null | Masked>>();          // masked: sales_rep reads name and tier
is<Eq<Row<'sites'>['open'], { readonly from: PlainDate; readonly to: PlainDate | null }>>();
is<Eq<Row<'sites'>['location'], { readonly lat: number; readonly lng: number } | null | Masked>>();
is<Eq<keyof Row<'sites'>, 'name' | 'location' | 'customer' | 'open' | 'id' | 'revision' | 'approval_id' | 'created_at' | 'updated_at' | 'created_by' | 'updated_by'>>();
is<Eq<StoredRow<'sites'>['rating'], { readonly score: number; readonly note?: string | null } | null>>();   // custom field
is<Eq<StoredRow<'sites'>['checklist'], readonly { readonly item: string; readonly done: boolean }[]>>();
is<Eq<'total' extends keyof StoredRow<'orders'> ? 1 : 0, 0>>();  // transforms never see derived values (rule 10)
// an input takes a row's value or the plain literal decode accepts (ISO text, decimal text or an integer)
type Dec = Decimal | number | `${number}`;
is<Eq<Insert<'orders'>, { readonly customer: Id<'customers'>; readonly note?: string | null; readonly due?: PlainDate | DateLiteral | null;
	readonly lines?: { readonly create?: readonly { readonly item: string; readonly qty: Dec; readonly price: Dec }[] } }>>();
is<Eq<keyof Patch<'orders'>, 'status' | 'note' | 'due' | 'placed_at' | 'lines'>>();
is<Eq<KindOfExpr<{ when: [{ gt: [{ field: 'a' }, 1] }, { field: 'a' }, 0.5] }, { a: { kind: 'int' } }>, 'decimal'>>();

// ── predicates (K3) ──
const w1: Where<'orders'> = { status: { in: ['draft', 'submitted'] }, due: { lte: { today: '+30d' } },
	customer: { is: { tier: { eq: 'gold' }, name: { like: 'A%' } } }, lines: { some: { qty: { gt: 10 } } },
	or: [{ owner: { eq: { actor: 'id' } } }, { note: { isNull: true } }], approval_id: { isNull: true } };
const w2: Where<'customers'> = { orders: { none: {} }, sites: { count: { gte: 2 } }, email: { eq: { actor: 'email' } } };
void w1; void w2;
// @ts-expect-error W1 a state value that does not exist
const e1: Where<'orders'> = { status: { eq: 'shipped' } };
// @ts-expect-error W2 an unknown operator
const e2: Where<'orders'> = { note: { startsWith: 'x' } };
// @ts-expect-error W3 `is` and id operators are exclusive arms... and `like` is text only
const e3: Where<'orders'> = { due: { like: '2026%' } };
// @ts-expect-error W4 a field the collection does not expose (sites reads only four fields)
const e4: Where<'sites'> = { zone: { eq: 'Asia/Singapore' } };
// @ts-expect-error W5 a relation the collection does not expose (sites: relations [])
const e5: Where<'sites'> = { customer: { is: { tier: { eq: 'gold' } } } };
// @ts-expect-error W6 `{ now }` on a date field (dates take `{ today }`)
const e6: Where<'orders'> = { due: { lt: { now: '-1h' } } };
// @ts-expect-error W7 `{ actor: 'id' }` on an FK that is not a member
const e7: Where<'orders'> = { customer: { eq: { actor: 'id' } } };
// @ts-expect-error W8 a many-relation takes quantifiers, not id operators
const e8: Where<'orders'> = { lines: { isNull: true } };
void e1; void e2; void e3; void e4; void e5; void e6; void e7; void e8;

// ── model() ──
// @ts-expect-error M1 unknown kind
model({ description: 'x', label: 'a', fields: { a: { kind: 'txt' } } });
// @ts-expect-error M2 unknown text format
model({ description: 'x', label: 'a', fields: { a: { kind: 'text', format: 'handle' } } });
// @ts-expect-error M3 vector without a metric
model({ description: 'x', label: 'a', fields: { a: { kind: 'vector', dim: 3 } } });
// @ts-expect-error M4 state edge names a state that does not exist
model({ description: 'x', label: 's', fields: { s: { kind: 'state', initial: 'a', states: { a: { to: ['zz'] } } } } });
// @ts-expect-error M5 initial is not a state
model({ description: 'x', label: 's', fields: { s: { kind: 'state', initial: 'q', states: { a: {} } } } });
// @ts-expect-error M6 a misspelt modifier (options are exact, rule 5)
model({ description: 'x', label: 'a', fields: { a: { kind: 'text', optinal: true } } });
// @ts-expect-error M7 a derived kind takes no `optional`
model({ description: 'x', label: 'a', fields: { a: { kind: 'count', of: 'lines', optional: true } } });
// @ts-expect-error M8 enum default outside its values
model({ description: 'x', label: 'a', fields: { a: { kind: 'enum', values: ['x', 'y'], default: 'z' } } });
// @ts-expect-error M9 an input-only kind on a model
model({ description: 'x', label: 'a', fields: { a: { kind: 'number' } } });
// @ts-expect-error M10 a system column name
model({ description: 'x', label: 'a', fields: { id: { kind: 'text' } } });
// @ts-expect-error M11 computed kind differs from the tree's result kind
model({ description: 'x', label: 'a', fields: { a: { kind: 'date' } }, computed: { b: { kind: 'text', expr: { plusDays: [{ field: 'a' }, 1] } } } });
// @ts-expect-error M12 plusDays on a non-date
model({ description: 'x', label: 'a', fields: { a: { kind: 'text' } }, computed: { b: { kind: 'date', expr: { plusDays: [{ field: 'a' }, 1] } } } });
// @ts-expect-error M13 round on a date
model({ description: 'x', label: 'a', fields: { a: { kind: 'date' } }, computed: { b: { kind: 'date', expr: { round: [{ field: 'a' }, 2] } } } });
// @ts-expect-error M14 an unknown field in a computed tree
model({ description: 'x', label: 'a', fields: { a: { kind: 'int' } }, computed: { b: { kind: 'int', expr: { plus: [{ field: 'nope' }, 1] } } } });
// @ts-expect-error M15 money times money
model({ description: 'x', label: 'a', fields: { a: { kind: 'money' } }, computed: { b: { kind: 'money', expr: { times: [{ field: 'a' }, { field: 'a' }] } } } });
// @ts-expect-error M16 search over a non-text field
model({ description: 'x', label: 'a', fields: { a: { kind: 'int' } }, search: { text: ['a'] } });
// a patterned seq is text in storage and in the search document
model({ description: 'x', label: 'a', fields: { a: { kind: 'seq', pattern: 'P-{yyyy}-{0000}' }, b: { kind: 'text' } }, search: { text: ['a', 'b'] } });
// @ts-expect-error M16b a seq without a pattern is a number
model({ description: 'x', label: 'a', fields: { a: { kind: 'seq' } }, search: { text: ['a'] } });
// @ts-expect-error M17 a json field in a key (not btree)
model({ description: 'x', label: 'a', fields: { a: { kind: 'json' } }, key: ['a'] });
// @ts-expect-error M18 noOverlap over a field that is not a period
model({ description: 'x', label: 'a', fields: { a: { kind: 'date' } }, noOverlap: [{ key: [], period: 'a' }] });
// @ts-expect-error M19 a check comparing an int to a date field
model({ description: 'x', label: 'a', fields: { a: { kind: 'int' }, d: { kind: 'date' } }, check: { c: { a: { lte: { field: 'd' } } } } });
// @ts-expect-error M20 money currency naming a field that is not a currency
model({ description: 'x', label: 'a', fields: { a: { kind: 'money', currency: 'b' }, b: { kind: 'text' } } });
// @ts-expect-error M21 an unknown top-level option
model({ description: 'x', label: 'a', fields: { a: { kind: 'text' } }, temporal: true });
// @ts-expect-error M22 a json shape with an unknown member kind
model({ description: 'x', label: 'a', fields: { a: { kind: 'json', shape: { kind: 'object', fields: { b: { kind: 'strin' } } } } } });
// a time field's precision: the unit its picker offers and snaps to; a date or a date period has no hour
model({ description: 'x', label: 'm', fields: { m: { kind: 'date', precision: 'month' }, w: { kind: 'period', of: 'date', precision: 'week' },
	h: { kind: 'instant', precision: 'hour' }, y: { kind: 'period', of: 'instant', precision: 'year' }, t: { kind: 'time', precision: 'hour' } } });
is<Eq<ValueOf<{ kind: 'date'; precision: 'month' }>, PlainDate>>(); // precision never changes a value's type
// @ts-expect-error M23 a date has no hour precision
model({ description: 'x', label: 'a', fields: { a: { kind: 'date', precision: 'hour' } } });
// @ts-expect-error M24 a time has no month precision
model({ description: 'x', label: 'a', fields: { a: { kind: 'time', precision: 'month' } } });
// @ts-expect-error M25 a date period has no minute precision
model({ description: 'x', label: 'a', fields: { a: { kind: 'period', of: 'date', precision: 'minute' } } });
// @ts-expect-error M26 precision on a kind that is not a time
model({ description: 'x', label: 'a', fields: { a: { kind: 'int', precision: 'day' } } });

// ── relationship() ──
// @ts-expect-error R1 unknown model in the key
relationship({ 'nope.customer': { to: 'customers' } });
// @ts-expect-error R2 unknown target
relationship({ 'orders.customer': { to: 'custmers' } });
// @ts-expect-error R3 setNull on a required ref
relationship({ 'orders.customer': { to: 'customers', onDelete: 'setNull' } });
// @ts-expect-error R4 an inverse named after a grant key
relationship({ 'orders.customer': { to: 'customers', inverse: 'read' } });
// @ts-expect-error R5 an inverse colliding with a field of the target
relationship({ 'orders.customer': { to: 'customers', inverse: 'name' } });
// R6 (two inverses of one name on one target) fails the `__verify` line: scale.test.ts plants it.
// @ts-expect-error R7 the FK name is already a field of its model
relationship({ 'orders.note': { to: 'customers' } });
// @ts-expect-error R8 a target `where` naming an unknown field
relationship({ 'orders.customer': { to: 'customers', where: { nope: { eq: 1 } } } });
// @ts-expect-error R9 an owned child restricting its parent's delete
relationship({ 'order_lines.order': { to: 'orders', owned: true, onDelete: 'restrict' } });
// @ts-expect-error R10 `{ actor: 'id' }` default on a ref that is not a member
relationship({ 'orders.customer': { to: 'customers', default: { actor: 'id' } } });

// ── customField() ──
// @ts-expect-error F1 a shape with an unknown kind
customField({ description: 'x', shape: { kind: 'object', fields: { a: { kind: 'txt' } } } });
const f = customField({ description: 'x', shape: { kind: 'union', by: 'type', arms: { a: { n: { kind: 'int' } }, b: { s: { kind: 'text' } } } } });
f.validate((v) => (v.type === 'a' ? (v.n > 0 ? undefined : 'positive') : v.s.length > 0 ? undefined : 'empty'));
// @ts-expect-error F2 the value is typed from the shape
f.validate((v) => (v.n > 0 ? undefined : 'x'));

// ── collection() ──
// @ts-expect-error C1 create on a one_way collection (P14)
collection('notices', { read: { fields: 'all' }, create: { input: { columns: ['subject'] } } });
// @ts-expect-error C2 update on a one_way collection
collection('notices', { read: { fields: 'all' }, update: { input: { columns: ['subject'] } } });
// @ts-expect-error C3 delete on a one_way collection
collection('notices', { read: { fields: 'all' }, delete: {} });
// @ts-expect-error C4 an action on a one_way collection
collection('notices', { read: { fields: 'all' }, actions: { a: { description: 'a', input: {} } } });
// @ts-expect-error C5 a transform on a one_way collection
c.notices.transform(async (inputs) => inputs);
// @ts-expect-error C6 a misspelt create column
collection('orders', { read: { fields: 'all' }, create: { input: { columns: ['nte'] } } });
// @ts-expect-error C7 a derived field in an allowlist
collection('orders', { read: { fields: 'all' }, update: { input: { columns: ['total'] } } });
// @ts-expect-error C8 a relation action on something that is not a many-relation
collection('orders', { read: { fields: 'all' }, update: { input: { columns: [], with: { customer: { link: {} } } } } });
// @ts-expect-error C9 an unknown relation action
collection('orders', { read: { fields: 'all' }, update: { input: { columns: [], with: { lines: { replace: {} } } } } });
// @ts-expect-error C10 an unexposable read field
collection('orders', { read: { fields: ['nope'] } });
// @ts-expect-error C11 a query named after a generated verb
collection('orders', { read: { fields: 'all' }, queries: { update: { description: 'x', input: {}, output: { kind: 'int' } } } });
// @ts-expect-error C11b an action named after a query of the same collection (one callable, one limit key)
collection('orders', { read: { fields: 'all' }, queries: { q: { description: 'x', input: {}, output: { kind: 'int' } } }, actions: { q: { description: 'x', input: {} } } });
// @ts-expect-error C12 a query input of unknown kind
collection('orders', { read: { fields: 'all' }, queries: { q: { description: 'x', input: { a: { kind: 'txt' } }, output: { kind: 'int' } } } });
// @ts-expect-error C13 an id input filtered by a field its target lacks
collection('orders', { read: { fields: 'all' }, queries: { q: { description: 'x', input: { a: { kind: 'id', of: 'customers', where: { nope: { eq: 1 } } } }, output: { kind: 'int' } } } });
// @ts-expect-error C14 similarity candidates above 16
collection('orders', { read: { fields: 'all' }, similarity: { s: { description: 'x', input: {}, candidates: 32 } } });
// @ts-expect-error C15 a notification to an undeclared team
collection('orders', { read: { fields: 'all' }, notifications: { committed: [{ channel: 'inbox', to: [{ team: 'Salez' }], title: 't' }] } });
// @ts-expect-error C16 a notification recipient field that is not a member
collection('orders', { read: { fields: 'all' }, notifications: { committed: [{ channel: 'inbox', to: [{ user: 'customer' }], title: 't' }] } });
// @ts-expect-error C17 a collection whose model does not exist
collection('nope', { read: { fields: 'all' } });
// @ts-expect-error C18 an unknown option (hooks do not exist, R2)
collection('orders', { read: { fields: 'all' }, hooks: {} });

// ── bodies attach in statements (X-2) ──
c.orders.transform(async (inputs, { existing, now, refuse }) => inputs.map((input, i) => {
	const before = existing[i];
	if ('$delete' in input) return before?.status === 'ordered' ? refuse('An ordered order stays.') : input;
	return { ...input, ...(input.status === 'submitted' && before?.status !== 'submitted' ? { placed_at: now } : {}) };
}));
c.orders.query('open_total', async ({ since }, ctx) => {
	const open = await ctx.read('orders', { where: { status: { ne: 'ordered' }, due: { gte: since } }, select: { total: true, customer: { select: { name: true } } }, all: true });
	const first = open.rows[0];
	if (first !== undefined) { const n: string = first.customer.name; void n; }
	return open.rows.reduce<Decimal | undefined>((_, r) => r.total, undefined) ?? (0 as unknown as Decimal);
});
c.orders.action('submit', async (_, ctx) => ctx.act('orders.update', { target: ctx.target.id, set: { status: 'submitted' } }));
c.orders.action('renote', async ({ ids, note }, ctx) => {
	await ctx.act('orders.update', ids.map((id) => ({ target: id, set: { note } })));
	await ctx.act('orders.create', { customer: ids[0] as unknown as Id<'customers'>, lines: { create: [{ item: 'x', qty: 1 as unknown as Decimal, price: 2 as unknown as Decimal }] } });
	const gold = await ctx.query('customers', 'gold', {});
	return gold.length;
});
c.orders.similarity('by_colour', { probe: ({ lab }) => ({ field: 'colour', vector: lab, where: { status: { eq: 'ordered' } } }) });
// @ts-expect-error B1 a query body returning the wrong output
c.orders.query('open_total', async () => 3);
// @ts-expect-error B2 an undeclared query
c.orders.query('nope', async () => 1);
// @ts-expect-error B3 a misspelt input field
c.orders.query('open_total', async (input) => input.sinse);
// @ts-expect-error B4 act on an unknown callable
c.orders.action('submit', async (_, ctx) => ctx.act('orders.shred', { target: ctx.target.id }));
// @ts-expect-error B5 an update setting a field outside the update allowlist
c.orders.action('submit', async (_, ctx) => ctx.act('orders.update', { target: ctx.target.id, set: { customer: ctx.target.customer } }));
// @ts-expect-error B6 a create missing a required field
c.orders.action('renote', async (_, ctx) => { await ctx.act('orders.create', { note: 'x' }); return 1; });
// @ts-expect-error B7 upsert on a collection whose model has no key or unique
c.orders.action('renote', async (_, ctx) => { await ctx.act('orders.upsert', { note: 'x' }); return 1; });
// @ts-expect-error B8 `ctx.target` exists only on record actions
c.orders.action('renote', async (_, ctx) => ctx.target.id.length);
// @ts-expect-error B9 a read without a limit (rule 9)
c.orders.query('open_total', async (_, ctx) => { await ctx.read('orders', {}); return 0 as unknown as Decimal; });
// @ts-expect-error B10 similarity probing a field that is not a vector
c.orders.similarity('by_colour', { probe: ({ lab }) => ({ field: 'note', vector: lab }) });
// @ts-expect-error B11 an action writing a one_way collection
c.orders.action('renote', async (_, ctx) => { await ctx.act('notices.create', {}); return 1; });
