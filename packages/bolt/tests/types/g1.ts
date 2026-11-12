import { Effect } from 'effect';
// G1 (§11.2): the families the per-area corpora (data.ts, access.ts, runtime.ts) leave open, one clean case and at least
// one planted mistake each. Each `@ts-expect-error` line is a planted mistake.
import { Decimal } from '@norbital-ai/std/decimal';
import { automation, policy } from '../../src/index.ts';
import { bind_model } from '../../src/declarations.ts';
import type { Id, InputOf, InstanceId, Row, Where } from '../../src/index.ts';
import type { RowState, StoredRow } from '../../src/decl/names.ts';
import * as rt from './fixture/runtime.ts';
import * as m from './fixture/models.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(..._proof: T extends true ? [] : never): void => {};
declare const erp_account: InstanceId<'erp'>;

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

automation({
	...rt.order_lines_pay.spec,
	run: function* ({ p, split }) {
		return (p.method === 'card' ? p.last4 : p.iban) + Object.keys(split).join();
	}
});
automation({
	...rt.order_lines_pay.spec,
	run: function* ({ p }) {
		// @ts-expect-error U1 a union member is read without narrowing on its tag
		return p.last4;
	}
});
automation({
	...rt.nightly.spec,
	// @ts-expect-error U2 a record of an unknown kind
	input: { r: { kind: 'record', of: { kind: 'txt' } } },
	run: function* () {
		return 0;
	}
});
automation({
	...rt.nightly.spec,
	// @ts-expect-error U3 a union arm member of an unknown kind
	input: { u: { kind: 'union', by: 't', arms: { a: { x: { kind: 'strng' } } } } },
	run: function* () {
		return 0;
	}
});
automation({
	...rt.nightly.spec,
	// @ts-expect-error U4 a union without its tag field
	input: { u: { kind: 'union', arms: { a: {} } } },
	run: function* () {
		return 0;
	}
});
bind_model('probe')({
	description: 'x',
	record_label: 'record.a',
	// @ts-expect-error U5 `record` is an input-only kind
	fields: { a: { kind: 'record', of: { kind: 'int' } } }
});
bind_model('probe')({
	description: 'x',
	record_label: 'record.a',
	// @ts-expect-error U6 model fields use their closed stored descriptor kinds
	fields: { a: { kind: 'union', by: 't', arms: {} } }
});
automation({
	...rt.nightly.spec,
	// @ts-expect-error U7 a union option misspelt (exact at depth, rule 5)
	input: { u: { kind: 'union', by: 't', arms: {}, strict: true } },
	run: function* () {
		return 0;
	}
});

// ── write callbacks and workspace reads (rules 10, 15, 27) ──
bind_model('orders')({
	...m.orders.spec,
	create: {
		...m.orders.spec.create,
		transform: function* (inputs, ctx) {
			const stored = yield* ctx.query({
				orders: { where: { status: { eq: 'draft' } }, limit: 10 }
			});
			// a workspace read is unmasked
			is<Eq<(typeof stored.orders.rows)[number]['note'], string | null>>();
			is<Eq<'due_soon' extends keyof StoredRow<'orders'> ? 1 : 0, 0>>(); // never computed, seq or roll-up
			return inputs.map(({ set }) => set);
		}
	}
});
bind_model('orders')({
	...m.orders.spec,
	create: {
		...m.orders.spec.create,
		// @ts-expect-error T1 a payload value of the wrong kind
		transform: function* (inputs) {
			return inputs.map((i) => ({ ...i.set, note: 5 }));
		}
	}
});
bind_model('orders')({
	...m.orders.spec,
	create: {
		...m.orders.spec.create,
		// @ts-expect-error T2 a payload writing a roll-up
		transform: function* (inputs) {
			return inputs.map((i) => ({ ...i.set, total: Decimal.of(0) }));
		}
	}
});
bind_model('orders')({
	...m.orders.spec,
	create: {
		...m.orders.spec.create,
		transform: function* (inputs, ctx) {
			// @ts-expect-error T3 refuse naming a field the payload cannot hold
			return inputs.length > 9 ? yield* ctx.refuse('too many', { field: 'total' }) : inputs.map(({ set }) => set);
		}
	}
});
bind_model('orders')({
	...m.orders.spec,
	update: {
		...m.orders.spec.update,
		transform: function* (changes) {
			const before = changes[0]?.before;
			// @ts-expect-error T4 an update's before row has no computed fields (rule 10)
			const derived = before?.due_soon;
			void derived;
			return changes.map(({ set }) => set);
		}
	}
});
bind_model('orders')({
	...m.orders.spec,
	create: {
		...m.orders.spec.create,
		transform: function* (inputs, ctx) {
			// @ts-expect-error T5 a transform has no I/O facility (rule 63)
			return (yield* ctx.ai.sys_2.infer({ prompt: 'x' }), inputs.map(({ set }) => set));
		}
	}
});
// T6 the transform's workspace reads pick the fields they need (rule 72: read only the needed columns)
bind_model('orders')({
	...m.orders.spec,
	create: {
		...m.orders.spec.create,
		transform: function* (inputs, ctx) {
			return (
				(yield* ctx.query({ orders: { fields: ['note'], limit: 1 } })).orders.rows[0]?.note,
				inputs.map(({ set }) => set)
			);
		}
	}
});
bind_model('orders')({
	...m.orders.spec,
	create: {
		...m.orders.spec.create,
		transform: function* (inputs, ctx) {
			// T6b a read request reads what the root layer declares, roll-ups included (`read: 'all'`)
			const read = yield* ctx.query({ orders: { fields: ['total'], limit: 1 } });
			is<Eq<(typeof read.orders.rows)[number]['total'], Decimal>>();
			return inputs.map(({ set }) => set);
		}
	}
});
// Workspace selections retain the generated sequence and id, including read requests.
bind_model('orders')({
	...m.orders.spec,
	create: {
		...m.orders.spec.create,
		transform: function* (inputs, ctx) {
			const selected = yield* ctx.query({ orders: { fields: ['number'], limit: 1 } });
			is<
				Eq<
					(typeof selected.orders.rows)[number],
					{ readonly id: Id<'orders'>; readonly number: string } & RowState
				>
			>();
			return inputs.map(({ set }) => set);
		}
	}
});
policy({
	description: 'x',
	grants: {
		orders: {
			create: {
				verdict: function* (_, ctx) {
					// @ts-expect-error T7 a policy check has no I/O facility (rule 63)
					yield* ctx.request(erp_account, { method: 'GET', path: 'x', output: { kind: 'json' } });
					return ctx.allow();
				}
			}
		}
	}
});

