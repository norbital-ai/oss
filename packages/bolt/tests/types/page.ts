// Type corpus for `$bolt` (§3.5) and ui's view props (§3.6) over the fixture's names: a page's reads, acts and `t`,
// and a view's `of`, `columns`, `values` and `record`, checked like `ctx`. Each `@ts-expect-error` is a planted mistake.
import { Effect } from 'effect';
import { Form, Table } from '@norbital-ai/ui';
import { bolt } from '../../src/page/index.ts';
import type {
	Committed,
	Decimal,
	Id,
	Masked,
	Outcome,
	PendingApproval,
	PlainDate,
	RowApproval,
	RowState,
	Running
} from '../../src/index.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(..._proof: T extends true ? [] : never): void => {};
declare const order: Id<'orders'>, customer: Id<'customers'>, since: PlainDate;

/** One object type with each member's fields, as the read's own row type is. */
type Flat<T> = { [K in keyof T]: T[K] };
// ── reads ──
bolt.query('orders', { where: { status: { eq: 'draft' } }, orderBy: { due: 'asc' }, limit: 10 });
// @ts-expect-error P1 an unknown field in where
bolt.query('orders', { where: { nope: { eq: 'draft' } }, limit: 10 });
// @ts-expect-error P2 an unknown sort key
bolt.query('orders', { orderBy: { nope: 'asc' }, limit: 10 });
// @ts-expect-error P3 an unknown collection
bolt.query('orderz', { limit: 10 });
// @ts-expect-error P4 every read states a limit (rule 9)
bolt.query('orders', {});
bolt.query('orders', { select: { note: true }, limit: 1 }).pipe(
	Effect.map((page) => {
		is<
			Eq<
				(typeof page.rows)[number],
				Flat<{ readonly id: Id<'orders'>; readonly note: string | null } & RowState>
			>
		>();
		// @ts-expect-error P5 a field the select did not ask for
		void page.rows[0]?.due;
	})
);
// two selects of one collection, unioned: `in` narrows each row to the select that has the field (a custom and a list)
Effect.all([
	bolt.query('sites', { select: { name: true, rating: true, checklist: true }, limit: 10 }),
	bolt.query('sites', { select: { name: true }, limit: 10 })
]).pipe(
	Effect.map(([traced, untraced]) => {
		for (const row of [...traced.rows, ...untraced.rows]) {
			// a policy's grant masks both fields (`| Masked`), as a template's contractor grant does
			const rating = 'rating' in row ? row.rating : null;
			is<
				Eq<typeof rating, { readonly score: number; readonly note?: string | null } | null | Masked>
			>();
			const checklist = 'checklist' in row ? row.checklist : null;
			is<
				Eq<
					typeof checklist,
					readonly { readonly item: string; readonly done: boolean }[] | Masked | null
				>
			>();
			is<Eq<typeof row.$approval, RowApproval | undefined>>();
			is<Eq<typeof row.$sync, RowState['$sync']>>();
		}
	})
);
bolt.query('orders', { id: order }).pipe(
	Effect.map((row) => {
		if (row !== null) is<Eq<typeof row.total, Decimal>>();
	})
);
bolt
	.query('orders.open_total', { since })
	.pipe(Effect.map((total) => is<Eq<typeof total, Decimal>>()));
// @ts-expect-error P6 a query's input
bolt.query('orders.open_total', { since: 5 });
// @ts-expect-error P7 an unknown query
bolt.query('orders.nope', {});
const live = bolt.query('customers', { all: true });
void live.current;
void live.loading;
void live.error;

const promised: PromiseLike<unknown> = bolt.query('orders', { limit: 1 });
void promised;
bolt.query('orders', { limit: 1 }).then(() => {});

// ── acts ──
bolt
	.act('orders.update', { target: order, set: { note: 'x' } })
	.pipe(
		Effect.map((outcome) =>
			is<
				Eq<
					typeof outcome,
					Committed<null, 'orders.update'> | PendingApproval<'orders.update'> | Running
				>
			>()
		)
	);
bolt.act('orders.create', { customer, note: 'x' }).pipe(
	Effect.map((o) => {
		if (o.kind === 'committed')
			for (const record of o.records) {
				if (record.collection === 'orders') is<Eq<typeof record.id, Id<'orders'>>>();
			}
	})
);
// @ts-expect-error P8 an automation's input
bolt.start('orders_renote', { ids: [order], note: 5 });
// @ts-expect-error P9 an unknown callable
bolt.act('orders.nope', {});
bolt.act('orders.update', { target: order, set: { note: 'x' } });
// @ts-expect-error P10 a field the update allowlist leaves out
bolt.act('orders.update', { target: order, set: { number: 'x' } });
bolt.start('nightly', {});
bolt.start('orders_renote', { ids: [order], note: 'x' }).pipe(
	Effect.map((outcome) => {
		is<
			Eq<
				typeof outcome,
				Outcome<{
					readonly id: Id<'sys_run'>;
					readonly ids: readonly Id<'sys_run'>[];
					readonly automation: 'orders_renote';
				}>
			>
		>();
		if (outcome.kind === 'committed') {
			is<Eq<typeof outcome.output.id, Id<'sys_run'>>>();
			// @ts-expect-error queue admission never pretends to be the automation's eventual number output
			const result: number = outcome.output;
			void result;
		}
	})
);
// ── i18n: the fixture declares no messages, so no key is one ──
// @ts-expect-error P11 an unknown message key
bolt.t('hello');

// ── ui views: `of`, `columns`, `values`, `record` per collection ──
// type-only: the components' call signature is the one svelte-check checks a page's props against
const table: typeof Table = Table,
	form: typeof Form = Form;
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
form(null, { of: { automation: 'orders_renote' }, values: { note: 'x' } });
