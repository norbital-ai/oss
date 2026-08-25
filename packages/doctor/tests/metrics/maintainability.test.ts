/**
 * Maintainability Index: monotone in each input, clamped at both ends, 100 for empty bodies.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { maintainabilityIndex } from '../../build/metrics/index.js';

test('the SEI constants reproduce the textbook value', () => {
	// 171 − 5.2·ln100 − 0.23·1 − 16.2·ln10 = 109.5212… → ·100/171 = 64.0475…
	assert.ok(
		Math.abs(
			maintainabilityIndex({ volume: 100, cyclomatic: 1, loc: 10 }) - 64.0475067
		) < 0.0001
	);
});

test('more of anything never helps', () => {
	const base = { volume: 200, cyclomatic: 5, loc: 50 };
	for (const [key, heavier] of [
		['volume', 400],
		['cyclomatic', 20],
		['loc', 120]
	] as const) {
		assert.ok(
			maintainabilityIndex(base) > maintainabilityIndex({ ...base, [key]: heavier }),
			`${key} must lower the index`
		);
	}
});

test('empty bodies score exactly 100 instead of dividing by ln(0)', () => {
	assert.equal(maintainabilityIndex({ volume: 0, cyclomatic: 12, loc: 40 }), 100);
	assert.equal(maintainabilityIndex({ volume: 300, cyclomatic: 3, loc: 0 }), 100);
});

test('the clamp holds at both ends', () => {
	assert.equal(maintainabilityIndex({ volume: 1e6, cyclomatic: 60, loc: 2e4 }), 0);
	assert.equal(maintainabilityIndex({ volume: 1, cyclomatic: 0, loc: 1 }), 100);
});
