import { assert, it } from '@effect/vitest';
import { Effect } from 'effect';
import { Flattener } from '../src/engine/write/flatten.ts';
import { catalog_of } from '../src/engine/access/pred.ts';
import { manifest } from './query.fixture.ts';

it.effect('decimal flattening admits the sole wire tag and refuses other tagged shapes', () =>
	Effect.gen(function* () {
		const valid = new Flattener(manifest, catalog_of(manifest), () => 'one');
		valid.create('orders', { columns: ['total'] }, { total: '1.20' }, []);
		assert.strictEqual(valid.problems.length, 0);
		const invalid = new Flattener(manifest, catalog_of(manifest), () => 'two');
		invalid.create('orders', { columns: ['total'] }, { total: { $decimal: '1.20' } }, []);
		assert.deepStrictEqual(invalid.problems, [{ path: ['total'], message: 'expected a decimal' }]);
	})
);

it.effect(
	'a number for a decimal becomes the decimal its digits spell, before any callback reads it',
	() =>
		Effect.gen(function* () {
			const flat = new Flattener(manifest, catalog_of(manifest), () => 'three');
			flat.create('orders', { columns: ['total'] }, { total: 31.11 }, []);
			flat.create('orders', { columns: ['total'] }, { total: 1.5e-7 }, []);
			assert.strictEqual(flat.problems.length, 0);
			assert.deepStrictEqual(
				flat.items.map(({ change }) => (change.op === 'create' ? change.values['total'] : null)),
				['31.11', '0.00000015']
			);
		})
);

it.effect('an unknown field names the fields that may be written, and an invisible character in it', () =>
	Effect.gen(function* () {
		const flat = new Flattener(manifest, catalog_of(manifest), () => 'four');
		flat.create('orders', { columns: ['total', 'note'] }, { 'to​tal': '1' }, []);
		assert.deepStrictEqual(flat.problems, [
			{
				path: ['to​tal'],
				message:
					"'to​tal' is not a field of orders (the name holds invisible characters); its fields: total, note"
			}
		]);
	})
);

it.effect('a phone field stores one spelling of a number, so uniqueness and matching see the same one', () =>
	Effect.gen(function* () {
		const orders = manifest.models['orders'];
		if (orders === undefined) throw new Error('No orders model');
		const phones = {
			...manifest,
			models: {
				...manifest.models,
				orders: {
					...orders,
					fields: { ...orders.fields, note: { kind: 'text' as const, format: 'phone' as const } }
				}
			}
		};
		const flat = new Flattener(phones, catalog_of(phones), () => 'five');
		for (const note of ['+65 9200 0002', '+65-9200-0002', '+6592000002', '9200 0002'])
			flat.create('orders', { columns: ['note'] }, { note }, []);
		assert.strictEqual(flat.problems.length, 0);
		assert.deepStrictEqual(
			flat.items.map(({ change }) => (change.op === 'create' ? change.values['note'] : null)),
			['+6592000002', '+6592000002', '+6592000002', '9200 0002']
		);
	})
);
