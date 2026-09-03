import { CollectionMutationIdempotencyKey } from '@norbital-ai/bolt-protocol';
import { describe, expect, it } from 'vitest';
import {
	mutationSettlementOf,
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
});
