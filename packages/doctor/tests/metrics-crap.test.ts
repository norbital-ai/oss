/**
 * CRAP across the whole grid the formula cares about: complexity 1..5 against full, half, and
 * zero coverage. Every cell hand-computed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { crap } from '../build/metrics/index.js';

const EXPECTED: ReadonlyArray<ReadonlyArray<number | null>> = [
	//        cov=1   cov=0.5              cov=0
	[1, 0.625, 1],
	[1, 1.0, 4],
	[1, 1.625, 9],
	[1, 2.5, 16],
	[1, 3.625, 25]
];

test('comp²·(1−cov)³+cov over complexity 1..5 × coverage {1, 0.5, 0}', () => {
	EXPECTED.forEach((row, index) => {
		const comp = index + 1;
		assert.equal(crap(comp, 1), row[0], `comp=${comp}, cov=1`);
		assert.ok(Math.abs((crap(comp, 0.5) ?? NaN) - (row[1] ?? NaN)) < 1e-12, `comp=${comp}, cov=0.5`);
		assert.equal(crap(comp, 0), row[2], `comp=${comp}, cov=0`);
	});
});

test('full coverage collapses any complexity to the coverage floor', () => {
	// comp² · 0³ + 1 = 1 regardless of complexity — covered code is risk-free by definition.
	assert.equal(crap(31, 1), 1);
	assert.equal(crap(1, 1), 1);
	// 31² · 0.1³ + 0.9 = 0.961 + 0.9 = 1.861
	assert.ok(Math.abs((crap(31, 0.9) ?? NaN) - 1.861) < 1e-12);
});

test('missing coverage data propagates as null rather than pretending zero', () => {
	assert.equal(crap(7, null), null);
});

test('coverage outside 0..1 throws with the package prefix', () => {
	assert.throws(() => crap(3, 1.5), /norbital-doctor:/);
	assert.throws(() => crap(3, -0.1), /norbital-doctor:/);
});
