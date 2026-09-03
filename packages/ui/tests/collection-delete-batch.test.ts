// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import { collectionDeleteBatch } from '../src/collection-toolbar/collection-delete-batch.ts';

test('collectionDeleteBatch submits one delete(ids) write', async () => {
	/** @type {readonly string[][]} */
	const calls = [];
	await Effect.runPromise(
		collectionDeleteBatch(
			{
				delete: async (ids) => {
					calls.push([...ids]);
					return {
						settlement: {
							wait: async () => ({ kind: 'accepted' })
						}
					};
				}
			},
			['a', 'b']
		)
	);
	assert.deepEqual(calls, [['a', 'b']]);
});

test('collectionDeleteBatch refuses an empty selection instead of submitting', async () => {
	let called = false;
	await assert.rejects(
		() =>
			Effect.runPromise(
				collectionDeleteBatch(
					{
						delete: async () => {
							called = true;
							return {
								settlement: {
									wait: async () => ({ kind: 'accepted' })
								}
							};
						}
					},
					[]
				)
			),
		/at least one row/
	);
	assert.equal(called, false);
});
