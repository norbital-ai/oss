import type { CollectionMutationIdempotencyKey, SyncOutcome } from '@norbital-ai/bolt-protocol';
import type { MutationSettlement } from './contracts.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

const pendingApprovalOf = (
	value: unknown
): Extract<SyncOutcome['status'], { resolution: 'accepted' }>['pendingApproval'] => {
	if (!isRecord(value)) return undefined;
	const requestId = value.requestId;
	const collection = value.collection;
	const id = value.id;
	const action = value.action;
	if (
		typeof requestId !== 'string' ||
		requestId.length === 0 ||
		typeof collection !== 'string' ||
		collection.length === 0 ||
		typeof id !== 'string' ||
		id.length === 0 ||
		(action !== 'create' && action !== 'update' && action !== 'delete')
	) {
		return undefined;
	}
	return { requestId, collection, id, action };
};

const fingerprintOf = (value: Record<string, unknown>, fallback: string): string => {
	const fingerprint = value.schemaFingerprint;
	return typeof fingerprint === 'string' && fingerprint.length > 0 ? fingerprint : fallback;
};

/** Projects the `collections.mutate` command body onto the stream outcome the Machine already speaks. */
export const syncOutcomeFromMutateCommand = (
	id: CollectionMutationIdempotencyKey,
	value: unknown,
	fallbackFingerprint: string
): SyncOutcome | null => {
	if (!isRecord(value)) return null;
	const resolution = value.resolution;
	const schemaFingerprint = fingerprintOf(value, fallbackFingerprint);
	switch (resolution) {
		case 'accepted': {
			const pendingApproval = pendingApprovalOf(value.pendingApproval);
			return {
				id,
				status: {
					resolution: 'accepted',
					schemaFingerprint,
					...(pendingApproval === undefined ? {} : { pendingApproval })
				}
			};
		}
		case 'rebased': {
			const fromSchemaFingerprint = value.fromSchemaFingerprint;
			const toSchemaFingerprint = value.toSchemaFingerprint;
			if (typeof fromSchemaFingerprint !== 'string' || typeof toSchemaFingerprint !== 'string') {
				return null;
			}
			return {
				id,
				status: { resolution: 'rebased', fromSchemaFingerprint, toSchemaFingerprint }
			};
		}
		case 'rejected': {
			const code = value.code;
			const message = value.message;
			if (
				(code !== 'refused' && code !== 'forbidden' && code !== 'conflict') ||
				typeof message !== 'string' ||
				message.length === 0
			) {
				return null;
			}
			return { id, status: { resolution: 'rejected', code, message, schemaFingerprint } };
		}
		case 'quarantined': {
			const reason = value.reason;
			if (typeof reason !== 'string' || reason.length === 0) return null;
			return { id, status: { resolution: 'quarantined', schemaFingerprint, reason } };
		}
		default:
			return null;
	}
};

export const rejectedSyncOutcome = (
	id: CollectionMutationIdempotencyKey,
	message: string,
	schemaFingerprint: string
): SyncOutcome => ({
	id,
	status: {
		resolution: 'rejected',
		code: 'refused',
		message: message.length > 0 ? message : 'The mutation was refused.',
		schemaFingerprint
	}
});

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
