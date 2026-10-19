import { Effect } from 'effect';
// G1 (§11.2): the families the per-area corpora (data.ts, access.ts, runtime.ts) leave open, one clean case and at least
// one planted mistake each. Each `@ts-expect-error` line is a planted mistake.
import { Decimal } from '@norbital-ai/std/decimal';
import { automation, collection, model, policy } from '../../src/index.ts';
import type { Id, InputOf, Masked, Row, Where } from '../../src/index.ts';
import type { StoredRow } from '../../src/decl/names.ts';
import * as c from './fixture/collections.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(): T => true as T;

// ── union and record input kinds (§3.3.2) ──
type Payment = {
	kind: 'union';
	by: 'method';
	arms: {
		card: { last4: { kind: 'text' } };
		bank: { iban: { kind: 'text' }; ref: { kind: 'int'; optional: true } };
	};
};
is<
	Eq<
		InputOf<{ p: Payment }>['p'],
		| { readonly method: 'card'; readonly last4: string }
		| { readonly method: 'bank'; readonly iban: string; readonly ref?: number | null }
	>
>();
is<
	Eq<
		InputOf<{ r: { kind: 'record'; of: { kind: 'decimal'; scale: 2 } } }>['r'],
		{ readonly [key: string]: Decimal }
	>
>();
const pay = collection('order_lines', {
	read: { fields: 'all' },
	actions: {
		pay: {
			description: 'Pay',
			input: {
				p: {
					kind: 'union',
					by: 'method',
					arms: { card: { last4: { kind: 'text' } }, bank: { iban: { kind: 'text' } } }
				},
				split: { kind: 'record', of: { kind: 'decimal', scale: 2 } }
			},
			output: { kind: 'text' }
		}
	}
});
pay.action('pay', function* ({ p, split }) {
	return (p.method === 'card' ? p.last4 : p.iban) + Object.keys(split).join();
});
pay.action('pay', function* ({ p }) {
	// @ts-expect-error U1 a union member is read without narrowing on its tag
	return p.last4;
});
collection('order_lines', {
	read: { fields: 'all' },
	queries: {
		q: {
			description: 'x',
			// @ts-expect-error U2 a record of an unknown kind
			input: { r: { kind: 'record', of: { kind: 'txt' } } },
			output: { kind: 'int' }
		}
	}
});
collection('order_lines', {
	read: { fields: 'all' },
	queries: {
		q: {
			description: 'x',
			// @ts-expect-error U3 a union arm member of an unknown kind
			input: { u: { kind: 'union', by: 't', arms: { a: { x: { kind: 'strng' } } } } },
			output: { kind: 'int' }
		}
	}
});
collection('order_lines', {
	read: { fields: 'all' },
	queries: {
		q: {
			description: 'x',
			// @ts-expect-error U4 a union without its tag field
			input: { u: { kind: 'union', arms: { a: {} } } },
			output: { kind: 'int' }
		}
	}
});
// @ts-expect-error U5 `record` is an input-only kind
model({ description: 'x', label: 'a', fields: { a: { kind: 'record', of: { kind: 'int' } } } });
// @ts-expect-error U6 `union` is an input-only kind
model({ description: 'x', label: 'a', fields: { a: { kind: 'union', by: 't', arms: {} } } });
collection('order_lines', {
	read: { fields: 'all' },
	queries: {
		q: {
			description: 'x',
			// @ts-expect-error U7 a union option misspelt (exact at depth, rule 5)
			input: { u: { kind: 'union', by: 't', arms: {}, strict: true } },
			output: { kind: 'int' }
		}
	}
});

