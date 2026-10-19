// Type corpus for Effect-native bodies (D8): generator bodies over the ctx Effects and their tagged failures. Each
// `@ts-expect-error` line is a planted mistake; a clean tsc proves every valid line compiles.
import { Effect } from 'effect';
import { Decimal } from '@norbital-ai/std/decimal';
import { automation } from '../../src/index.ts';
import type { QueryCtx } from '../../src/index.ts';
import type {
	ActConflict,
	ActRefused,
	ActUnknown,
	FacilityFailure,
	Refusal,
	Unavailable
} from '../../src/decl/errors.ts';
import * as c from './fixture/collections.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(..._proof: T extends true ? [] : never): void => {};

// ── a generator body yields its reads and returns its output ──
c.orders.query('open_total', function* ({ since }, ctx) {
	const open = yield* ctx.read('orders', {
		where: { due: { gte: since } },
		select: { total: true },
		all: true
	});
	return open.rows[0]?.total ?? Decimal.of(0);
});
// two reads in one crossing: a concurrent `Effect.all`
c.orders.query('open_total', function* (_, ctx) {
	const customers = yield* ctx.read('customers', { select: { id: true }, all: true });
	const first = customers.rows[0];
	const [orders, customer] = yield* Effect.all(
		[
			ctx.read('orders', { all: true }),
			first === undefined ? Effect.succeed(null) : ctx.get('customers', first.id)
		],
		{ concurrency: 'unbounded' }
	);
	void customer;
	return orders.rows[0]?.total ?? Decimal.of(0);
});
// @ts-expect-error E1 an unyielded effect returned as the output
c.orders.query('open_total', function* (_, ctx) {
	return ctx.read('orders', { all: true });
});
// @ts-expect-error E2 a body failing with an untagged value (every failure is tagged)
c.orders.query('open_total', function* () {
	return yield* Effect.fail('no');
});

// ── refuse is an Effect failing with Refusal: `return yield*` it ──
c.orders.query('open_total', function* ({ since }, ctx) {
	if (String(since) === '') return yield* ctx.refuse('no date', { field: 'since' });
	return Decimal.of(0);
});
is<Eq<Effect.Error<ReturnType<QueryCtx['refuse']>>, Refusal>>();
c.orders.query('open_total', function* (_, ctx) {
	// @ts-expect-error E3 refuse used as `never`
	const total: Decimal = ctx.refuse('no total');
	return total;
});

// ── act fails with its tags, and catchTag narrows them away ──
c.orders.action('submit', function* (_, ctx) {
	const submit = ctx.act('orders.update', { target: ctx.target.id, set: { status: 'submitted' } });
	is<Eq<Effect.Error<typeof submit>, ActRefused | ActConflict | ActUnknown>>();
	const kept = submit.pipe(
		Effect.catchTag('ActRefused', (refused) => Effect.succeed(refused.code))
	);
	is<Eq<Effect.Error<typeof kept>, ActConflict | ActUnknown>>();
	yield* kept;
});
c.orders.action('submit', function* (_, ctx) {
	yield* ctx.act('orders.update', { target: ctx.target.id, set: {} }).pipe(
		// @ts-expect-error E4 a tag act never fails with
		Effect.catchTag('Refusal', () => Effect.void)
	);
});

// ── facilities fail with FacilityFailure or Unavailable ──
const sweep = automation({ description: 'x', runAs: ['sales_rep'] });
sweep.run(function* (_, ctx) {
	const page = ctx.web.read('https://a.test');
	is<Eq<Effect.Error<typeof page>, FacilityFailure | Unavailable>>();
	const hits = yield* ctx.geo
		.search('Kismis')
		.pipe(Effect.catchTag('Unavailable', () => Effect.succeed([])));
	void hits;
	yield* ctx.progress({ text: 'done' });
});

// @ts-expect-error E5 ctx-bearing bodies must be generators
c.orders.query('open_total', async () => 0);
declare const queryCtx: QueryCtx;
// @ts-expect-error E6 ctx members have no Promise facet
const promiseRead: Promise<unknown> = queryCtx.read('orders', { all: true });
sweep.run(function* (_, ctx) {
	// @ts-expect-error E7 act has no .try twin
	ctx.act.try('orders.update', { target: 'o1', set: {} });
	// @ts-expect-error E8 facilities have no .try twin
	ctx.web.read.try('https://a.test');
});
