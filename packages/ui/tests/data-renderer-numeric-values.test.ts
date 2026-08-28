// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import { coerceNumericValue } from '../src/data-renderer/numeric/numeric.values.ts';

test('numeric renderers accept finite database decimal strings', () => {
	assert.equal(coerceNumericValue('1724.00'), 1724);
	assert.equal(coerceNumericValue('-43.75'), -43.75);
});

test('numeric renderers refuse blank, non-numeric, and non-finite values', () => {
	assert.equal(coerceNumericValue(''), null);
	assert.equal(coerceNumericValue('not-a-number'), null);
	assert.equal(coerceNumericValue(Number.POSITIVE_INFINITY), null);
});
