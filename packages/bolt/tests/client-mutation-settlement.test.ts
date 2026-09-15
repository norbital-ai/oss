import { CollectionMutationIdempotencyKey } from '@norbital-ai/bolt-protocol';
import { describe, expect, it } from 'vitest';
import {
	mutationSettlementOf,
	pushFailureOutcome,
	rejectedSyncOutcome,
	syncOutcomeFromMutateCommand
} from '../src/client/mutation-settlement.js';

describe('browser mutation settlement projection', () => {
	it('preserves pending approval metadata on an accepted outcome', () => {
		expect(
			mutationSettlementOf(
				{
					id: CollectionMutationIdempotencyKey.make('mutation-1'),
					status: {
						resolution: 'accepted',
						schemaFingerprint: 'sha256:workspace',
						pendingApproval: {
							requestId: 'request-1',
							collection: 'payroll_runs',
							id: 'payroll-run-1',
							action: 'create'
						}
					}
				},
				123
			)
		).toEqual({
			kind: 'accepted',
			idempotencyKey: 'mutation-1',
			settledAtEpochMs: 123,
			pendingApproval: {
				requestId: 'request-1',
				collection: 'payroll_runs',
				id: 'payroll-run-1',
				action: 'create'
			}
		});
	});

	it('projects a mutate command pending-approval body onto a stream outcome', () => {
		expect(
			syncOutcomeFromMutateCommand(
				CollectionMutationIdempotencyKey.make('mutation-2'),
				{
					resolution: 'accepted',
					schemaFingerprint: 'sha256:workspace',
					pendingApproval: {
						requestId: 'request-2',
						collection: 'leave_requests',
						id: 'leave-1',
						action: 'create'
					}
				},
				'sha256:fallback'
			)
		).toEqual({
			id: 'mutation-2',
			status: {
				resolution: 'accepted',
				schemaFingerprint: 'sha256:workspace',
				pendingApproval: {
					requestId: 'request-2',
					collection: 'leave_requests',
					id: 'leave-1',
					action: 'create'
				}
			}
		});
	});

	it('turns a thrown mutate into a refused outcome', () => {
		expect(
			rejectedSyncOutcome(
				CollectionMutationIdempotencyKey.make('mutation-3'),
				'no matching allow policy',
				'sha256:workspace'
			)
		).toEqual({
			id: 'mutation-3',
			status: {
				resolution: 'rejected',
				code: 'refused',
				message: 'no matching allow policy',
				schemaFingerprint: 'sha256:workspace'
			}
		});
	});

	/**
	 * A failed push is a verdict on the write only when the server meant one. A dropped socket, a
	 * 5xx, or "still running" say nothing about the mutation: it may be building, or committed with
	 * the answer lost. Those stay pending for the probe to settle; rejecting them was a run that
	 * succeeded on the server and failed on the screen.
	 */
	it('rejects the write only on a terminal 4xx', () => {
		const id = CollectionMutationIdempotencyKey.make('mutation-1');
		const status = (code: number) => Object.assign(new Error(`http ${code}`), { status: code });
		expect(pushFailureOutcome(id, status(409), 'sha256:0')?.status.resolution).toBe('rejected');
		expect(pushFailureOutcome(id, status(422), 'sha256:0')?.status.resolution).toBe('rejected');
		for (const cause of [
			status(425),
			status(429),
			status(408),
			status(502),
			status(0),
			new TypeError('Failed to fetch')
		])
			expect(pushFailureOutcome(id, cause, 'sha256:0')).toBeNull();
	});
});
