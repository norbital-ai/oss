import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { catalogOf, order } from '../src/index.ts';

const catalog = catalogOf({
	tables: {
		customer: { fields: { name: { kind: 'text' } } },
		order: {
			key: 'identity',
			fields: {
				customer: { kind: 'ref', to: 'customer' },
				address: {
					kind: 'object',
					fields: {
						location: { kind: 'object', fields: { city: { kind: 'text' } } }
					}
				}
			}
		},
		line: { fields: { order: { kind: 'ref', to: 'order' } } }
	}
});

it.effect('separates nested relation sorts from dotted inline paths and root primary keys', () =>
	Effect.gen(function* () {
		expect(yield* order({ customer: { name: 'asc' } }, catalog, 'order')).toEqual([
			{ field: 'customer.name', dir: 'asc' }
		]);
		expect(yield* order({ order: { customer: { name: 'desc' } } }, catalog, 'line')).toEqual([
			{ field: 'order.customer.name', dir: 'desc' }
		]);
		expect(yield* order({ 'address.location.city': 'asc' }, catalog, 'order')).toEqual([
			{ field: 'address.location.city', dir: 'asc' }
		]);
		expect(yield* order('id', catalog, 'order')).toEqual([{ field: 'id', dir: 'asc' }]);
		expect(yield* order('id', catalog, 'customer')).toEqual([{ field: 'id', dir: 'asc' }]);
		for (const { model, invalid } of [
			{ model: 'order', invalid: { 'customer.name': 'asc' } },
			{ model: 'line', invalid: { order: { 'customer.name': 'asc' } } },
			{ model: 'order', invalid: { customer: { id: 'asc' } } },
			{ model: 'order', invalid: 'customer.name' }
		]) {
			const failure = yield* Effect.flip(order(invalid, catalog, model));
			expect(failure.code).toBe('invalid');
		}
	})
);
