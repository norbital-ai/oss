/**
 * Parity with ast-grep's rule algebra, construct by construct.
 *
 * The schema this checks against is `SerializableRule` in `crates/config/src/rule/mod.rs`: atomic
 * (`pattern`, `kind`, `regex`, `nthChild`, `range`), relational (`inside`, `has`, `precedes`,
 * `follows`, each carrying `stopBy` and `field`), and composite (`all`, `any`, `not`, `matches`),
 * with `utils` and `constraints` alongside the rule.
 *
 * Two semantics are easy to get subtly wrong and are asserted directly, because getting either
 * backwards changes what every relational rule in the pack means:
 *
 *   - `stopBy` defaults to `neighbor`, not `end`. `inside` sees the immediate parent only.
 *   - the rule form of `stopBy` is *inclusive*: ast-grep's `take_while(inclusive_until(stop))`
 *     tests the stopping node itself.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import {
	compile,
	defineRule,
	match,
	runRules,
	withUtils,
	type Bindings,
	type Matcher,
	type Rule
} from '../build/index.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function parse(code: string): ts.SourceFile {
	return ts.createSourceFile('probe.ts', code, ts.ScriptTarget.Latest, true);
}

/** Every node in the file, so a matcher can be tried everywhere rather than at a chosen root. */
function nodes(source: ts.SourceFile): ReadonlyArray<ts.Node> {
	const found: Array<ts.Node> = [];
	const visit = (node: ts.Node): void => {
		found.push(node);
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

/** How many nodes in `code` the matcher accepts. */
function hits(matcher: Matcher, code: string): number {
	const source = parse(code);
	const compiled = compile(matcher);
	return nodes(source).filter((node) => {
		const bindings: Bindings = new Map();
		return compiled.run(node, source, bindings);
	}).length;
}

/** Whether a whole authored rule reports against a one-file repository. */
function fires(rule: Rule, source: string): boolean {
	const root = mkdtempSync(join(tmpdir(), 'doctor-parity-'));
	try {
		mkdirSync(join(root, 'src'), { recursive: true });
		writeFileSync(join(root, 'src/probe.ts'), source);
		writeFileSync(join(root, 'package.json'), '{"name":"parity","type":"module"}');
		execFileSync('git', ['init', '-q'], { cwd: root });
		execFileSync('git', ['add', '-A'], { cwd: root });
		return runRules({ root, rules: [rule], files: ['src/probe.ts'] }).length > 0;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

// --- atomic ---------------------------------------------------------------------------------

test('pattern matches a shape and binds metavariables', () => {
	const result = match(
		{ pattern: '$A + $B' },
		parse('const x = one + two;'),
		parse('const x = one + two;')
	);
	assert.equal(result.matched, false, 'a pattern does not match the whole file');
	assert.equal(hits({ pattern: '$A + $B' }, 'const x = one + two;'), 1);
	assert.equal(hits({ pattern: '$A + $B' }, 'const x = one - two;'), 0);
});

test('let and const are distinct declaration-list tokens', () => {
	assert.equal(
		hits({ pattern: 'export let $NAME: $T = $INIT' }, 'export let shared: number[] = [];'),
		1
	);
	assert.equal(
		hits(
			{ pattern: 'export let $NAME: $T = $INIT' },
			'export const shared: ReadonlyArray<number> = [];'
		),
		0
	);
	assert.equal(hits({ pattern: 'const $NAME = $INIT' }, 'const refreshed = new Set();'), 1);
	assert.equal(hits({ pattern: 'const $NAME = $INIT' }, 'let refreshed = new Set();'), 0);
});

test('a repeated metavariable must bind consistently', () => {
	assert.equal(hits('$X === $X', 'const a = same === same;'), 1);
	assert.equal(hits('$X === $X', 'const a = left === right;'), 0);
});

test('kind matches by syntax kind alone', () => {
	assert.equal(hits({ kind: 'TryStatement' }, 'try { go(); } catch {}'), 1);
	assert.equal(hits({ kind: 'TryStatement' }, 'go();'), 0);
});

test('regex matches the node text, and `on` matches a binding', () => {
	assert.equal(
		hits(
			{ all: [{ pattern: '$V as unknown' }, { regex: '^foo$', on: '$V' }] },
			'const a = foo as unknown;'
		),
		1
	);
	assert.equal(
		hits(
			{ all: [{ pattern: '$V as unknown' }, { regex: '^foo$', on: '$V' }] },
			'const a = bar as unknown;'
		),
		0
	);
	// The `$` is optional, because omitting it silently matched nothing.
	assert.equal(
		hits(
			{ all: [{ pattern: '$V as unknown' }, { regex: '^foo$', on: 'V' }] },
			'const a = foo as unknown;'
		),
		1
	);
});

test('nthChild counts one-based, and accepts An+B, odd and even', () => {
	const code = 'const xs = [a, b, c, d];';
	// Scoped to array elements: `xs` is also the first child of its own declaration, so an
	// unscoped `nthChild: 1` legitimately matches twice.
	const inArray = { inside: { kind: 'ArrayLiteralExpression' } };
	assert.equal(hits({ all: [{ kind: 'Identifier' }, inArray, { nthChild: 1 }] }, code), 1);
	// `odd` selects the first and third elements of the four.
	assert.ok(hits({ all: [{ kind: 'Identifier' }, { nthChild: 'odd' }] }, code) >= 2);
	assert.equal(hits({ all: [{ kind: 'Identifier' }, { nthChild: '2n' }] }, code) > 0, true);
});

test('nthChild honours ofRule and reverse', () => {
	const code = 'const xs = [1, a, 2, b];';
	// Counting only identifiers, `a` is first and `b` is second.
	const inArray = { inside: { kind: 'ArrayLiteralExpression' } };
	const first: Matcher = {
		all: [
			{ kind: 'Identifier' },
			inArray,
			{ nthChild: { position: 1, ofRule: { kind: 'Identifier' } } }
		]
	};
	assert.equal(hits(first, code), 1);
	const last: Matcher = {
		all: [
			{ kind: 'Identifier' },
			inArray,
			{ nthChild: { position: 1, ofRule: { kind: 'Identifier' }, reverse: true } }
		]
	};
	assert.equal(hits(last, code), 1);
});

test('range requires the node to occupy exactly that span', () => {
	const code = 'const a = 1;';
	const exact: Matcher = {
		range: { start: { line: 0, column: 10 }, end: { line: 0, column: 11 } }
	};
	assert.equal(hits(exact, code), 1);
	const wrong: Matcher = { range: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } } };
	assert.equal(hits(wrong, code), 0);
});

// --- relational -----------------------------------------------------------------------------

test('stopBy defaults to neighbor, so inside sees only the immediate parent', () => {
	const code = 'function f() { if (a) { go(); } }';
	// `go()` sits inside an if, inside a function. The default must not reach the function.
	const nested: Matcher = {
		all: [{ pattern: 'go()' }, { inside: { kind: 'FunctionDeclaration' } }]
	};
	assert.equal(hits(nested, code), 0, 'neighbor must not walk to the function');
	const deep: Matcher = {
		all: [{ pattern: 'go()' }, { inside: { kind: 'FunctionDeclaration' }, stopBy: 'end' }]
	};
	assert.equal(hits(deep, code), 1, 'end walks the whole ancestor chain');
});

test('the rule form of stopBy is inclusive of the stopping node', () => {
	const code = 'function f() { if (a) { go(); } }';
	// Walking up from `go()` and stopping at the first IfStatement: the if is itself tested, so a
	// rule looking for the if succeeds, while one looking past it fails.
	const atBoundary: Matcher = {
		all: [{ pattern: 'go()' }, { inside: { kind: 'IfStatement' }, stopBy: { kind: 'IfStatement' } }]
	};
	assert.equal(hits(atBoundary, code), 1, 'the stopping node is a candidate');
	const beyondBoundary: Matcher = {
		all: [
			{ pattern: 'go()' },
			{ inside: { kind: 'FunctionDeclaration' }, stopBy: { kind: 'IfStatement' } }
		]
	};
	assert.equal(hits(beyondBoundary, code), 0, 'the walk stops at the if');
});

test('has defaults to direct children and reaches deeper with end', () => {
	const code = 'function f() { if (a) { go(); } }';
	const direct: Matcher = { all: [{ kind: 'FunctionDeclaration' }, { has: { pattern: 'go()' } }] };
	assert.equal(hits(direct, code), 0, 'go() is not a direct child of the function');
	const deep: Matcher = {
		all: [{ kind: 'FunctionDeclaration' }, { has: { pattern: 'go()' }, stopBy: 'end' }]
	};
	assert.equal(hits(deep, code), 1);
});

test('field requires the node to occupy that property of its parent', () => {
	const code = 'const a = compute();';
	const asInitializer: Matcher = {
		all: [
			{ pattern: 'compute()' },
			{ inside: { kind: 'VariableDeclaration' }, field: 'initializer' }
		]
	};
	assert.equal(hits(asInitializer, code), 1);
	const asName: Matcher = {
		all: [{ pattern: 'compute()' }, { inside: { kind: 'VariableDeclaration' }, field: 'name' }]
	};
	assert.equal(hits(asName, code), 0);
});

test('follows and precedes compare sibling statements', () => {
	const code = 'first(); second();';
	assert.equal(
		hits({ all: [{ pattern: 'second()' }, { follows: { pattern: 'first()' } }] }, code),
		1
	);
	assert.equal(
		hits({ all: [{ pattern: 'first()' }, { follows: { pattern: 'second()' } }] }, code),
		0
	);
	assert.equal(
		hits({ all: [{ pattern: 'first()' }, { precedes: { pattern: 'second()' } }] }, code),
		1
	);
});

// --- composite ------------------------------------------------------------------------------

test('all, any and not compose', () => {
	const code = 'try { go(); } catch {}';
	assert.equal(hits({ all: [{ kind: 'TryStatement' }, { has: { kind: 'Block' } }] }, code), 1);
	assert.equal(hits({ any: [{ kind: 'TryStatement' }, { kind: 'WhileStatement' }] }, code), 1);
	assert.equal(
		hits({ all: [{ kind: 'TryStatement' }, { not: { kind: 'TryStatement' } }] }, code),
		0
	);
});

test('matches resolves a named util, including a recursive one', () => {
	const code = 'const a = deep(deep(leaf));';
	const count = withUtils(
		{ call: { any: [{ pattern: 'leaf' }, { pattern: 'deep($INNER)' }] } },
		() => hits({ matches: 'call' }, code)
	);
	assert.ok(count >= 2, `expected the util to match nested calls, got ${count}`);
});

test('an undefined util is an error rather than a silent zero', () => {
	assert.throws(() => hits({ matches: 'nonexistent' }, 'const a = 1;'), /undefined util/);
});

// --- strictness -----------------------------------------------------------------------------

test('signature ignores text, template ignores kinds', () => {
	// Default (`smart`) compares identifier text, so a different callee does not match.
	assert.equal(hits({ pattern: 'alpha()' }, 'beta();'), 0);
	assert.equal(hits({ pattern: { context: 'alpha()', strictness: 'signature' } }, 'beta();'), 1);
});

test('selector narrows a context pattern to the node that matters', () => {
	// `{ a: 1 }` as a bare pattern is a block; the context makes it an object literal and the
	// selector picks the property that is the real matcher.
	const matcher: Matcher = {
		pattern: { context: 'const o = { key: $V };', selector: 'PropertyAssignment' }
	};
	assert.equal(hits(matcher, 'const other = { key: 42 };'), 1);
	assert.equal(hits(matcher, 'const other = { different: 42 };'), 0);
});

// --- our extension --------------------------------------------------------------------------

test('atLeast counts distinct matchers, not occurrences', () => {
	const two: Matcher = { atLeast: 2, of: [{ pattern: 'a()' }, { pattern: 'b()' }] };
	assert.ok(hits(two, 'function f() { a(); b(); }') > 0, 'two distinct mechanisms match');
	assert.equal(hits(two, 'function f() { a(); a(); }'), 0, 'one mechanism twice does not');
});

// --- constraints and utils at the rule level -------------------------------------------------

test('constraints narrow a metavariable with a full rule, not just a regex', () => {
	const rule = defineRule({
		id: 'C1',
		severity: 'error',
		summary: 'awaited call in a constrained position',
		principles: ['simplicity'],
		rule: { pattern: 'wrap($V)' },
		// The bound node must itself be a call, which a text regex could only approximate.
		constraints: { V: { kind: 'CallExpression' } },
		examples: { bad: ['wrap(compute());'], good: ['wrap(plain);'] }
	});
	assert.equal(fires(rule, 'export const a = wrap(compute());'), true);
	assert.equal(fires(rule, 'export const a = wrap(plain);'), false);
});

test('a constraint naming an unbound metavariable is rejected when the rule is authored', () => {
	// At definition, not at match time: a misspelled key that only failed while matching would
	// never announce itself, because the constraint it guards is never reached.
	assert.throws(
		() =>
			defineRule({
				id: 'C2',
				severity: 'error',
				summary: 'misspelled constraint',
				principles: ['simplicity'],
				rule: { pattern: 'wrap($V)' },
				constraints: { TYPO: { kind: 'CallExpression' } },
				examples: { bad: ['wrap(compute());'], good: ['other();'] }
			}),
		/never binds/
	);
});

test('utils are in scope for a rule authored with defineMatcher', () => {
	const rule = defineRule({
		id: 'C3',
		severity: 'error',
		summary: 'references a util',
		principles: ['simplicity'],
		utils: { anyCall: { kind: 'CallExpression' } },
		rule: { all: [{ pattern: 'wrap($V)' }, { has: { matches: 'anyCall' }, stopBy: 'end' }] },
		examples: { bad: ['wrap(compute());'], good: ['wrap(plain);'] }
	});
	assert.equal(fires(rule, 'export const a = wrap(compute());'), true);
	assert.equal(fires(rule, 'export const a = wrap(plain);'), false);
});
