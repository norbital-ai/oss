import { getErrorMessage } from '@norbital-ai/std';
import { Option, Schema } from 'effect';
import type { CollectionMutationIdempotencyKey, SyncOutcome } from '@norbital-ai/bolt-protocol';
import type { MutationSettlement } from './contracts.js';
import { isNonEmptyString, isRecord, isString } from '../schema-decode.js';

/**
 * The pending-approval shape the accepted outcome carries; mirrors
 * `SyncWriteStatus`'s nested approval struct, which the protocol does not export on its own.
 */
const PendingApproval = Schema.Struct({
	requestId: Schema.NonEmptyString,
	collection: Schema.NonEmptyString,
	id: Schema.NonEmptyString,
	action: Schema.Literals(['create', 'update', 'delete'])
});

const pendingApprovalOf = (
	value: unknown
): Extract<SyncOutcome['status'], { resolution: 'accepted' }>['pendingApproval'] => {
	const decoded = Schema.decodeUnknownOption(PendingApproval)(value);
	return Option.isSome(decoded) ? decoded.value : undefined;
};

const fingerprintOf = (value: Record<string, unknown>, fallback: string): string => {
	const fingerprint = value.schemaFingerprint;
	return isNonEmptyString(fingerprint) ? fingerprint : fallback;
};

/** Projects the `collections.write` command body onto the stream outcome the Machine already speaks. */
export const syncOutcomeFromWriteCommand = (
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
			if (!isString(fromSchemaFingerprint) || !isString(toSchemaFingerprint)) {
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
				!isNonEmptyString(message)
			) {
				return null;
			}
			return { id, status: { resolution: 'rejected', code, message, schemaFingerprint } };
		}
		case 'quarantined': {
			const reason = value.reason;
			if (!isNonEmptyString(reason)) return null;
			return { id, status: { resolution: 'quarantined', schemaFingerprint, reason } };
		}
		default: {
			const exhausted: never = resolution as never;
			void exhausted;
			return null;
		}
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

/** Statuses that are no verdict on the write: the server is busy, throttling, or still running it. */
const NON_VERDICT_STATUSES = new Set([408, 425, 429]);

/**
 * What a failed push says about the write — or nothing.
 *
 * Only a 4xx the server meant as a verdict rejects the write. A dropped socket, a proxy timeout, a
 * 5xx or a `425 mutation_in_progress` say the request failed, not the mutation: the server may be
 * building it still, or have committed it while the answer was lost. Reporting those as refusals
 * was a payroll run that succeeded on the server and failed on the screen. The write stays
 * pending; a later probe answers the persisted outcome, or `mutation_retry_expired` once the
 * server's retry horizon has passed — which is the bound.
 */
export const pushFailureOutcome = (
	id: CollectionMutationIdempotencyKey,
	cause: unknown,
	schemaFingerprint: string
): SyncOutcome | null => {
	const status =
		typeof cause === 'object' && cause !== null && typeof Reflect.get(cause, 'status') === 'number'
			? (Reflect.get(cause, 'status') as number)
			: undefined;
	if (status === undefined || status < 400 || status >= 500 || NON_VERDICT_STATUSES.has(status))
		return null;
	return rejectedSyncOutcome(id, getErrorMessage(cause), schemaFingerprint);
};

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