// ── the one transform (rule 27) and who reads (rule 15) ──
c.orders.transform(function* (inputs, ctx) {
	const stored = yield* ctx.db.read('orders', { where: { status: { eq: 'draft' } }, limit: 10 });
	is<Eq<(typeof stored.rows)[number], StoredRow<'orders'>>>();
	is<Eq<'due_soon' extends keyof StoredRow<'orders'> ? 1 : 0, 0>>(); // never computed, seq or roll-up
	return inputs;
});
// @ts-expect-error T1 a payload value of the wrong kind
c.orders.transform(function* (inputs) {
	return inputs.map((i) => ({ ...i, note: 5 }));
});
// @ts-expect-error T2 a payload writing a roll-up
c.orders.transform(function* (inputs) {
	return inputs.map((i) => ({ ...i, total: Decimal.of(0) }));
});
c.orders.transform(function* (inputs, ctx) {
	// @ts-expect-error T3 refuse naming a field the payload cannot hold
	return inputs.length > 9 ? yield* ctx.refuse('too many', { field: 'total' }) : inputs;
});
c.orders.transform(function* (inputs, ctx) {
	// @ts-expect-error T4 the transform reads computed values nowhere (rule 10)
	return ctx.existing[0]?.due_soon ? inputs : inputs;
});
c.orders.transform(function* (inputs, ctx) {
	// @ts-expect-error T5 a transform has no I/O facility (rule 63)
	return (yield* ctx.ai.sys_2.infer({ prompt: 'x' }), inputs);
});
// T6 the transform's workspace reads select stored fields (rule 72: read only the needed columns), never a derived one
c.orders.transform(function* (inputs, ctx) {
	return (
		(yield* ctx.db.read('orders', { select: { note: true }, limit: 1 })).rows[0]?.note,
		inputs
	);
});
c.orders.transform(function* (inputs, ctx) {
	// @ts-expect-error T6b a derived value is no stored field (rule 10)
	return (yield* ctx.db.read('orders', { select: { total: true }, limit: 1 }), inputs);
});
// Workspace selections retain the generated sequence and id, including keyed reads.
c.orders.transform(function* (inputs, ctx) {
	const selected = yield* ctx.db.read('orders', { select: { number: true }, limit: 1 });
	const keyed = yield* ctx.db.read({
		orders: { collection: 'orders', select: { number: true }, limit: 1 }
	});
	is<Eq<(typeof selected.rows)[number], { readonly number: string; readonly id: Id<'orders'> }>>();
	is<Eq<(typeof keyed.orders.rows)[number], (typeof selected.rows)[number]>>();
	return inputs;
});
c.orders.query('open_total', function* (_, ctx) {
	return (
		// @ts-expect-error T7 a query has no I/O facility (rule 63)
		yield* ctx.request('erp', { method: 'GET', path: 'x', output: { kind: 'json' } }), Decimal.of(0)
	);
});

// ── queries and actions: writes through `act` ──
c.orders.action('submit', function* (_, ctx) {
	return yield* ctx.act('orders.update', {
		target: ctx.target.id,
		// @ts-expect-error Q1 `set` naming a computed field (rule 38e)
		set: { due_soon: ctx.target.due_soon }
	});
});
c.orders.action('submit', function* (_, ctx) {
	// @ts-expect-error Q2 a relation array never replaces a set (rule 22): relation actions are explicit
	return yield* ctx.act('orders.update', { target: ctx.target.id, set: { lines: [] } });
});
c.orders.action('submit', function* (_, ctx) {
	// @ts-expect-error Q3 a state value outside the state's states (rule 40)
	return yield* ctx.act('orders.update', { target: ctx.target.id, set: { status: 'shipped' } });
});
c.orders.action('submit', function* (_, ctx) {
	// @ts-expect-error Q4 a read may not state both a limit and all (rule 9)
	return yield* ctx.read('orders', { limit: 5, all: true });
});
c.orders.action('renote', function* (_, ctx) {
	const out = yield* ctx
		.act('orders.delete', { target: [] })
		.pipe(
			Effect.catchTag('ActRefused', (refused) =>
				Effect.succeed({ kind: 'refused' as const, code: refused.code })
			)
		);
	if (out.kind === 'refused') return out.code === 'locked' ? 1 : 0;
	// @ts-expect-error Q5 the outcome union has no 'error' kind (rule 32)
	if (out.kind === 'error') return 2;
	return 0;
});
c.orders.action('submit', function* (_, ctx) {
	const { records } = yield* ctx.act('customers.create', { name: 'Acme' });
	for (const record of records)
		if (record.collection === 'customers') is<Eq<typeof record.id, Id<'customers'>>>();
});

// ── rule 10: caller rows mask what some grant does not admit (`Value | Masked`); stored rows are never masked ──
is<Eq<Row<'customers'>['email'], string | null | Masked>>(); // sales_rep reads customers' name and tier only
is<Eq<Row<'customers'>['name'], string>>();
is<Eq<StoredRow<'customers'>['email'], string | null>>();
c.orders.query('open_total', function* (_, ctx) {
	const page = yield* ctx.read('customers', { select: { name: true, email: true }, limit: 1 });
	const first = page.rows[0];
	const name: string | undefined = first?.name;
	// @ts-expect-error K1 a maskable field is not a plain value until the mask is ruled out
	const email: string | null | undefined = first?.email;
	void name;
	void email;
	return Decimal.of(0);
});

