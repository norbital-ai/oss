import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getErrorMessage } from '../src/error/index.ts';
import { safeParse } from '../src/json/index.ts';

describe('retained core utilities', () => {
	it('parses valid JSON and returns null at the invalid boundary', () => {
		assert.deepEqual(safeParse('{"ready":true}'), { ready: true });
		assert.equal(safeParse('{not json'), null);
	});

	it('extracts a synchronous message without changing the input shape', () => {
		assert.equal(getErrorMessage(new Error('failed')), 'failed');
		assert.equal(getErrorMessage('refused'), 'refused');
		assert.equal(getErrorMessage({ message: 409 }), '409');
		assert.equal(getErrorMessage(false), 'false');
	});
});
