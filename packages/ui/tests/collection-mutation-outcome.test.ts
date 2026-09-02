// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import { submitCollectionMutation } from '../src/collection-form/collection-mutation-outcome.ts';

const mutation = (settlement) => () =>
	Promise.resolve({
		durability: 'memory',
		pending: true,
		row: null,
		idempotencyKey: settlement.idempotencyKey,
		settlement: {
			idempotencyKey: settlement.idempotencyKey,
			settled: Promise.resolve(settlement),
			status: async () => settlement.kind,
			wait: async () => {
				throw new Error(
					'submitCollectionMutation must use the eagerly registered settlement promise'
				);
			}
		}
	});

const pendingApprovalDetails = {
	requestId: 'request-1',
	collection: 'payroll_runs',
	id: 'payroll-run-1',
	action: 'create'
} as const;

test('preserves an ordinary collection mutation failure', async () => {
	const failure = new Error('Payroll period is closed');
	// The failure channel is `Cause.UnknownError`, so the rejection cannot arrive as itself. What
	// must survive is both halves of it: the original object, reachable as the cause, and the
	// sentence it carried, which is what the form shows. This asserted `error === failure` and so
	// asserted something the declared type cannot deliver.
	await assert.rejects(
		Effect.runPromise(submitCollectionMutation(() => Promise.reject(failure))),
		(error) => error.cause === failure && error.message === 'Payroll period is closed'
	);
});

test('waits for an accepted authoritative settlement', async () => {
	assert.deepEqual(
		await Effect.runPromise(
			submitCollectionMutation(
				mutation({
					kind: 'accepted',
					idempotencyKey: 'mutation-1',
					settledAtEpochMs: 10
				})
			)
		),
		{ kind: 'committed', resolution: 'accepted', idempotencyKey: 'mutation-1' }
	);
});

test('A1: a write is not painted committed until settlement, then matches that settlement', async () => {
	let resolveSettlement;
	const settled = new Promise((resolve) => {
		resolveSettlement = resolve;
	});
	let painted;
	const run = Effect.runPromise(
		submitCollectionMutation(() =>
			Promise.resolve({
				durability: 'memory',
				pending: true,
				row: { id: 'optimistic-1', name: 'Optimistic' },
				idempotencyKey: 'mutation-a1',
				settlement: {
					idempotencyKey: 'mutation-a1',
					settled,
					status: async () => 'queued',
					wait: async () => {
						throw new Error('submitCollectionMutation must use the eagerly registered settlement');
					}
				}
			})
		)
	).then((submission) => {
		painted = submission;
		return submission;
	});

	await Promise.resolve();
	assert.equal(painted, undefined, 'optimistic memory row must not be treated as committed');

	resolveSettlement({
		kind: 'accepted',
		idempotencyKey: 'mutation-a1',
		settledAtEpochMs: 10
	});
	assert.deepEqual(await run, {
		kind: 'committed',
		resolution: 'accepted',
		idempotencyKey: 'mutation-a1'
	});
});

test('A3: pending approval is submitted-for-approval, not a live commit', async () => {
	assert.deepEqual(
		await Effect.runPromise(
			submitCollectionMutation(
				mutation({
					kind: 'accepted',
					idempotencyKey: 'mutation-a3',
					settledAtEpochMs: 11,
					pendingApproval: pendingApprovalDetails
				})
			)
		),
		{ kind: 'pendingApproval', idempotencyKey: 'mutation-a3', ...pendingApprovalDetails }
	);
});

test('preserves pending approval metadata from an accepted settlement', async () => {
	assert.deepEqual(
		await Effect.runPromise(
			submitCollectionMutation(
				mutation({
					kind: 'accepted',
					idempotencyKey: 'mutation-2',
					settledAtEpochMs: 20,
					pendingApproval: pendingApprovalDetails
				})
			)
		),
		{ kind: 'pendingApproval', idempotencyKey: 'mutation-2', ...pendingApprovalDetails }
	);
});

test('treats a rebased settlement as a successful commit', async () => {
	assert.deepEqual(
		await Effect.runPromise(
			submitCollectionMutation(
				mutation({
					kind: 'rebased',
					idempotencyKey: 'mutation-3',
					fromSchemaFingerprint: 'sha256:old',
					toSchemaFingerprint: 'sha256:new',
					settledAtEpochMs: 30
				})
			)
		),
		{ kind: 'committed', resolution: 'rebased', idempotencyKey: 'mutation-3' }
	);
});

test('surfaces the authoritative rejection message', async () => {
	await assert.rejects(
		Effect.runPromise(
			submitCollectionMutation(
				mutation({
					kind: 'rejected',
					idempotencyKey: 'mutation-4',
					code: 'refused',
					message: 'Payroll period is closed',
					settledAtEpochMs: 40
				})
			)
		),
		/Payroll period is closed/
	);
});

test('surfaces the authoritative quarantine reason', async () => {
	await assert.rejects(
		Effect.runPromise(
			submitCollectionMutation(
				mutation({
					kind: 'quarantined',
					idempotencyKey: 'mutation-5',
					quarantine: {
						code: 'quarantined',
						message: 'Mutation graph is incomplete',
						atEpochMs: 50
					},
					settledAtEpochMs: 50
				})
			)
		),
		/Mutation graph is incomplete/
	);
});
