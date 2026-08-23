// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalRequestIdForRecord } from '../src/collection-table/approval-anchor.ts';

test('keeps held domain records anchored by approval_id', () => {
	assert.equal(
		approvalRequestIdForRecord('cost_estimates', {
			id: 'record-1',
			approval_id: 'request-1'
		}),
		'request-1'
	);
});

test('anchors a no-provisional-row approval create by its inbox request id', () => {
	assert.equal(
		approvalRequestIdForRecord('approval_request', {
			id: 'request-2',
			status: 'ONGOING'
		}),
		'request-2'
	);
});
