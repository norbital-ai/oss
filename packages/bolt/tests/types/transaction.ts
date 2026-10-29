// Native transaction callbacks admit only transaction instructions; surrounding automation facilities stay outside.
import { Decimal } from '@norbital-ai/std/decimal';
import { Effect } from 'effect';
import { automation } from '../../src/index.ts';
import type {
	Committed,
	FileRef,
	Id,
	PendingApproval,
	TxApplied,
	TxCtx,
	TxInstruction
} from '../../src/index.ts';
import type { ActConflict, ActRefused, ActUnknown } from '../../src/decl/errors.ts';
import * as rt from './fixture/runtime.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(..._proof: T extends true ? [] : never): void => {};
declare const customer: Id<'customers'>;
declare const file: FileRef;
declare const instruction: TxInstruction;

automation('orders_submit', {
	...rt.orders_submit.spec,
	run: function* ({ target }, ctx) {
		const simple = ctx.transaction(function* (tx) {
			const { orders } = yield* tx.query({ orders: { where: { id: { eq: target } }, fields: ['id'], limit: 1 } });
			return orders.rows[0]?.id ?? null;
		});
		is<Eq<Effect.Success<typeof simple>, Committed<Id<'orders'> | null> | PendingApproval>>();
		const transaction = ctx.transaction(function* (tx) {
			is<Eq<typeof tx, TxCtx>>();
			const read = tx.query({ orders: { where: { id: { eq: target } }, fields: ['note'], limit: 1 } });
			const order = (yield* read).orders.rows[0];
			if (order !== undefined) {
				is<Eq<typeof order.id, Id<'orders'>>>();
				is<Eq<typeof order.note, string | null>>();
				// @ts-expect-error a picked row does not expose an unpicked field
				void order.customer;
			}
			const page = yield* tx.query({ orders: { fields: ['note'], limit: 2 } });
			// a named output reads in the session as outside it: its fixed fields only
			const directory = yield* tx.query({
				customers: { output: 'directory', where: { id: { eq: customer } }, limit: 1 }
			});
			is<Eq<(typeof directory.customers.rows)[number]['tier'], 'basic' | 'gold'>>();
			// @ts-expect-error a field outside the named output
			yield* tx.query({ customers: { output: 'directory', fields: ['email'], limit: 1 } });
			// a ref layer replaces its FK with the row or null; a many-layer lists its rows
			const related = yield* tx.query({
				orders: { where: { id: { eq: target } }, fields: ['customer'], limit: 1 },
				'orders.customer': { fields: ['name'] },
				'orders.lines': { fields: ['qty'] }
			});
			const rel = related.orders.rows[0];
			if (rel !== undefined) {
				if (rel.customer !== null) {
					is<Eq<typeof rel.customer.id, Id<'customers'>>>();
					is<Eq<typeof rel.customer.name, string>>();
				}
				const line = rel.lines[0];
				if (line !== undefined) {
					is<Eq<typeof line.id, Id<'order_lines'>>>();
					is<Eq<typeof line.qty, Decimal>>();
					// @ts-expect-error a layer row retains its field pick
					void line.price;
				}
			}
			// a read request: two roots and a declared layer in one statement on the same session
			const layered = yield* tx.query({
				orders: { where: { id: { eq: target } }, fields: ['note', 'customer'] },
				'orders.customer': { fields: ['name'] },
				customers: { fields: ['name'], limit: 10 }
			});
			const first = layered.orders.rows[0];
			if (first !== undefined) {
				is<Eq<typeof first.id, Id<'orders'>>>();
				is<Eq<typeof first.note, string | null>>();
				if (first.customer !== null) {
					is<Eq<typeof first.customer.id, Id<'customers'>>>();
					is<Eq<typeof first.customer.name, string>>();
				}
			}
			is<Eq<(typeof layered.customers.rows)[number]['name'], string>>();
			const staged = yield* tx.act('orders.update', [{ target, set: { note: 'in session' } }]);
			is<Eq<typeof staged, TxApplied<'orders.update'>>>();
			is<Eq<typeof staged.output, null>>();
			// @ts-expect-error an inner write has no committed or held kind
			void staged.kind;
			// @ts-expect-error an inner write does not claim committed success
			void (staged satisfies Committed<null>);
			// @ts-expect-error an inner write does not claim an approval request
			void (staged satisfies PendingApproval);
			for (const record of staged.records) {
				if (record.model === 'orders') is<Eq<typeof record.id, Id<'orders'>>>();
			}
			yield* tx.act('orders.create', [{ customer, note: 'created in session' }]);
			yield* tx.act('orders.upsert', [{ id: target, note: 'kept' }], { onConflict: 'keep' });
			yield* tx.act('orders.delete', [{ target }]);
			const after = yield* tx.query({ orders: { where: { id: { eq: target } }, limit: 1 } });
			return { after: after.orders.rows[0] ?? null, directory, rows: page.orders.rows, amount: Decimal.of(1), file };
		});
		is<Eq<Effect.Error<typeof transaction>, ActRefused | ActConflict | ActUnknown>>();
		const result = yield* transaction;
		// @ts-expect-error held transactions do not promise a callback output
		void result.output;
		if (result.kind === 'committed') {
			is<Eq<typeof result.output.amount, Decimal>>();
			is<Eq<typeof result.output.file, FileRef>>();
		} else {
			is<Eq<typeof result, PendingApproval>>();
			void result.requestId;
			// @ts-expect-error the held arm has no callback output
			void result.output;
		}

		yield* ctx.transaction(function* (tx) {
			// @ts-expect-error a transaction model id keeps its model brand
			yield* tx.query({ orders: { where: { id: { eq: customer } }, limit: 1 } });
			// @ts-expect-error the single-model `query(model, args)` form is gone
			yield* tx.query('orders', { id: target });
			// @ts-expect-error a request's fields are the model's
			yield* tx.query({ orders: { fields: ['missing'] } });
			// @ts-expect-error a valid field cannot conceal an unknown one
			yield* tx.query({ orders: { fields: ['note', 'missing'] } });
			// @ts-expect-error a layer's fields are the ones that layer exposes
			// prettier-ignore
			yield* tx.query({ orders: { fields: ['note'] }, 'orders.lines': { fields: ['qty', 'missing'] } });
			// @ts-expect-error a ref layer keeps its target model's exact fields
			// prettier-ignore
			yield* tx.query({ orders: {}, 'orders.customer': { fields: ['name', 'missing'] } });
			// @ts-expect-error a layer the root does not declare
			yield* tx.query({ orders: {}, 'orders.owner': {} });
			// @ts-expect-error a read request in a transaction reads current records: no asOf
			yield* tx.query({ orders: { asOf: '2026-01-01T00:00:00.000Z' } });
			// @ts-expect-error declared queries are gone: a `'<model>.<query>'` read does not exist
			yield* tx.query('orders.open_total', {});
			// @ts-expect-error the keyed `{ alias: { from } }` form is gone: keys are roots
			yield* tx.query({ order: { from: 'orders', limit: 1 } });
			// @ts-expect-error native create keeps its writable input allowlist
			yield* tx.act('orders.create', [{ customer, total: 1 }]);
			// @ts-expect-error native update retains branded target ids
			yield* tx.act('orders.update', [{ target: customer, set: { note: 'x' } }]);
			// @ts-expect-error native update keeps its writable input allowlist
			yield* tx.act('orders.update', [{ target, set: { number: 'SO-1' } }]);
			// @ts-expect-error upsert still requires an explicit conflict policy
			yield* tx.act('orders.upsert', [{ id: target, note: 'x' }]);
			// @ts-expect-error ordinary writes cannot carry manual observations
			yield* tx.act('orders.update', [{ target, set: { note: 'x' } }], { observed: { [target]: 1 } });
			// @ts-expect-error session observations cannot be overridden on upsert
			// prettier-ignore
			yield* tx.act('orders.upsert', [{ id: target, note: 'x' }], { onConflict: 'update', observed: { [target]: 1 } });
			const manual: { onConflict: 'update'; observed: Readonly<Record<string, number>> } = {
				onConflict: 'update',
				observed: { [target]: 1 }
			};
			// @ts-expect-error a predeclared options variable cannot bypass the session observation boundary
			yield* tx.act('orders.upsert', [{ id: target, note: 'x' }], manual);
			// @ts-expect-error imports are not transaction CRUD
			yield* tx.act('orders.import', []);
			// @ts-expect-error erasure is not transaction CRUD
			yield* tx.act('orders.erase', { target });
			// @ts-expect-error transaction writes do not expose the independent batch API
			void tx.act.many;
			// @ts-expect-error transaction writes do not expose dynamic checked inputs
			void tx.act.checked;
			// @ts-expect-error a transaction cannot nest another transaction
			void tx.transaction;
			// @ts-expect-error no direct SQL surface
			void tx.sql;
			// @ts-expect-error no unmasked or raw database surface
			void tx.db;
			// @ts-expect-error no facility calls on the transaction context
			void tx.request;
		});

		// @ts-expect-error captured outer writes are Effects, not transaction instructions
		// prettier-ignore
		yield* ctx.transaction(function* () { yield* ctx.act('orders.update', [{ target, set: { note: 'x' } }]); });
		// @ts-expect-error captured outer request facilities cannot run while a transaction is open
		// prettier-ignore
		yield* ctx.transaction(function* () { yield* ctx.request('erp', { method: 'GET', path: 'x', output: { kind: 'json' } }); });
		// @ts-expect-error a captured SQL connection request is still a forbidden facility
		// prettier-ignore
		yield* ctx.transaction(function* () { yield* ctx.request('ledger_main', { op: 'values', values: { n: 1 } }); });
		const request = ctx.request;
		// @ts-expect-error capturing a method alias does not bypass the transaction instruction boundary
		// prettier-ignore
		yield* ctx.transaction(function* () { yield* request('erp', { method: 'GET', path: 'x', output: { kind: 'json' } }); });
		// @ts-expect-error captured files are outside the transaction instruction boundary
		// prettier-ignore
		yield* ctx.transaction(function* () { yield* ctx.files.get(file); });
		// @ts-expect-error captured scheduling is outside the transaction instruction boundary
		// prettier-ignore
		yield* ctx.transaction(function* () { yield* ctx.schedule('nightly', {}); });
		// @ts-expect-error captured notices are outside the transaction instruction boundary
		// prettier-ignore
		yield* ctx.transaction(function* () { yield* ctx.notify({ to: [{ policy: 'sales_rep' }], title: 'x' }); });
		// @ts-expect-error captured progress is outside the transaction instruction boundary
		// prettier-ignore
		yield* ctx.transaction(function* () { yield* ctx.progress({ text: 'x' }); });
		// @ts-expect-error nesting through the captured automation context is also forbidden
		// prettier-ignore
		yield* ctx.transaction(function* () { yield* ctx.transaction(function* () {}); });
		// @ts-expect-error an arbitrary Effect cannot be yielded by the callback
		// prettier-ignore
		yield* ctx.transaction(function* () { yield* Effect.succeed(1); });
		// @ts-expect-error an async function is not a transaction generator
		yield* ctx.transaction(async () => 1);
		// @ts-expect-error an async generator is not a transaction generator
		yield* ctx.transaction(async function* () {
			yield 1;
		});
		// @ts-expect-error a returned Effect is not a transaction generator
		yield* ctx.transaction(() => Effect.succeed(1));
		// @ts-expect-error a generator cannot return a Promise as its terminal value
		yield* ctx.transaction(function* () {
			return Promise.resolve(1);
		});
		// @ts-expect-error nested Promises are not native transaction outputs
		yield* ctx.transaction(function* () {
			return { pending: Promise.resolve(1) };
		});
		// @ts-expect-error callable terminal values cannot cross the native result boundary
		yield* ctx.transaction(function* () {
			return { callback: () => 1 };
		});
		// @ts-expect-error native file fields do not conceal unsupported extra payloads
		yield* ctx.transaction(function* () {
			return Object.assign({}, file, { pending: Promise.resolve(1) });
		});
		// @ts-expect-error the native decimal codec does not preserve attached extra fields
		yield* ctx.transaction(function* () {
			return Object.assign(Decimal.of(1), { cached: 1 });
		});
		// @ts-expect-error required undefined properties would be omitted from the native result
		yield* ctx.transaction(function* () {
			return { missing: undefined };
		});
		// @ts-expect-error undefined array entries would be normalized to null by the wire encoder
		yield* ctx.transaction(function* () {
			return [undefined];
		});
		// @ts-expect-error the same undefined entry rule holds in nested arrays
		yield* ctx.transaction(function* () {
			return { items: [undefined] };
		});
		const optionalTuple: readonly [number?] = [];
		// @ts-expect-error optional tuple elements may contain undefined, which is not a native array value
		yield* ctx.transaction(function* () {
			return optionalTuple;
		});
		// @ts-expect-error Date objects do not replace the native branded date and instant values
		yield* ctx.transaction(function* () {
			return new Date();
		});
		// @ts-expect-error bigint is not a native result value
		yield* ctx.transaction(function* () {
			return 1n;
		});
		// @ts-expect-error a native transaction context cannot escape as its callback result
		yield* ctx.transaction(function* (tx) {
			return tx;
		});
		// @ts-expect-error the private instruction envelope is not a callback result payload
		yield* ctx.transaction(function* () {
			return instruction;
		});
		yield* ctx.transaction(function* () {});
		const optionalProperty: { note?: string } = {};
		yield* ctx.transaction(function* () {
			return optionalProperty;
		});
	}
});

// @ts-expect-error transaction instructions are not Effects that an outer body can run directly
void (instruction satisfies Effect.Effect<unknown>);
