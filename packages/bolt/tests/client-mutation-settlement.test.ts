import { CollectionMutationIdempotencyKey } from '@norbital-ai/bolt-protocol';
import { describe, expect, it } from 'vitest';
import { mutationSettlementOf } from '../src/client/mutation-settlement.js';

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
});
