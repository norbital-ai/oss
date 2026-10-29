// Type corpus for Effect-native bodies (D8): generator bodies over the ctx Effects and their tagged failures. Each
// `@ts-expect-error` line is a planted mistake; a clean tsc proves every valid line compiles.
import { Effect } from 'effect';
import { Refusal } from '../../src/decl/errors.ts';
import { automation, model } from '../../src/index.ts';
import type { Actor, AutomationCtx, EffectCtx, WriteCtx } from '../../src/index.ts';
import type {
	ActConflict,
	ActRefused,
	ActUnknown,
	FacilityFailure,
	Unavailable
} from '../../src/decl/errors.ts';
import * as m from './fixture/models.ts';
import * as rt from './fixture/runtime.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(..._proof: T extends true ? [] : never): void => {};

// ── a generator body yields its reads and returns its output ──
automation('orders_renote', {
	...rt.orders_renote.spec,
	run: function* (_, ctx) {
		const open = yield* ctx.query({ orders: {
			where: { status: { ne: 'ordered' } },
			fields: ['total']
		} });
		return open.orders.rows.length;
	}
});
// two reads in one crossing: a concurrent `Effect.all`, or one read request of two roots
automation('orders_renote', {
	...rt.orders_renote.spec,
	run: function* (_, ctx) {
		const customers = yield* ctx.query({ customers: { fields: ['id'] } });
		const first = customers.customers.rows[0];
		const [orders, customer] = yield* Effect.all(
			[
				ctx.query({ orders: {} }),
				first === undefined ? Effect.succeed(null) : ctx.query({ customers: { where: { id: { eq: first.id } }, limit: 1 } })
			],
			{ concurrency: 'unbounded' }
		);
		void customer;
		const both = yield* ctx.query({ orders: { limit: 1 }, customers: { limit: 1 } });
		return orders.orders.rows.length + both.orders.rows.length + both.customers.rows.length;
	}
});
automation('orders_renote', {
	...rt.orders_renote.spec,
	// @ts-expect-error E1 an unyielded effect returned as the output
	run: function* (_, ctx) {
		return ctx.query({ orders: { } });
	}
});
automation('orders_renote', {
	...rt.orders_renote.spec,
	// @ts-expect-error E2 a body failing with an untagged value (every failure is tagged)
	run: function* () {
		return yield* Effect.fail('no');
	}
});

// ── refuse is an Effect failing with Refusal: `return yield*` it ──
model('orders', {
	...m.orders.spec,
	create: {
		...m.orders.spec.create,
		transform: function* (rows, ctx) {
			if (rows.length === 0) return yield* ctx.refuse('no rows', { field: 'note' });
			return rows;
		}
	}
});
is<Eq<Effect.Error<ReturnType<WriteCtx<'orders'>['refuse']>>, Refusal>>();
model('orders', {
	...m.orders.spec,
	create: {
		...m.orders.spec.create,
		transform: function* (rows, ctx) {
			// @ts-expect-error E3 refuse used as `never`
			const none: readonly never[] = ctx.refuse('no rows');
			return none.length === 0 ? rows : rows;
		}
	}
});

// ── act fails with its tags, and catchTag narrows them away ──
automation('orders_submit', {
	...rt.orders_submit.spec,
	run: function* ({ target: targetId }, ctx) {
		const target = (yield* ctx.query({ orders: { where: { id: { eq: targetId } }, limit: 1 } })).orders.rows[0] ?? null;
		if (target === null)
			return yield* Effect.fail(new Refusal({ message: 'Choose an existing orders record.' }));
		const submit = ctx.act('orders.update', [{
			target: target.id,
			set: { status: 'submitted' }
		}]);
		is<Eq<Effect.Error<typeof submit>, ActRefused | ActConflict | ActUnknown>>();
		const kept = submit.pipe(
			Effect.catchTag('ActRefused', (refused) => Effect.succeed(refused.code))
		);
		is<Eq<Effect.Error<typeof kept>, ActConflict | ActUnknown>>();
		yield* kept;
	}
});
automation('orders_submit', {
	...rt.orders_submit.spec,
	run: function* ({ target: targetId }, ctx) {
		const target = (yield* ctx.query({ orders: { where: { id: { eq: targetId } }, limit: 1 } })).orders.rows[0] ?? null;
		if (target === null)
			return yield* Effect.fail(new Refusal({ message: 'Choose an existing orders record.' }));
		yield* ctx.act('orders.update', [{ target: target.id, set: {} }]).pipe(
			// @ts-expect-error E4 a tag act never fails with
			Effect.catchTag('Refusal', () => Effect.void)
		);
	}
});

// ── facilities fail with FacilityFailure or Unavailable ──

automation('sweep', {
	description: 'x',
	policies: ['sales_rep'],
	run: function* (_, ctx) {
		const page = ctx.web.read('https://a.test');
		is<Eq<Effect.Error<typeof page>, FacilityFailure | Unavailable>>();
		const hits = yield* ctx.geo
			.search('Kismis')
			.pipe(Effect.catchTag('Unavailable', () => Effect.succeed([])));
		void hits;
		yield* ctx.progress({ text: 'done' });
	}
});

model('orders', {
	...m.orders.spec,
	// @ts-expect-error E5 ctx-bearing bodies must be generators
	create: { ...m.orders.spec.create, transform: async () => [] }
});
declare const automationCtx: AutomationCtx;
// @ts-expect-error E6 ctx members have no Promise facet
const promiseRead: Promise<unknown> = automationCtx.query({ orders: { } });
automation('sweep', {
	description: 'x',
	policies: ['sales_rep'],
	run: function* (_, ctx) {
		// @ts-expect-error E7 act has no .try twin
		ctx.act.try('orders.update', [{ target: 'o1', set: {} }]);
		// @ts-expect-error E8 facilities have no .try twin
		ctx.web.read.try('https://a.test');
	}
});

// ── a model effect holds no policy: it runs as the writer, without host tools ──
declare const effectCtx: EffectCtx;
is<Eq<typeof effectCtx.actor, Actor>>();
// @ts-expect-error E9 an effect has no host tools
void effectCtx.ai.sys_2.infer({ prompt: 'x', tools: ['browser'] });
// @ts-expect-error E9 nor record reads
void effectCtx.ai.sys_2.infer({ prompt: 'x', tools: ['read'] });
