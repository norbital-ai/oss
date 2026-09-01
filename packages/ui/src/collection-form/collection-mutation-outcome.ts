import type {
	CollectionMutationPendingApproval,
	CollectionMutationSettlement,
	CollectionOperations,
	CollectionType
} from '@norbital-ai/std/collection';
import { Effect } from 'effect';

type CollectionMutation = CollectionOperations<CollectionType<object, object>>['mutate'];

export type CollectionMutationSubmission = Readonly<
	| {
			readonly kind: 'committed';
			readonly resolution: 'accepted' | 'rebased';
			readonly idempotencyKey: string;
	  }
	| ({
			readonly kind: 'pendingApproval';
			readonly idempotencyKey?: string;
	  } & CollectionMutationPendingApproval)
>;

const pendingApprovalSubmission = (
	approval: CollectionMutationPendingApproval,
	idempotencyKey?: string
): CollectionMutationSubmission => {
	const submission = {
		kind: 'pendingApproval' as const,
		requestId: approval.requestId,
		collection: approval.collection,
		id: approval.id,
		action: approval.action
	};
	return idempotencyKey === undefined ? submission : { ...submission, idempotencyKey };
};

const submissionFromSettlement = (
	settlement: CollectionMutationSettlement
): Effect.Effect<CollectionMutationSubmission, Error> => {
	switch (settlement.kind) {
		case 'accepted':
			return Effect.succeed(
				settlement.pendingApproval === undefined
					? {
							kind: 'committed',
							resolution: 'accepted',
							idempotencyKey: settlement.idempotencyKey
						}
					: pendingApprovalSubmission(settlement.pendingApproval, settlement.idempotencyKey)
			);
		case 'rebased':
			return Effect.succeed({
				kind: 'committed',
				resolution: 'rebased',
				idempotencyKey: settlement.idempotencyKey
			});
		case 'rejected':
			return Effect.fail(new Error(settlement.message));
		case 'quarantined':
			return Effect.fail(new Error(settlement.quarantine.message));
	}
};

/** Runs a collection mutation through its authoritative terminal settlement. */
export function submitCollectionMutation(
	mutation: () => ReturnType<CollectionMutation>
): Effect.Effect<CollectionMutationSubmission, unknown> {
	return Effect.tryPromise({ try: mutation, catch: (cause) => cause }).pipe(
		Effect.flatMap((result) =>
			Effect.tryPromise({ try: () => result.settlement.settled, catch: (cause) => cause })
		),
		Effect.flatMap(submissionFromSettlement)
	);
}
