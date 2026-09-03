// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import { collectionFormSubmissionPending } from '../src/collection-form/collection-form-pending.ts';

test('create submit stays pending after enqueueMutation returns while FormState is still submitting', () => {
	assert.equal(
		collectionFormSubmissionPending({ isSubmitting: true, operationsPending: 0 }),
		true
	);
});

test('operations.pending also marks the form pending', () => {
	assert.equal(
		collectionFormSubmissionPending({ isSubmitting: false, operationsPending: 1 }),
		true
	);
});

test('idle form is not pending', () => {
	assert.equal(
		collectionFormSubmissionPending({ isSubmitting: false, operationsPending: 0 }),
		false
	);
});
