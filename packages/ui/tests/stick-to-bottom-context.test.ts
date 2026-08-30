// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldPreserveBottomLatchAfterUpwardScroll } from '../src/ai-elements/conversation/stick-to-bottom-context.svelte.ts';

const previous = { scrollHeight: 1_000, clientHeight: 400 };

test('preserves a bottom latch when shorter content clamps the scroll position upward', () => {
	assert.equal(
		shouldPreserveBottomLatchAfterUpwardScroll(
			previous,
			{ scrollHeight: 920, clientHeight: 400 },
			{ stuck: true, directManipulation: false }
		),
		true
	);
});

test('preserves a bottom latch when a taller viewport clamps the scroll position upward', () => {
	assert.equal(
		shouldPreserveBottomLatchAfterUpwardScroll(
			previous,
			{ scrollHeight: 1_000, clientHeight: 480 },
			{ stuck: true, directManipulation: false }
		),
		true
	);
});

test('never swallows direct manipulation or an already-unlatched position', () => {
	const contracted = { scrollHeight: 920, clientHeight: 400 };
	assert.equal(
		shouldPreserveBottomLatchAfterUpwardScroll(previous, contracted, {
			stuck: true,
			directManipulation: true
		}),
		false
	);
	assert.equal(
		shouldPreserveBottomLatchAfterUpwardScroll(previous, contracted, {
			stuck: false,
			directManipulation: false
		}),
		false
	);
});

test('treats an upward move at stable layout dimensions as a user scroll', () => {
	assert.equal(
		shouldPreserveBottomLatchAfterUpwardScroll(previous, previous, {
			stuck: true,
			directManipulation: false
		}),
		false
	);
});
