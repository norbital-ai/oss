/**
 * Cognitive Complexity, pinned by hand-computed values.
 *
 * Every expectation below is derived in a comment next to it. The progression walks the scoring
 * rules one at a time — flat structures, else-chains, nesting increments, logical sequences,
 * switch clauses, and finally everything at once.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { cognitiveComplexity } from '../../build/metrics/index.js';
import { arrowNamed, fnNamed } from '../fixtures/metrics/parse.ts';

const methodOf = (source: string): ts.MethodDeclaration => {
	const file = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
	const found = file.statements.find(
		(statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement)
	)?.members.find((member): member is ts.MethodDeclaration => ts.isMethodDeclaration(member));
	if (!found) throw new Error('fixture lost method');
	return found;
};

test('a flat if scores 1', () => {
	const source = `function flat(x: number): number {
	if (x > 0) return 1;
	return 0;
}`;
	// if at depth 0 → +1
	assert.equal(cognitiveComplexity(fnNamed(source, 'flat')), 1);
});

test('an else-if ladder stays linear at one point per link', () => {
	const source = `function ladder(a: boolean, b: boolean): string {
	if (a) return 'a';
	else if (b) return 'b';
	else return 'c';
}`;
	// if +1 (depth 0), the `if` of `else if` +1 flat (the else rule), bare else +1
	assert.equal(cognitiveComplexity(fnNamed(source, 'ladder')), 3);
});

test('loops nest: an if inside a for costs its depth', () => {
	const source = `function sum(list: ReadonlyArray<{ skip: boolean; value: number | null }>): number {
	let total = 0;
	for (const item of list) {
		if (item.skip) continue;
		total += item.value ?? 0;
	}
	return total;
}`;
	// for-of +1; if nested inside → +1+1 = 2; ?? deliberately uncounted
	assert.equal(cognitiveComplexity(fnNamed(source, 'sum')), 3);
});

test('a run of one logical operator scores once; mixing operators opens a new run', () => {
	const pure = `function pure(a: boolean, b: boolean, c: boolean, d: boolean): boolean {
	return a && b && c && d;
}`;
	// one maximal && run → +1
	assert.equal(cognitiveComplexity(fnNamed(pure, 'pure')), 1);

	const mixed = `function mixed(a: boolean, b: boolean, c: boolean, d: boolean): boolean {
	return (a && b) || (c && d);
}`;
	// && run +1, || new run +1, second && cannot inherit across the || operand → +1
	assert.equal(cognitiveComplexity(fnNamed(mixed, 'mixed')), 3);

	const guarded = `function guarded(a: () => boolean, b: () => boolean, c: () => boolean): boolean {
	return f(a() && b()) && c();
	function f(x: boolean): boolean {
		return x;
	}
}`;
	// outer && +1; the inner && sits in an unrelated subexpression, so its run starts fresh → +1
	assert.equal(cognitiveComplexity(fnNamed(guarded, 'guarded')), 2);
});

test('ternaries score flat even under nesting', () => {
	const source = `function pick(a: number | undefined): number {
	if (a !== undefined) return a > 0 ? a : -a;
	return 0;
}`;
	// if +1; ternary +1 flat despite sitting at depth 1
	assert.equal(cognitiveComplexity(fnNamed(source, 'pick')), 2);
});

test('switch charges per case clause, default is free, case bodies are nested', () => {
	const source = `function shape(input: string): string {
	switch (input) {
		case 'dot':
			return '.';
		case 'dash': {
			if (input.length > 4) return input.toUpperCase();
			break;
		}
		default:
			break;
	}
	return '';
}`;
	// two cases +2; the if inside the case body sits at depth 1 → +2; default +0
	assert.equal(cognitiveComplexity(fnNamed(source, 'shape')), 4);
});

test('nesting accumulates per enclosing control level', () => {
	const source = `function deep(a: boolean, b: boolean): number {
	try {
		if (a) {
			for (;;) {
				while (b) {
					do {
						a ? 1 : 0;
					} while (a);
				}
			}
		}
	} catch {
		throw new Error('unreachable');
	}
	return 0;
}`;
	// try free; if d0 +1; for d1 +2; while d2 +3; do d3 +4; ternary flat +1; catch d0 +1 → 12
	assert.equal(cognitiveComplexity(fnNamed(source, 'deep')), 12);
});

test('catch clauses nest like any control structure', () => {
	const source = `function guard(a: boolean): void {
	try {
		if (a) throw new Error('x');
	} catch {
		if (!a) throw new Error('y');
	}
}`;
	// if +1; catch d0 +1; the catch-body if sits at depth 1 → +2 → 4
	assert.equal(cognitiveComplexity(fnNamed(source, 'guard')), 4);
});

test('nested function-likes short-circuit: closures are their own units', () => {
	const source = `function outer(items: ReadonlyArray<{ ok: boolean; ready: boolean }>): unknown | null {
	const ready = items.filter((item) => item.ok && item.ready);
	if (ready.length > 0) return ready[0];
	return null;
}`;
	// the arrow's && run belongs to the arrow; only the outer if counts here → 1
	assert.equal(cognitiveComplexity(fnNamed(source, 'outer')), 1);

	const arrow = `const matcher = (item: { ok: boolean; ready: boolean }): boolean => item.ok && item.ready;`;
	// one && run → 1
	assert.equal(cognitiveComplexity(arrowNamed(arrow, 'matcher')), 1);
});

test('methods measure like functions', () => {
	const source = `class Gate {
	open(key: string): boolean {
		if (key === 'master') return true;
		return key.length > 3 ? true : false;
	}
}`;
	// if +1; ternary +1 flat → 2
	assert.equal(cognitiveComplexity(methodOf(source)), 2);
});

test('bodyless declarations score 0 and non-function nodes throw', () => {
	const source = 'declare function ambient(input: string): string;';
	assert.equal(cognitiveComplexity(fnNamed(source, 'ambient')), 0);
	assert.throws(() => cognitiveComplexity(ts.factory.createIdentifier('nope')), /norbital-doctor:/);
});
