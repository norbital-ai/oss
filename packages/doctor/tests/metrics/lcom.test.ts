/**
 * LCOM (Henderson–Sellers) on classes whose numbers are derivable by inspection: a cohesive
 * class, a split one that hits the ceiling, the arrow-property idiom, and the null cases.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { lcomHendersonSellers } from '../../build/metrics/index.js';
import { classNamed } from '../fixtures/metrics/parse.ts';

test('a class where every method shares state is fully cohesive', () => {
	const source = `class Counter {
	count = 0;
	step = 1;
	increment(): void { this.count += this.step; }
	reset(): void { this.count = 0; }
	setStep(step: number): void { this.step = step; }
}`;
	// M=3, a=2, every method touches a field → |3−3|/(2·2) = 0
	assert.equal(lcomHendersonSellers(classNamed(source, 'Counter')), 0);
});

test('methods touching disjoint fields pull the score apart', () => {
	const source = `class Split {
	left = 0;
	right = 0;
	readLeft(): number { return this.left; }
	writeRight(value: number): void { this.right = value; }
	pure(input: number): number { return input * 2; }
}`;
	// M=3, a=2, Σα=2 → |3−2|/((3−1)·2) = 0.25
	assert.equal(lcomHendersonSellers(classNamed(source, 'Split')), 0.25);
});

test('mostly-unconnected methods clamp at the ceiling', () => {
	const source = `class Strangers {
	only = 0;
	touch(): void { this.only = 1; }
	first(): number { return 1; }
	second(): number { return 2; }
	third(): number { return 3; }
}`;
	// M=4, a=1, Σα=1 → |4−1|/(3·1) = 1 exactly
	assert.equal(lcomHendersonSellers(classNamed(source, 'Strangers')), 1);
});

test('arrow-valued properties count as methods', () => {
	const source = `class Ops {
	total = 0;
	add = (amount: number): void => { this.total += amount; };
	clear(): void { this.total = 0; }
}`;
	// M=2 (add + clear), a=1, Σα=2 → 0
	assert.equal(lcomHendersonSellers(classNamed(source, 'Ops')), 0);
});

test('bare identifiers never stand in for this-references', () => {
	const source = `class Shadowed {
	count = 0;
	bump(count: number): void { count = count + 1; }
}`;
	// The method only rebinds its parameter; α=0 → M=1 → null regardless
	assert.equal(lcomHendersonSellers(classNamed(source, 'Shadowed')), null);
});

test('nothing measurable returns null', () => {
	const staticOnly = `class Util {
	static help(): number { return 1; }
	static base = 2;
}`;
	assert.equal(lcomHendersonSellers(classNamed(staticOnly, 'Util')), null);

	const singleMethod = `class Lone {
	value = 0;
	only(): void { this.value = 1; }
}`;
	assert.equal(lcomHendersonSellers(classNamed(singleMethod, 'Lone')), null);

	const fieldless = `class Pure {
	run(): number { return 42; }
}`;
	assert.equal(lcomHendersonSellers(classNamed(fieldless, 'Pure')), null);
});

test('statics stay out of both sides of the fraction', () => {
	const source = `class Mixed {
	instanceField = 0;
	static shared = 1;
	touchesInstance(): void { this.instanceField = 2; }
	touchesStatic(): void { Mixed.shared = 3; }
}`;
	// M counts only instance methods (2); a=1; Σα=1 → |2−1|/(1·1) = 1
	assert.equal(lcomHendersonSellers(classNamed(source, 'Mixed')), 1);
});
