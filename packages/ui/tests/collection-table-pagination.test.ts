// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	collectionTablePageRows,
	collectionTablePageWindow
} from '../src/collection-table/collection-table-pagination.ts';

test('asks for a growing live window and slices the requested page', () => {
	const rows = Array.from({ length: 34 }, (_, index) => index + 1);
	const first = collectionTablePageWindow(0, 25);
	const second = collectionTablePageWindow(1, 25);

	assert.deepEqual(first, { limit: 25, start: 0, end: 25 });
	assert.deepEqual(second, { limit: 50, start: 25, end: 50 });
	assert.deepEqual(collectionTablePageRows(rows.slice(0, first.limit), first), rows.slice(0, 25));
	assert.deepEqual(collectionTablePageRows(rows.slice(0, second.limit), second), rows.slice(25));
});

test('normalizes invalid page inputs at the boundary', () => {
	assert.deepEqual(collectionTablePageWindow(-4, 0), { limit: 1, start: 0, end: 1 });
});
