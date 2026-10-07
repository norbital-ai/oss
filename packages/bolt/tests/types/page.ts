// Type corpus for `$bolt` (§3.5) and ui's view props (§3.6) over the fixture's names: a page's reads, acts and `t`,
// and a view's `of`, `columns`, `values` and `record`, checked like `ctx`. Each `@ts-expect-error` is a planted mistake.
import { Form, Table } from '@norbital-ai/ui';
import { bolt } from '../../src/client/index.ts';
import type { Decimal, Id, Outcome, PlainDate } from '../../src/index.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const is = <T extends true>(): T => true as T;
declare const order: Id<'orders'>, customer: Id<'customers'>, since: PlainDate;

// ── reads ──
bolt.read('orders', { where: { status: { eq: 'draft' } }, orderBy: { due: 'asc' }, limit: 10 });
// @ts-expect-error P1 an unknown field in where
bolt.read('orders', { where: { nope: { eq: 'draft' } }, limit: 10 });
// @ts-expect-error P2 an unknown sort key
bolt.read('orders', { orderBy: { nope: 'asc' }, limit: 10 });
// @ts-expect-error P3 an unknown collection
bolt.read('orderz', { limit: 10 });
// @ts-expect-error P4 every read states a limit (rule 9)
bolt.read('orders', {});
void bolt.read('orders', { select: { note: true }, limit: 1 }).then((page) => {
	is<Eq<typeof page.rows[number], { readonly id: Id<'orders'>; readonly note: string | null }>>();
	// @ts-expect-error P5 a field the select did not ask for
	void page.rows[0]?.due;
});
void bolt.get('orders', order).then((row) => { if (row !== null) is<Eq<typeof row.total, Decimal>>(); });
void bolt.query('orders.open_total', { since }).then((total) => is<Eq<typeof total, Decimal>>());
// @ts-expect-error P6 a query's input
bolt.query('orders.open_total', { since: 5 });
// @ts-expect-error P7 an unknown query
bolt.query('orders.nope', {});
bolt.live(bolt.read('customers', { all: true }));

// ── acts ──
void bolt.act('orders.renote', { ids: [order], note: 'x' }).then((o) => is<Eq<typeof o, Outcome<number, 'orders.renote'>>>());
void bolt.act('orders.create', { customer, note: 'x' }).then((o) => {
	if (o.kind === 'committed') is<Eq<(typeof o.records)[number]['id'], Id<'orders'>>>();
});
// @ts-expect-error P8 an action's input
bolt.act('orders.renote', { ids: [order], note: 5 });
// @ts-expect-error P9 an unknown callable
bolt.act('orders.nope', {});
bolt.act('orders.update', { target: order, set: { note: 'x' } });
// @ts-expect-error P10 a field the update allowlist leaves out
bolt.act('orders.update', { target: order, set: { number: 'x' } });
bolt.start('nightly', {});

// ── i18n: the fixture declares no messages, so no key is one ──
// @ts-expect-error P11 an unknown message key
bolt.t('hello');

// ── ui views: `of`, `columns`, `values`, `record` per collection ──
// type-only: the components' call signature is the one svelte-check checks a page's props against
const table: typeof Table = Table, form: typeof Form = Form;
table(null, { of: 'orders', columns: ['number', 'status', { field: 'due', label: 'Due' }] });
// @ts-expect-error U1 an unknown collection
table(null, { of: 'orderz', columns: ['number'] });
// @ts-expect-error U2 an unknown column
table(null, { of: 'orders', columns: ['number', 'nope'] });
// @ts-expect-error U3 a where over an unknown field
table(null, { of: 'orders', columns: ['number'], where: { nope: { eq: 1 } } });
table(null, { of: [{ id: 'a', n: 1 }], columns: ['n'] });
// @ts-expect-error U4 a local array's column
table(null, { of: [{ id: 'a', n: 1 }], columns: ['m'] });
form(null, { of: 'orders', mode: 'create', values: { note: 'x' } });
// @ts-expect-error U5 a create value outside the collection's input
form(null, { of: 'orders', mode: 'create', values: { number: 'x' } });
// @ts-expect-error U6 a create value of the wrong type
form(null, { of: 'orders', mode: 'create', values: { note: 5 } });
form(null, { of: { action: 'orders.renote' }, values: { note: 'x' } });
