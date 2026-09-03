import assert from 'node:assert/strict';
import test from 'node:test';
import { asRecord, mutationResolution, pageOf, requireAccepted, rowsOf } from '../src/guest-http.ts';

test('asRecord refuses arrays and null', () => {
	assert.deepEqual(asRecord({ id: '1' }, 'row'), { id: '1' });
	assert.throws(() => asRecord(null, 'row'), /was not an object/);
	assert.throws(() => asRecord([], 'row'), /was not an object/);
});

test('rowsOf and pageOf read either a bare array or a page envelope', () => {
	assert.deepEqual(rowsOf([{ id: 'a' }], 'page'), [{ id: 'a' }]);
	assert.deepEqual(rowsOf({ rows: [{ id: 'b' }] }, 'page'), [{ id: 'b' }]);
	assert.deepEqual(pageOf({ rows: [{ id: 'c' }], nextCursor: 'n' }, 'page'), {
		rows: [{ id: 'c' }],
		nextCursor: 'n'
	});
});

test('mutationResolution is exhaustive and requireAccepted only admits accepted', () => {
	assert.equal(mutationResolution({ resolution: 'accepted' }), 'accepted');
	assert.throws(() => mutationResolution({ resolution: 'unknown' }), /unhandled resolution/);
	requireAccepted({ resolution: 'accepted' }, 'create');
	assert.throws(() => requireAccepted({ resolution: 'quarantined' }, 'create'), /quarantined/);
});