// ── automations: writes through `act` ──
automation({
	...rt.orders_submit.spec,
	run: function* ({ target: targetId }, ctx) {
		const target =
			(yield* ctx.query({ orders: { where: { id: { eq: targetId } }, limit: 1 } })).orders
				.rows[0] ?? null;
		if (target === null) return yield* ctx.refuse('Choose an existing orders record.');
		yield* ctx.act({ 'orders.update': [
			// @ts-expect-error Q1 `set` naming a computed field (rule 38e)
			{
				target,
				set: { due_soon: target.due_soon }
			}
		] });
	}
});
automation({
	...rt.orders_submit.spec,
	run: function* ({ target: targetId }, ctx) {
		const target =
			(yield* ctx.query({ orders: { where: { id: { eq: targetId } }, limit: 1 } })).orders
				.rows[0] ?? null;
		if (target === null) return yield* ctx.refuse('Choose an existing orders record.');
		// @ts-expect-error Q2 a relation array never replaces a set (rule 22): relation actions are explicit
		yield* ctx.act({ 'orders.update': [{ target, set: { lines: [] } }] });
	}
});
automation({
	...rt.orders_submit.spec,
	run: function* ({ target: targetId }, ctx) {
		const target =
			(yield* ctx.query({ orders: { where: { id: { eq: targetId } }, limit: 1 } })).orders
				.rows[0] ?? null;
		if (target === null) return yield* ctx.refuse('Choose an existing orders record.');
		// @ts-expect-error Q3 a state value outside the state's states (rule 40)
		yield* ctx.act({ 'orders.update': [{ target, set: { status: 'shipped' } }] });
	}
});
automation({
	...rt.orders_submit.spec,
	run: function* (_, ctx) {
		// @ts-expect-error Q4 `all` is gone: a list's limit defaults to 10,000
		yield* ctx.query({ orders: { limit: 5, all: true } });
	}
});
automation({
	...rt.orders_renote.spec,
	run: function* (_, ctx) {
		const out = yield* ctx
			.act({ 'orders.delete': [] })
			.pipe(
				Effect.catchTag('ActRefused', (refused) =>
					Effect.succeed({ kind: 'refused' as const, code: refused.code })
				)
			);
		if (out.kind === 'refused') return out.code === 'locked' ? 1 : 0;
		// @ts-expect-error Q5 the outcome union has no 'error' kind (rule 32)
		if (out.kind === 'error') return 2;
		return 0;
	}
});
automation({
	...rt.orders_submit.spec,
	run: function* (_, ctx) {
		const { records } = yield* ctx.act({ 'customers.create': [{ name: 'Acme' }] });
		for (const record of records)
			if (record.model === 'customers') is<Eq<typeof record.id, Id<'customers'>>>();
	}
});

// ── rule 10: a caller row is its output's fields, plain values; policies filter rows, never mask a field ──
is<Eq<Row<'customers'>['email'], string | null>>();
is<Eq<Row<'customers', 'directory'>['name'], string>>();
// @ts-expect-error K0 a field outside the named output is not on its row
type DirectoryEmail = Row<'customers', 'directory'>['email'];
is<Eq<StoredRow<'customers'>['email'], string | null>>();
automation({
	...rt.orders_renote.spec,
	run: function* (_, ctx) {
		const page = yield* ctx.query({
			customers: {
				output: 'directory',
				limit: 1
			}
		});
		const first = page.customers.rows[0];
		const name: string | undefined = first?.name;
		// @ts-expect-error K1 the directory output carries no email
		void first?.email;
		void name;
		const { orders } = yield* ctx.query({
			orders: { output: 'logistics', limit: 1, lines: {} }
		});
		const qty = orders.rows[0]?.lines[0]?.qty;
		// @ts-expect-error K2 a layer field outside the named output (logistics lines carry item and qty)
		void orders.rows[0]?.lines[0]?.price;
		void qty;
		return 0;
	}
});

