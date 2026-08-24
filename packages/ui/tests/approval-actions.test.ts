// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalActionsFor } from '../src/collection-table/approval-actions.ts';

test('offers only the server-derived actions for an ongoing approval', () => {
	assert.deepEqual(
		approvalActionsFor({ id: 'request-1', status: 'ONGOING', canDecide: true, canWithdraw: false }),
		{ decide: true, supersede: false, withdraw: false }
	);
	assert.deepEqual(
		approvalActionsFor({
			id: 'request-1',
			status: 'ONGOING',
			canDecide: false,
			canSupersede: true,
			canWithdraw: true
		}),
		{ decide: false, supersede: true, withdraw: true }
	);
});

test('offers no actions after the approval closes', () => {
	assert.deepEqual(
		approvalActionsFor({ id: 'request-1', status: 'APPROVED', canDecide: true, canWithdraw: true }),
		{ decide: false, supersede: false, withdraw: false }
	);
});
