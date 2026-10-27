import { Effect, Schema } from 'effect';
import { pageServer } from '../../src/index.ts';
import type { PageData, PageLoad, PageReadContext, PageServer } from '../../src/index.ts';
import type { ReadFailed } from '../../src/decl/errors.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(..._proof: T extends true ? [] : never): void => {};

const Data = Schema.Struct({ title: Schema.String, count: Schema.Number });
const declaration = pageServer({
	data: Data,
	load: function* (request, ctx) {
		const read = ctx.query({ orders: { fields: ['number'], limit: 10 } });
		is<Eq<Effect.Error<typeof read>, ReadFailed>>();
		const orders = yield* read;
		const { customers } = yield* ctx.query({ customers: { limit: 1 } });
		return {
			title: `${request.pathname}${request.search}`,
			count: orders.orders.rows.length + customers.rows.length
		};
	}
});

is<Eq<PageData<typeof declaration>, typeof Data.Type>>();
is<
	Eq<
		Extract<
			keyof PageReadContext,
			| 'act'
			| 'schedule'
			| 'notify'
			| 'files'
			| 'web'
			| 'ai'
			| 'request'
			| 'refuse'
			| 'db'
			| 'secrets'
		>,
		never
	>
>();
is<
	Eq<(() => Promise<typeof Data.Type>) extends PageLoad<typeof Data.Type> ? true : false, false>
>();
is<Eq<(() => Generator<never, number>) extends PageLoad<typeof Data.Type> ? true : false, false>>();
is<Eq<typeof Schema.Unknown extends PageServer<unknown>['data'] ? true : false, false>>();