// ── state `{ to, edit }` and owned relationships (rules 40, 41) ──
model({
	description: 'x',
	label: 's',
	// @ts-expect-error S1 `edit` is 'all', 'none' or a list
	fields: { s: { kind: 'state', initial: 'a', states: { a: { edit: 'some' } } } }
});
model({
	description: 'x',
	label: 's',
	// @ts-expect-error S2 `to` is a list of states
	fields: { s: { kind: 'state', initial: 'a', states: { a: { to: 'a' } } } }
});
model({
	description: 'x',
	label: 's',
	// @ts-expect-error S3 a state takes no default (a create lands in `initial`, X-30)
	fields: { s: { kind: 'state', initial: 'a', default: 'a', states: { a: {} } } }
});
collection('order_lines', {
	read: { fields: 'all' },
	create: { input: { columns: ['order', 'item', 'qty', 'price'] } },
	update: { input: { columns: ['qty'] } }
});
collection('order_lines', {
	read: { fields: 'all' },
	// @ts-expect-error O1 an owned child's parent key never changes after create (rule 41)
	update: { input: { columns: ['order', 'qty'] } }
});
collection('orders', {
	read: { fields: 'all' },
	// @ts-expect-error O2 nor through its parent's relation actions
	update: { input: { columns: [], with: { lines: { update: { columns: ['order'] } } } } }
});

// ── the `{ actor: 'email' }` operand (§3.3.9) ──
const mine: Where<'customers'> = { email: { eq: { actor: 'email' } } };
void mine;
policy({
	description: 'Customers read themselves',
	grants: { customers: { read: { email: { eq: { actor: 'email' } } } } }
});
// @ts-expect-error E1 on text that is not an email
policy({ description: 'x', grants: { customers: { read: { name: { eq: { actor: 'email' } } } } } });
policy({
	description: 'x',
	// @ts-expect-error E2 on a number
	grants: { order_lines: { read: { qty: { eq: { actor: 'email' } } } } }
});
// @ts-expect-error E3 an unknown actor operand
policy({ description: 'x', grants: { customers: { read: { email: { eq: { actor: 'mail' } } } } } });
model({
	description: 'x',
	label: 'e',
	fields: { e: { kind: 'text', format: 'email' } },
	// @ts-expect-error E4 not in a static position (`check`, rule 4)
	check: { mine: { e: { eq: { actor: 'email' } } } }
});

// ── the `{ actor: 'visitor' }` operand (anonymous identity) ──
const guest: Where<'customers'> = { name: { eq: { actor: 'visitor' } } };
void guest;
policy({
	description: 'Guests read their own rows',
	grants: { customers: { read: { name: { eq: { actor: 'visitor' } } } } }
});
policy({
	description: 'x',
	// @ts-expect-error V1 on a number
	grants: { order_lines: { read: { qty: { eq: { actor: 'visitor' } } } } }
});

// ── the run ledger (rule 56, X-18): an `Id<>` target, never granted, read or written ──
const run: Id<'sys_run'> | undefined = undefined;
void run;
// @ts-expect-error L1 run-grant: no grant names sys_run
policy({ description: 'x', grants: { sys_run: { read: true } } });
c.orders.action('renote', function* (_, ctx) {
	// @ts-expect-error L2 run-ctx-read: server code cannot read sys_run
	return (yield* ctx.read('sys_run', { limit: 1 })).rows.length;
});
c.orders.action('renote', function* (_, ctx) {
	// @ts-expect-error L3 nor write it
	yield* ctx.act('sys_run.create', {});
	return 0;
});
// @ts-expect-error L4 nor trigger on it
automation({ description: 'x', runAs: ['sales_rep'], on: { created: 'sys_run' } });
policy({ description: 'x', grants: { sys_invitation: { read: true } } });
// @ts-expect-error Invitations remain read-only.
policy({ description: 'x', grants: { sys_invitation: { read: true, create: true } } });
// @ts-expect-error API keys take no grant.
policy({ description: 'x', grants: { sys_api_key: { read: true } } });
