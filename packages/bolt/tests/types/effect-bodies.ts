// Type corpus for Effect-native bodies (D8): generator bodies over the ctx Effects and their tagged failures. Each
// `@ts-expect-error` line is a planted mistake; a clean tsc proves every valid line compiles.
import { Context, Effect } from 'effect';
import { Refusal } from '../../src/decl/errors/refusal.ts';
import { attached, attached_verdict, type GeneratorBody } from '../../src/decl/body.ts';
import { Verdict, type VerdictData } from '../../src/decl/access/policy.ts';
import { automation, model } from '../../src/index.ts';
import type { Actor, AutomationCtx, EffectCtx, Id, WriteCtx } from '../../src/index.ts';
import type { FacilityFailure, Unavailable } from '@norbital-ai/host-api';
import type { ActConflict, ActRefused, ReadFailed } from '../../src/decl/errors.ts';
import type { ActUnknown } from '../../src/decl/errors/act.ts';
import * as m from './fixture/models.ts';
import * as rt from './fixture/runtime.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(..._proof: T extends true ? [] : never): void => {};

// ── a generator body yields its reads and returns its output ──
automation({
	...rt.orders_renote.spec,
	run: function* (_, ctx) {
		const open = yield* ctx.query({
			orders: {
				where: { status: { ne: 'ordered' } },
				fields: ['total']
			}
		});
		return open.orders.rows.length;
	}
});
// two reads in one crossing: a concurrent `Effect.all`, or one read request of two roots
automation({
	...rt.orders_renote.spec,
	run: function* (_, ctx) {
		const customers = yield* ctx.query({ customers: { fields: ['id'] } });
		const first = customers.customers.rows[0];
		const [orders, customer] = yield* Effect.all(
			[
				ctx.query({ orders: {} }),
				first === undefined
					? Effect.succeed(null)
					: ctx.query({ customers: { where: { id: { eq: first.id } }, limit: 1 } })
			],
			{ concurrency: 'unbounded' }
		);
		void customer;
		const both = yield* ctx.query({ orders: { limit: 1 }, customers: { limit: 1 } });
		return orders.orders.rows.length + both.orders.rows.length + both.customers.rows.length;
	}
});
automation({
	...rt.orders_renote.spec,
	// @ts-expect-error E1 an unyielded effect returned as the output
	run: function* (_, ctx) {
		return ctx.query({ orders: {} });
	}
});
automation({
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
			if (rows.length === 0) return yield* ctx.refuse('errors.refused', { field: 'note' });
			return rows.map(({ set }) => set);
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
			const none: readonly never[] = ctx.refuse('errors.refused');
			return rows.map(({ set }) => none.length === 0 ? set : set);
		}
	}
});

// ── act fails with its tags, and catchTag narrows them away ──
automation({
	...rt.orders_submit.spec,
	run: function* ({ target: targetId }, ctx) {
		const target =
			(yield* ctx.query({ orders: { where: { id: { eq: targetId } }, limit: 1 } })).orders
				.rows[0] ?? null;
		if (target === null) return yield* ctx.refuse('errors.refused');
		const submit = ctx.act({ 'orders.update': [
			{
				target,
				set: { status: 'submitted' }
			}
		] });
		is<Eq<Effect.Error<typeof submit>, ActRefused | ActConflict | ActUnknown>>();
		const kept = submit.pipe(
			Effect.catchTag('ActRefused', (refused) => Effect.succeed(refused.code))
		);
		is<Eq<Effect.Error<typeof kept>, ActConflict | ActUnknown>>();
		yield* kept;
	}
});
automation({
	...rt.orders_submit.spec,
	run: function* ({ target: targetId }, ctx) {
		const target =
			(yield* ctx.query({ orders: { where: { id: { eq: targetId } }, limit: 1 } })).orders
				.rows[0] ?? null;
		if (target === null) return yield* ctx.refuse('errors.refused');
		yield* ctx.act({ 'orders.update': [{ target, set: {} }] }).pipe(
			// @ts-expect-error E4 a tag act never fails with
			Effect.catchTag('Refusal', () => Effect.void)
		);
	}
});

// ── facilities fail with FacilityFailure or Unavailable ──

