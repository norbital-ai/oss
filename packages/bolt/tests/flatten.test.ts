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
