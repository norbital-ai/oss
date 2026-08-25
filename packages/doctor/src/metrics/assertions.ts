/**
 * Test-coverage-of-behaviour proxy: do the test functions actually assert?
 *
 * A test that runs without asserting is theatre — it can only fail by throwing. This pass finds
 * every `test`/`it` call (`describe` is grouping, not evidence) and counts assertion-shaped
 * calls: a bare `expect`/`assert` callee, or a property call whose name sits in the familiar
 * matcher set spanning node:assert and jest-style matchers. The set is textual, so a helper
 * named `equal` from some unrelated module counts too; the false positives are cheap next to
 * the false negatives of requiring imports, and the metric only ever feeds "this test asserts
 * nothing", where over-counting is the safe direction.
 *
 * `zeroAssertion` names each test whose own subtree contains no assertion call, tracking the
 * nearest enclosing test function — an inner `test` nested inside an outer one owns its own
 * subtree and stops the outer walk. Resolution is purely lexical: an assertion hidden inside a
 * helper the test calls is invisible here. That limit is accepted rather than approximated with
 * cross-file analysis, because the merged analyzer already owns reachability.
 */
import ts from 'typescript';

const TEST_FUNCTIONS = new Set(['test', 'it']);

const ASSERT_CALLEES = /^(expect|assert)$/;

const ASSERT_PROPERTIES = new Set([
	'ok',
	'is',
	'deepEqual',
	'equal',
	'match',
	'throws',
	'fail',
	'toBe',
	'toEqual',
	'toMatch',
	'toThrow',
	'toBeTruthy',
	'toBeFalsy',
	'toContain',
	'toHaveLength'
]);

function isTestCall(node: ts.Node): node is ts.CallExpression {
	return (
		ts.isCallExpression(node) &&
		ts.isIdentifier(node.expression) &&
		TEST_FUNCTIONS.has(node.expression.text)
	);
}

function isAssertionCall(node: ts.Node): boolean {
	if (!ts.isCallExpression(node)) return false;
	const target = node.expression;
	if (ts.isIdentifier(target)) return ASSERT_CALLEES.test(target.text);
	return ts.isPropertyAccessExpression(target) && ASSERT_PROPERTIES.has(target.name.text);
}

/** First argument as a displayable test name; anything else stays anonymous. */
function testNameOf(call: ts.CallExpression): string {
	const argument = call.arguments[0];
	if (!argument) return '<anonymous>';
	if (ts.isIdentifier(argument)) return argument.text;
	if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
		return argument.text;
	return '<anonymous>';
}

/**
 * Assertions within one subtree. The per-test check passes `skipNestedTests` so a nested
 * `test` owns its own assertions instead of vouching for its parent.
 */
function countAssertions(roots: ReadonlyArray<ts.Node>, skipNestedTests: boolean): number {
	let count = 0;
	const walk = (node: ts.Node): void => {
		if (skipNestedTests && isTestCall(node)) return;
		if (isAssertionCall(node)) count += 1;
		ts.forEachChild(node, walk);
	};
	for (const root of roots) walk(root);
	return count;
}

export type AssertionReport = Readonly<{
	testFunctions: number;
	assertions: number;
	zeroAssertion: ReadonlyArray<string>;
}>;

export function analyzeAssertions(file: ts.SourceFile): AssertionReport {
	const tests: Array<ts.CallExpression> = [];
	const walk = (node: ts.Node): void => {
		if (isTestCall(node)) tests.push(node);
		ts.forEachChild(node, walk);
	};
	walk(file);
	const zeroAssertion = tests
		.filter((call) => countAssertions(call.arguments, true) === 0)
		.map(testNameOf);
	return {
		testFunctions: tests.length,
		assertions: countAssertions([file], false),
		zeroAssertion
	};
}