// ── state transitions and owned relationships (rules 40, 41) ──
bind_model('probe')({
	description: 'x',
	record_label: 'record.s',
	// @ts-expect-error S1 state edit lists are retired; locks are named constraints
	fields: { s: { kind: 'state', initial: 'a', states: { a: { edit: 'some' } } } }
});
bind_model('probe')({
	description: 'x',
	record_label: 'record.s',
	// @ts-expect-error S2 `to` is a list of states
	fields: { s: { kind: 'state', initial: 'a', states: { a: { to: 'a' } } } }
});
bind_model('probe')({
	description: 'x',
	record_label: 'record.s',
	// @ts-expect-error S3 a state takes no default (a create lands in `initial`, X-30)
	fields: { s: { kind: 'state', initial: 'a', default: 'a', states: { a: {} } } }
});
bind_model('order_lines')({
	...m.order_lines.spec,
	outputs: { default: { fields: 'all' } },
	create: { columns: { fields: ['order', 'item', 'qty', 'price'] } },
	update: { columns: { fields: ['qty'] } }
});
bind_model('order_lines')({
	...m.order_lines.spec,
	outputs: { default: { fields: 'all' } },
	// @ts-expect-error O1 an owned child's parent key never changes after create (rule 41)
	update: { columns: { fields: ['order', 'qty'] } }
});
// (a write layer naming the FK that ties it to its parent, `'orders.lines': ['order']`, is `bolt check`'s `model/layer`)

// ── the `{ var: 'requestor.email' }` operand (§3.3.9) ──
const mine: Where<'customers'> = { email: { eq: { var: 'requestor.email' } } };
void mine;
policy({
	description: 'Customers read themselves',
	grants: {
		customers: { outputs: { default: { where: { email: { eq: { var: 'requestor.email' } } } } } }
	}
});
// @ts-expect-error E1 on text that is not an email
// prettier-ignore
policy({ description: 'x', grants: { customers: { outputs: { default: { where: { name: { eq: { var: 'requestor.email' } } } } } } } });
policy({
	description: 'x',
	grants: {
		// @ts-expect-error E2 on a number
		order_lines: { outputs: { default: { where: { qty: { eq: { var: 'requestor.email' } } } } } }
	}
});
// @ts-expect-error E3 an unknown actor operand
// prettier-ignore
policy({ description: 'x', grants: { customers: { outputs: { default: { where: { email: { eq: { actor: 'mail' } } } } } } } });
bind_model('probe')({
	description: 'x',
	record_label: 'record.e',
	fields: { e: { kind: 'text', format: 'email' } },
	// @ts-expect-error E4 not in a static position (`check`, rule 4)
	constraints: { mine: { check: { e: { eq: { var: 'requestor.email' } } } } }
});

// ── the `{ var: 'requestor.visitor' }` operand (anonymous identity) ──
const guest: Where<'customers'> = { name: { eq: { var: 'requestor.visitor' } } };
void guest;
policy({
	description: 'Guests read their own rows',
	grants: {
		customers: { outputs: { default: { where: { name: { eq: { var: 'requestor.visitor' } } } } } }
	}
});
policy({
	description: 'x',
	grants: {
		// @ts-expect-error V1 on a number
		order_lines: { outputs: { default: { where: { qty: { eq: { var: 'requestor.visitor' } } } } } }
	}
});

// ── the run ledger (rule 56, X-18): an `Id<>` target, never granted, read or written ──
const run: Id<'sys_run'> | undefined = undefined;
void run;
// @ts-expect-error L1 run-grant: no grant names sys_run
policy({ description: 'x', grants: { sys_run: { outputs: { default: true } } } });
automation({
	...rt.orders_renote.spec,
	run: function* (_, ctx) {
		// @ts-expect-error L2 run-ctx-read: server code cannot read sys_run
		return (yield* ctx.query({ sys_run: { limit: 1 } })).rows.length;
	}
});
automation({
	...rt.orders_renote.spec,
	run: function* (_, ctx) {
		// @ts-expect-error L3 nor write it
		yield* ctx.act({ 'sys_run.create': [{}] });
		return 0;
	}
});
// @ts-expect-error L4 nor trigger on it
automation({ ...rt.nightly.spec, on: [{ created: 'sys_run' }] });
policy({ description: 'x', grants: { sys_invitation: { outputs: { default: true } } } });
policy({
	description: 'x',
	// @ts-expect-error Invitations remain read-only.
	grants: { sys_invitation: { outputs: { default: true }, create: true } }
});
// @ts-expect-error API keys take no grant.
policy({ description: 'x', grants: { sys_api_key: { outputs: { default: true } } } });
