/**
 * Main-sequence arithmetic: the identity cases that define the diagonal, the zones of pain,
 * the zero-denominator nulls, and what counts as abstract.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { abstractness, countAbstractDeclarations, distanceFromMainSequence, instability } from '../build/metrics/index.js';
import { parse } from './fixtures/metrics/parse.ts';

test('the main sequence is A + I = 1', () => {
	for (const point of [
		{ abstractness: 0.5, instability: 0.5 },
		{ abstractness: 0, instability: 1 },
		{ abstractness: 1, instability: 0 },
		{ abstractness: 0.25, instability: 0.75 }
	])
		assert.equal(distanceFromMainSequence(point), 0);
});

test('both zones of pain measure symmetrically', () => {
	assert.equal(distanceFromMainSequence({ abstractness: 0, instability: 0 }), 1);
	assert.equal(distanceFromMainSequence({ abstractness: 1, instability: 1 }), 1);
	assert.ok(Math.abs(distanceFromMainSequence({ abstractness: 0.9, instability: 0.4 }) - 0.3) < 1e-12);
});

test('ratios are their definitions, with nulls at empty denominators', () => {
	assert.equal(abstractness({ abstractCount: 3, concreteCount: 1 }), 0.75);
	assert.equal(abstractness({ abstractCount: 0, concreteCount: 0 }), null);
	assert.equal(instability({ efferent: 1, afferent: 3 }), 0.25);
	assert.equal(instability({ efferent: 0, afferent: 0 }), null);
});

test('interfaces, type aliases, and abstract members are the abstract surface', () => {
	const source = `export interface Shape { area(): number; }
export type Id = string;
export abstract class Base {
	abstract draw(): void;
	abstract get scale(): number;
	filled(): boolean { return true; }
}
export class Impl extends Base {
	draw(): void {}
	get scale(): number { return 1; }
}`;
	// interface + type alias + abstract method + abstract accessor = 4
	assert.equal(countAbstractDeclarations(parse(source)), 4);
});
