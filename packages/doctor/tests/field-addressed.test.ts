/**
 * A pattern constrains the fields it names and stays silent about the rest.
 *
 * Comparison used to be positional over `forEachChild`, and TypeScript models `export`, type
 * annotations and type arguments as children. So `const $N = $V` had one child where
 * `export const a = 1` had two, `($V) => $V` did not match `(v: T) => v`, and
 * `const $N = new Map()` did not match `const $N = new Map<K, V>()`. Every declaration-form
 * pattern in every pack was blind to the spelling that matters, and three rules had already been
 * bent around it: `AL3` abandoned patterns for a regular expression, `Q1` carries a duplicate
 * `export function …` alternative, and `GUARD1` received neither and so reported only unexported
 * type guards.
 *
 * The other half is `unwrap`, which strips parentheses and `!` before every kind test. Applied to
 * the `kind` matcher it made two syntax kinds unnameable: the algebra could not say
 * `kind: NonNullExpression` at all, though the pattern form `$X!` matched it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { matchSource, type Matcher } from '../build/index.js';

function hits(matcher: Matcher, source: string): boolean {
	return matchSource(matcher, source);
}

test('a declaration pattern matches its exported spelling', () => {
	for (const [pattern, bare, exported] of [
		['const $N = $V', 'const a = 1;', 'export const a = 1;'],
		['class $N {}', 'class A {}', 'export class A {}'],
		['type $N = $T', 'type X = Y;', 'export type X = Y;'],
		[
			'function $N($X: unknown): $X is object { return true; }',
			'function f(v: unknown): v is object { return true; }',
			'export function f(v: unknown): v is object { return true; }'
		]
	] as ReadonlyArray<readonly [string, string, string]>) {
		assert.equal(hits(pattern, bare), true, `${pattern} must match ${bare}`);
		assert.equal(hits(pattern, exported), true, `${pattern} must match ${exported}`);
	}
});

test('a pattern that names a modifier still requires it', () => {
	assert.equal(hits('export const $N = $V', 'export const a = 1;'), true);
	assert.equal(hits('export const $N = $V', 'const a = 1;'), false);
	assert.equal(hits('declare const $N: $T', 'const a: number = 1;'), false);
});

test('modifiers are a set, so naming one does not exclude the others', () => {
	assert.equal(hits('async function $N() {}', 'export async function f() {}'), true);
	assert.equal(hits('async function $N() {}', 'function f() {}'), false);
});

test('an unnamed field is unconstrained, including type annotations and arguments', () => {
	// `IDENT1` could not see `onSuccess: (manifest: Manifest) => manifest` for this reason.
	assert.equal(hits('($V) => $V', '(v) => v;'), true);
	assert.equal(hits('($V) => $V', '(v: Manifest) => v;'), true);
	// `STATE2` could not see a typed collection for this reason.
	assert.equal(hits('const $N = new Map()', 'const c = new Map();'), true);
	assert.equal(hits('const $N = new Map()', 'const c = new Map<string, number>();'), true);
});

test('a named field still constrains arity, so a pattern does not widen', () => {
	assert.equal(hits('f()', 'f(a);'), false);
	assert.equal(hits('f($A)', 'f();'), false);
	assert.equal(hits('f($A)', 'f(a, b);'), false);
	assert.equal(hits('let $N = $V', 'const a = 1;'), false);
	assert.equal(hits('$A && $B', 'a || b;'), false);
});

test('strictness cst requires every field to correspond', () => {
	const exact: Matcher = { pattern: { context: 'const a = 1', strictness: 'cst' } };
	assert.equal(hits(exact, 'const a = 1;'), true);
	assert.equal(hits(exact, 'export const a = 1;'), false);
});

test('the kind matcher can name the two kinds unwrap strips', () => {
	assert.equal(hits({ kind: 'NonNullExpression' }, 'const v = maybe!;'), true);
	assert.equal(hits({ kind: 'ParenthesizedExpression' }, 'const v = (a);'), true);
	assert.equal(hits({ kind: 'NonNullExpression' }, 'const v = maybe;'), false);
});

test('the kind matcher still sees through a wrapper it does not name', () => {
	// The tolerance `unwrap` was added for: naming the inner kind matches the wrapped node.
	assert.equal(hits({ kind: 'CallExpression' }, 'const v = (f());'), true);
	assert.equal(hits({ kind: 'CallExpression' }, 'const v = f()!;'), true);
});
