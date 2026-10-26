// Type corpus for gaps found migrating real templates (CTX-TYPES): query refusal and search indexes, `ctx.act` upsert with
// `onConflict`, transform-filled create fields, custom `default`/`many`, untagged unions. Each `@ts-expect-error` is a
// planted mistake.
import { Effect } from 'effect';
import { Refusal } from '../../src/decl/errors.ts';
import { Decimal } from '@norbital-ai/std/decimal';
import { automation, customField, model } from '../../src/index.ts';
import type { AutomationCtx, Insert } from '../../src/index.ts';
import type { ValueOf } from '../../src/decl/fields.ts';
import * as m from './fixture/models.ts';
import * as rt from './fixture/runtime.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(..._proof: T extends true ? [] : never): void => {};

// (1) a query refuses; queries and automations run named similarity searches
model('orders', {
	...m.orders.spec,
	queries: {
		...m.orders.spec.queries,
		open_total: {
			...m.orders.spec.queries.open_total,
			run: function* ({ since }, ctx) {
				if (String(since) === '') return yield* ctx.refuse('no date', { field: 'since' });
				const near = yield* ctx.query('orders', {
					search: { by_colour: { lab: [1, 2, 3] } },
					limit: 3,
					select: { note: true }
				});
				const d: number = near.rows[0]!.$distance;
				const n: string | null = near.rows[0]!.note;
				void d;
				void n;
				return Decimal.of(0);
			}
		}
	}
});
model('orders', {
	...m.orders.spec,
	queries: {
		...m.orders.spec.queries,
		open_total: {
			...m.orders.spec.queries.open_total,
			run: function* (_, ctx) {
				// @ts-expect-error S1 an undeclared similarity
				yield* ctx.query('orders', { search: { by_shape: {} }, limit: 1 });
				return Decimal.of(0);
			}
		}
	}
});
model('orders', {
	...m.orders.spec,
	queries: {
		...m.orders.spec.queries,
		open_total: {
			...m.orders.spec.queries.open_total,
			run: function* (_, ctx) {
				// @ts-expect-error S2 a similarity input of the wrong shape
				yield* ctx.query('orders', { search: { by_colour: { lab: 'red' } }, limit: 1 });
				return Decimal.of(0);
			}
		}
	}
});
is<Eq<'refuse' extends keyof AutomationCtx ? 1 : 0, 0>>(); // automations have no refuse

automation('orders_submit', {
	...rt.orders_submit.spec,
	run: function* ({ target: targetId }, ctx) {
		const target = yield* ctx.query('orders', { id: targetId });
		if (target === null)
			return yield* Effect.fail(new Refusal({ message: 'Choose an existing orders record.' }));
		yield* ctx.act(
			'orders.update',
			{ target: target.id, set: { note: 'observed' } },
			{ observed: { [target.id]: target.revision } }
		);
		yield* ctx.act(
			'orders.update',
			{ target: target.id, set: { note: 'invalid' } },
			// @ts-expect-error an observed revision is numeric
			{ observed: { [target.id]: '1' } }
		);
	}
});

// (2) upsert from an automation takes onConflict
automation('orders_renote', {
	...rt.orders_renote.spec,
	run: function* (_, ctx) {
		const [notices, notes] = yield* Effect.all([
			ctx.query('notices', { select: { id: true }, all: true }),
			ctx.query('notice_notes', { select: { id: true }, all: true })
		]);
		const notice = notices.rows[0],
			note = notes.rows[0];
		if (notice !== undefined)
			yield* ctx.act(
				'notice_notes.upsert',
				{ notice: notice.id, note: 'x' },
				{ onConflict: 'update' }
			);
		if (note !== undefined)
			yield* ctx.act('notice_notes.upsert', { id: note.id, note: 'y' }, { onConflict: 'update' });
		return 1;
	}
});
automation('orders_renote', {
	...rt.orders_renote.spec,
	run: function* (_, ctx) {
		const notices = yield* ctx.query('notices', { select: { id: true }, all: true });
		const notice = notices.rows[0];
		if (notice !== undefined)
			// @ts-expect-error U1 upsert without onConflict (rule 28)
			yield* ctx.act('notice_notes.upsert', { notice: notice.id, note: 'x' });
		return 1;
	}
});

// (4) a create field the transform fills is optional in the input
is<
	Eq<
		Insert<'customers'>,
		{ readonly name?: string; readonly email?: string | null; readonly tier?: 'basic' | 'gold' }
	>
>();
automation('orders_renote', {
	...rt.orders_renote.spec,
	run: function* (_, ctx) {
		yield* ctx.act('customers.create', { email: 'a@b.c' });
		return 1;
	}
});

// (5) a custom field takes a default and `many`
model('probe', {
	description: 'x',
	label: 'a',
	fields: {
		a: { kind: 'text' },
		r: { kind: 'custom', of: 'rating', default: { score: 3 } },
		rs: { kind: 'custom', of: 'rating', many: true, default: [] }
	}
});
is<
	Eq<
		ValueOf<{ kind: 'custom'; of: 'rating'; many: true }>,
		readonly { readonly score: number; readonly note?: string | null }[]
	>
>();
model('probe', {
	description: 'x',
	label: 'a',
	// @ts-expect-error K1 a custom default of the wrong shape
	fields: { a: { kind: 'text' }, r: { kind: 'custom', of: 'rating', default: { score: 'high' } } }
});

// (6) an untagged scalar union
customField('scalar_variant', {
	description: 'x',
	shape: {
		kind: 'object',
		fields: {
			value: { kind: 'union', of: [{ kind: 'bool' }, { kind: 'number' }, { kind: 'text' }] }
		}
	},
	validate: (x) =>
		typeof x.value === 'string' || typeof x.value === 'number' || typeof x.value === 'boolean'
			? undefined
			: 'never'
});

is<
	Eq<
		ValueOf<{ kind: 'union'; of: readonly [{ kind: 'number' }, { kind: 'text' }] }>,
		number | string
	>
>();
customField('rating', {
	description: 'x',
	// @ts-expect-error K2 an untagged union arm of unknown kind
	shape: { kind: 'union', of: [{ kind: 'bool' }, { kind: 'nmber' }] }
});
