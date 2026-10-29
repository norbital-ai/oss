import { assert, it } from '@effect/vitest';
import { Effect } from 'effect';
import { Flattener } from '../src/engine/write/flatten.ts';
import { catalogOf } from '../src/engine/access/pred.ts';
import { manifest } from './query.fixture.ts';

it.effect('decimal flattening admits the sole wire tag and refuses other tagged shapes', () =>
	Effect.gen(function* () {
		const valid = new Flattener(manifest, catalogOf(manifest), () => 'one');
		valid.create('orders', { columns: ['total'] }, { total: { $dec: '1.20' } }, []);
		assert.strictEqual(valid.problems.length, 0);
		const invalid = new Flattener(manifest, catalogOf(manifest), () => 'two');
		invalid.create('orders', { columns: ['total'] }, { total: { $decimal: '1.20' } }, []);
		assert.deepStrictEqual(invalid.problems, [{ path: ['total'], message: 'expected a decimal' }]);
	})
);

it.effect(
	'a number for a decimal becomes the decimal its digits spell, before any callback reads it',
	() =>
		Effect.gen(function* () {
			const flat = new Flattener(manifest, catalogOf(manifest), () => 'three');
			flat.create('orders', { columns: ['total'] }, { total: 31.11 }, []);
			flat.create('orders', { columns: ['total'] }, { total: 1.5e-7 }, []);
			assert.strictEqual(flat.problems.length, 0);
			assert.deepStrictEqual(
				flat.items.map(({ change }) => (change.op === 'create' ? change.values['total'] : null)),
				[{ $dec: '31.11' }, { $dec: '0.00000015' }]
			);
		})
);

it.effect('an unknown field names the fields that may be written, and an invisible character in it', () =>
	Effect.gen(function* () {
		const flat = new Flattener(manifest, catalogOf(manifest), () => 'four');
		flat.create('orders', { columns: ['total', 'note'] }, { 'to​tal': { $dec: '1' } }, []);
		assert.deepStrictEqual(flat.problems, [
			{
				path: ['to​tal'],
				message:
					"'to​tal' is not a field of orders (the name holds invisible characters); its fields: total, note"
			}
		]);
	})
);