automation({
	description: 'x',
	policies: ['sales_rep'],
	run: function* (_, ctx) {
		const page = ctx.web.read('https://a.test');
		is<Eq<Effect.Error<typeof page>, FacilityFailure | Unavailable>>();
		const hits = yield* ctx.geo
			.search('Bismis')
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
const promiseRead: Promise<unknown> = automationCtx.query({ orders: {} });
automation({
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

// ── literal reads keep their output inference and their real ReadFailed channel ──
const literalRead = automationCtx.query({ orders: { fields: ['number'], limit: 1 } });
is<Eq<Effect.Success<typeof literalRead>['orders']['rows'][number]['number'], string>>();
is<Eq<Effect.Error<typeof literalRead>, ReadFailed>>();
const recoveredRead = literalRead.pipe(
	Effect.catchTag('ReadFailed', (failure) => {
		is<Eq<typeof failure, ReadFailed>>();
		return Effect.succeed(failure.message);
	})
);
is<Eq<Effect.Error<typeof recoveredRead>, never>>();
literalRead.pipe(
	// @ts-expect-error E10 a literal read does not fail with ActRefused
	Effect.catchTag('ActRefused', () => Effect.void)
);

// ── geo may fail at the facility boundary or have no provider ──
const geocoded = automationCtx.geo.search('Bismis');
const reversed = automationCtx.geo.reverse({ lat: 1.33, lng: 103.77 });
is<Eq<Effect.Error<typeof geocoded>, FacilityFailure | Unavailable>>();
is<Eq<Effect.Error<typeof reversed>, FacilityFailure | Unavailable>>();
const availableGeo = geocoded.pipe(
	Effect.catchTag('Unavailable', (failure) => {
		is<Eq<typeof failure, Unavailable>>();
		return Effect.succeed(failure.reason);
	})
);
is<Eq<Effect.Error<typeof availableGeo>, FacilityFailure>>();
const recoveredGeo = availableGeo.pipe(
	Effect.catchTag('FacilityFailure', (failure) => {
		is<Eq<typeof failure, FacilityFailure>>();
		return Effect.succeed(failure.message);
	})
);
is<Eq<Effect.Error<typeof recoveredGeo>, never>>();
geocoded.pipe(
	// @ts-expect-error E12 geo does not fail with ActRefused
	Effect.catchTag('ActRefused', () => Effect.void)
);

// Attachment keeps the original argument tuple and successful result through the native generator boundary.
const typedProducer = function* (input: { count: number }, context: { suffix: string }) {
	if (input.count < 0) return yield* Effect.fail(new Refusal({ message: 'A count is positive.' }));
	return { count: yield* Effect.succeed(input.count + 1), suffix: context.suffix };
};
const attachedProducer = attached(typedProducer, 1);
is<Eq<Parameters<typeof attachedProducer>, [input: { count: number }, context: { suffix: string }]>>();
is<Eq<ReturnType<typeof attachedProducer>, Promise<{ count: number; suffix: string }>>>();
is<Eq<typeof typedProducer extends GeneratorBody<Parameters<typeof typedProducer>, { count: number; suffix: string }> ? true : false, true>>();
is<Eq<ReturnType<typeof attachedProducer> extends Promise<string> ? true : false, false>>();

const policyProducer = function* (input: { id: Id<'orders'> }) {
	void input;
	return Verdict.allow();
};
const attachedPolicy = attached_verdict(policyProducer, 1);
is<Eq<Parameters<typeof attachedPolicy>, [input: { id: Id<'orders'> }]>>();
is<Eq<ReturnType<typeof attachedPolicy>, Promise<VerdictData>>>();

// Runtime inspection does not manufacture a service-free or tagged-failure generator contract.
class Destination extends Context.Service<Destination, { readonly url: string }>()('types/Destination') {}
const unprovidedProducer = function* () { return (yield* Destination).url; };
const scalarProducer = function* () { yield 1; return 2; };
const untaggedProducer = function* () { return yield* Effect.fail('no'); };
is<Eq<typeof unprovidedProducer extends GeneratorBody<[], string> ? true : false, false>>();
is<Eq<typeof scalarProducer extends GeneratorBody<[], number> ? true : false, false>>();
is<Eq<typeof untaggedProducer extends GeneratorBody<[], never> ? true : false, false>>();

// ── a defaulted input field reaches the body filled: required there, optional to the starter ──
automation({
	description: 'Defaults',
	policies: ['sales_rep'],
	input: { unit: { kind: 'enum', values: ['a', 'b'], default: 'a' }, note: { kind: 'text', optional: true } },
	run: function* (input) {
		is<Eq<typeof input.unit, 'a' | 'b'>>();
		is<Eq<typeof input.note, string | null | undefined>>();
	}
});
