// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import { instantFieldAllowsClear } from '../src/data-renderer/time_stamp/timestamp.utils.ts';

test('scalar instant fields follow their nullable clear contract', () => {
	assert.equal(instantFieldAllowsClear({ nullable: false }), false);
	assert.equal(instantFieldAllowsClear({ nullable: true }), true);
});

test('instant arrays remain clearable because their empty value is an array, not null', () => {
	assert.equal(instantFieldAllowsClear({ array: true, nullable: false }), true);
	assert.equal(instantFieldAllowsClear({ array: true, nullable: true }), true);
});
