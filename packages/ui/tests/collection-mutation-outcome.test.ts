// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import {
	isPendingApprovalSignal,
	submitCollectionMutation
} from '../src/collection-form/collection-mutation-outcome.ts';

const pendingApproval = {
	pending: true,
	requestId: 'request-1',
	collection: 'payroll_runs',
	id: 'payroll-run-1',
	action: 'create'
} as const;

test('recognizes the complete collection approval signal', () => {
	assert.equal(isPendingApprovalSignal(pendingApproval), true);
	assert.equal(isPendingApprovalSignal({ pending: true, requestId: 'request-1' }), false);
	assert.equal(isPendingApprovalSignal({ ...pendingApproval, action: 'read' }), false);
});

test('settles an approval-gated collection mutation as a successful submission', async () => {
	await Effect.runPromise(submitCollectionMutation(() => Promise.reject(pendingApproval)));
});

test('preserves an ordinary collection mutation failure', async () => {
	const failure = new Error('Payroll period is closed');
	await assert.rejects(
		Effect.runPromise(submitCollectionMutation(() => Promise.reject(failure))),
		(error) => error === failure
	);
});
