// Type corpus for gaps found migrating real templates (CTX-TYPES): query refusal and search indexes, atomic imports with
// `on_conflict`, transform-filled create fields, custom `default`/`many`, untagged unions. Each `@ts-expect-error` is a
// planted mistake.
import { Effect } from 'effect';
import { automation, custom_field } from '../../src/index.ts';
import { bind_model } from '../../src/declarations.ts';
import type { AutomationCtx, CreateInput } from '../../src/index.ts';
import type { ValueOf } from '../../src/decl/fields.ts';
import * as m from './fixture/models.ts';
import * as rt from './fixture/runtime.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Flat<T> = { [K in keyof T]: T[K] };
const is = <T extends true>(..._proof: T extends true ? [] : never): void => {};

// (1) automations run named similarity searches (declared queries, and their `refuse`, are gone)
automation({
	...rt.orders_submit.spec,
	run: function* (_, ctx) {
		const near = yield* ctx.query({
			orders: {
				search: { by_colour: { lab: [1, 2, 3] } },
				limit: 3,
				fields: ['note']
			}
		});
		const first = near.orders.rows[0];
		if (first === undefined) return;
		const d: number = first.$distance;
		const n: string | null = first.note;
		void d;
		void n;
		// @ts-expect-error S1 an undeclared similarity
		yield* ctx.query({ orders: { search: { by_shape: {} }, limit: 1 } });
		// @ts-expect-error S2 a similarity input of the wrong shape
		yield* ctx.query({ orders: { search: { by_colour: { lab: 'red' } }, limit: 1 } });
	}
});
is<Eq<'refuse' extends keyof AutomationCtx ? 1 : 0, 1>>();

automation({
	...rt.orders_submit.spec,
	run: function* ({ target: targetId }, ctx) {
		const target =
			(yield* ctx.query({ orders: { where: { id: { eq: targetId } }, limit: 1 } })).orders
				.rows[0] ?? null;
		if (target === null) return yield* ctx.refuse('errors.refused');
		yield* ctx.act({ 'orders.update': [{ target, set: { note: 'observed' } }] });
		// @ts-expect-error write options reject the retired observed map
		yield* ctx.act({ 'orders.update': [{ target, set: { note: 'invalid' } }] }, { observed: { [target.id]: '1' } });
	}
});

// (2) imports name their conflict policy in their own input.
automation({
	...rt.orders_renote.spec,
	run: function* (_, ctx) {
		const { notices, notice_notes } = yield* ctx.query({ notices: { fields: ['id'] }, notice_notes: { fields: ['id', 'revision'] } });
		const notice = notices.rows[0], note = notice_notes.rows[0];
		if (notice !== undefined) yield* ctx.act({ 'notice_notes.import': {
			rows: [{ notice: notice.id, note: 'x' }], on_conflict: 'update'
		} });
		if (note !== undefined) yield* ctx.act({ 'notice_notes.update': [{ target: note, set: { note: 'y' } }] });
		return 1;
	}
});
automation({
	...rt.orders_renote.spec,
	run: function* (_, ctx) {
		// @ts-expect-error U1 upsert is retired
		yield* ctx.act({ 'notice_notes.upsert': [] });
		return 1;
	}
});

// (4) a create field the transform fills is optional in the input
is<
	Eq<
		Flat<CreateInput<'customers'>>,
		{ readonly name?: string; readonly email?: string | null; readonly tier?: 'basic' | 'gold' }
	>
>();
automation({
	...rt.orders_renote.spec,
	run: function* (_, ctx) {
		yield* ctx.act({ 'customers.create': [{ email: 'a@b.c' }] });
		return 1;
	}
});

// (5) a custom field takes a default and `many`
bind_model('probe')({
	description: 'x',
	record_label: 'record.a',
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
bind_model('probe')({
	description: 'x',
	record_label: 'record.a',
	// @ts-expect-error K1 a custom default of the wrong shape
	fields: { a: { kind: 'text' }, r: { kind: 'custom', of: 'rating', default: { score: 'high' } } }
});

// (6) an untagged scalar union
custom_field({
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
custom_field({
	description: 'x',
	// @ts-expect-error K2 an untagged union arm of unknown kind
	shape: { kind: 'union', of: [{ kind: 'bool' }, { kind: 'nmber' }] }
});
