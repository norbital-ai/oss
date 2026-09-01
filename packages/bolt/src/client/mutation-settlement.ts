import type { SyncOutcome } from '@norbital-ai/bolt-protocol';
import type { MutationSettlement } from './contracts.js';

export const mutationSettlementOf = (outcome: SyncOutcome, at: number): MutationSettlement => {
	const status = outcome.status;
	switch (status.resolution) {
		case 'accepted':
			return {
				kind: 'accepted',
				idempotencyKey: outcome.id,
				settledAtEpochMs: at,
				...(status.pendingApproval === undefined ? {} : { pendingApproval: status.pendingApproval })
			};
		case 'rebased':
			return {
				kind: 'rebased',
				idempotencyKey: outcome.id,
				fromSchemaFingerprint: status.fromSchemaFingerprint,
				toSchemaFingerprint: status.toSchemaFingerprint,
				settledAtEpochMs: at
			};
		case 'rejected':
			return {
				kind: 'rejected',
				idempotencyKey: outcome.id,
				code: status.code,
				message: status.message,
				settledAtEpochMs: at
			};
		case 'quarantined':
			return {
				kind: 'quarantined',
				idempotencyKey: outcome.id,
				quarantine: { code: 'quarantined', message: status.reason, atEpochMs: at },
				settledAtEpochMs: at
			};
	}
};
