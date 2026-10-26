// Type corpus for Effect-native bodies (D8): generator bodies over the ctx Effects and their tagged failures. Each
// `@ts-expect-error` line is a planted mistake; a clean tsc proves every valid line compiles.
import { Effect } from 'effect';
import { Refusal } from '../../src/decl/errors.ts';
import { Decimal } from '@norbital-ai/std/decimal';
import { automation, model } from '../../src/index.ts';
import type { QueryCtx } from '../../src/index.ts';
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
model('orders', {
	...m.orders.spec,
	queries: {
		...m.orders.spec.queries,
		open_total: {
			...m.orders.spec.queries.open_total,
			run: function* ({ since }, ctx) {
				const open = yield* ctx.query('orders', {
					where: { due: { gte: since } },
					select: { total: true },
					all: true
				});
				return open.rows[0]?.total ?? Decimal.of(0);
			}
		}
	}
});
// two reads in one crossing: a concurrent `Effect.all`
model('orders', {
	...m.orders.spec,
	queries: {
		...m.orders.spec.queries,
		open_total: {
			...m.orders.spec.queries.open_total,
			run: function* (_, ctx) {
				const customers = yield* ctx.query('customers', { select: { id: true }, all: true });
				const first = customers.rows[0];
				const [orders, customer] = yield* Effect.all(
					[
						ctx.query('orders', { all: true }),
						first === undefined ? Effect.succeed(null) : ctx.query('customers', { id: first.id })
					],
					{ concurrency: 'unbounded' }
				);
				void customer;
				return orders.rows[0]?.total ?? Decimal.of(0);
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
			// @ts-expect-error E1 an unyielded effect returned as the output
			run: function* (_, ctx) {
				return ctx.query('orders', { all: true });
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
			// @ts-expect-error E2 a body failing with an untagged value (every failure is tagged)
			run: function* () {
				return yield* Effect.fail('no');
			}
		}
	}
});

// ── refuse is an Effect failing with Refusal: `return yield*` it ──
model('orders', {
	...m.orders.spec,
	queries: {
		...m.orders.spec.queries,
		open_total: {
			...m.orders.spec.queries.open_total,
			run: function* ({ since }, ctx) {
				if (String(since) === '') return yield* ctx.refuse('no date', { field: 'since' });
				return Decimal.of(0);
			}
		}
	}
});
is<Eq<Effect.Error<ReturnType<QueryCtx['refuse']>>, Refusal>>();
model('orders', {
	...m.orders.spec,
	queries: {
		...m.orders.spec.queries,
		open_total: {
			...m.orders.spec.queries.open_total,
			run: function* (_, ctx) {
				// @ts-expect-error E3 refuse used as `never`
				const total: Decimal = ctx.refuse('no total');
				return total;
			}
		}
	}
});

// ── act fails with its tags, and catchTag narrows them away ──
automation('orders_submit', {
	...rt.orders_submit.spec,
	run: function* ({ target: targetId }, ctx) {
		const target = yield* ctx.query('orders', { id: targetId });
		if (target === null)
			return yield* Effect.fail(new Refusal({ message: 'Choose an existing orders record.' }));
		const submit = ctx.act('orders.update', {
			target: target.id,
			set: { status: 'submitted' }
		});
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
		const target = yield* ctx.query('orders', { id: targetId });
		if (target === null)
			return yield* Effect.fail(new Refusal({ message: 'Choose an existing orders record.' }));
		yield* ctx.act('orders.update', { target: target.id, set: {} }).pipe(
			// @ts-expect-error E4 a tag act never fails with
			Effect.catchTag('Refusal', () => Effect.void)
		);
	}
});

// ── facilities fail with FacilityFailure or Unavailable ──

automation('sweep', {
	description: 'x',
	runAs: ['sales_rep'],
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
	queries: {
		...m.orders.spec.queries,
		// @ts-expect-error E5 ctx-bearing bodies must be generators
		open_total: { ...m.orders.spec.queries.open_total, run: async () => 0 }
	}
});
declare const queryCtx: QueryCtx;
// @ts-expect-error E6 ctx members have no Promise facet
const promiseRead: Promise<unknown> = queryCtx.query('orders', { all: true });
automation('sweep', {
	description: 'x',
	runAs: ['sales_rep'],
	run: function* (_, ctx) {
		// @ts-expect-error E7 act has no .try twin
		ctx.act.try('orders.update', { target: 'o1', set: {} });
		// @ts-expect-error E8 facilities have no .try twin
		ctx.web.read.try('https://a.test');
	}
});
