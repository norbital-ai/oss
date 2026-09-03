/**
 * Halstead volume against one hand-enumerated token stream.
 *
 * `const inc = (n) => n + 1;` yields, in order: const kw | inc id | = punct | ( punct | n id
 * | ) punct | => punct | n id | + punct | 1 numeric | ; punct — 7 operator occurrences over 7
 * distinct keys, 4 operand occurrences over 3 distinct ({inc, n, 1}). Length 11, vocabulary 10,
 * volume 11·log2(10) ≈ 36.5412.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { halsteadVolume } from '../build/metrics/index.js';
import { arrowNamed, parse } from './fixtures/metrics/parse.ts';

test('the canonical one-liner matches the hand enumeration', () => {
	const metrics = halsteadVolume(parse('const inc = (n) => n + 1;\n'));
	assert.equal(metrics.length, 11);
	assert.equal(metrics.vocabulary, 10);
	assert.ok(Math.abs(metrics.volume - 36.5412) < 0.001);
});

test('an arrow body measures only itself', () => {
	const arrow = `const matcher = (item) => item.ok && item.ok;`;
	const metrics = halsteadVolume(arrowNamed(arrow, 'matcher'));
	// Operators: ( ) => . . && — 6 uses over 5 distinct keys.
	// Operands: item item item ok ok — 5 uses over 2 distinct.
	assert.equal(metrics.length, 11);
	assert.equal(metrics.vocabulary, 7);
	// 11·log2(7) ≈ 30.880904142…
	assert.ok(Math.abs(metrics.volume - 30.880904142098773) < 1e-9);
});

test('comments and whitespace contribute nothing', () => {
	const commented = `// eslint-disable-next-line no-comment
const one = 1; /* @ts-ignore */`;
	const bare = 'const one = 1;';
	assert.deepEqual(halsteadVolume(parse(commented)), halsteadVolume(parse(bare)));
});

test('empty and single-token bodies collapse to volume 0', () => {
	assert.deepEqual(halsteadVolume(parse('')), { length: 0, vocabulary: 0, volume: 0 });
	// two semicolons: length 2, but vocabulary 1 → log2 undefined territory, defined as 0
	assert.deepEqual(halsteadVolume(parse(';;')), { length: 2, vocabulary: 1, volume: 0 });
});
