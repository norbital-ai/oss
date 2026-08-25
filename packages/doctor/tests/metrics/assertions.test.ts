/**
 * Assertion detection: describe is grouping, only test/it are tests; zero-assertion tests get
 * named with their nearest enclosing test function.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeAssertions } from '../../build/metrics/index.js';
import { parse } from '../fixtures/metrics/parse.ts';

test('tests without assertions are named and shamed', () => {
	const source = `describe('suite', () => {});
test('has assertions', () => {
	expect(1 + 1).toBe(2);
});
it('asserts nothing', () => {
	helper();
});
test(label, () => {
	console.log('quiet');
});`;
	const report = analyzeAssertions(parse(source));
	assert.equal(report.testFunctions, 3);
	assert.equal(report.assertions, 2); // toBe property call + the bare expect callee itself
	assert.deepEqual(report.zeroAssertion, ['asserts nothing', 'label']);
});

test('property-style matchers across both dialects count', () => {
	const source = `test('node style', () => {
	assert.equal(a, b);
	assert.ok(c, 'truthy');
});
it('jest style', () => {
	expect(list).toContain(item);
	expect(wrapped).toHaveLength(2);
});`;
	const report = analyzeAssertions(parse(source));
	assert.equal(report.testFunctions, 2);
	// Each expect(...) chain matches twice — the bare callee and its property matcher:
	// assert.equal, assert.ok, then expect+toContain, expect+toHaveLength.
	assert.equal(report.assertions, 6);
	assert.deepEqual(report.zeroAssertion, []);
});

test('a nested test owns its own assertions, not its parent', () => {
	const source = `test('outer', () => {
	test('inner', () => {
		expect(value).toBeTruthy();
	});
});`;
	const report = analyzeAssertions(parse(source));
	assert.equal(report.testFunctions, 2);
	assert.deepEqual(report.zeroAssertion, ['outer']);
});

test('non-matching callees stay invisible', () => {
	const source = `test('calls helpers', () => {
	logger.log(x);
	equalize(a, b);
});`;
	const report = analyzeAssertions(parse(source));
	assert.equal(report.assertions, 0);
	assert.deepEqual(report.zeroAssertion, ['calls helpers']);
});
