import type {
	CollectionMutationPendingApproval,
	CollectionMutationSettlement,
	CollectionOperations,
	CollectionType
} from '@norbital-ai/std/collection';
import { getErrorMessage } from '@norbital-ai/std';
import { Cause, Effect } from 'effect';

type CollectionWrite =
	| CollectionOperations<CollectionType<object, object>>['mutate']
	| CollectionOperations<CollectionType<object, object>>['delete'];

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
): Effect.Effect<CollectionMutationSubmission, Cause.UnknownError> => {
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
		// `UnknownError` is `(cause, message?)`: the first argument lands in `Error.cause`, not in
		// `message`. Passing the authoritative reason alone left every refusal reading as a generic
		// error in the form while the sentence the server actually wrote — "Payroll period is closed"
		// — was reachable only by opening `.cause`. The settlement rides as the cause so a debugger
		// keeps the whole object, and the reason is the message, which is the part a person reads.
		case 'rejected':
			return Effect.fail(new Cause.UnknownError(settlement, settlement.message));
		case 'quarantined':
			return Effect.fail(
				new Cause.UnknownError(settlement.quarantine, settlement.quarantine.message)
			);
		default: {
			const _exhaustive: never = settlement;
			return _exhaustive;
		}
	}
};

/**
 * Wrap a rejected promise while keeping what it said.
 *
 * The failure channel is `Cause.UnknownError`, so an ordinary rejection cannot travel as itself and
 * has to be wrapped. Wrapped by default it also loses its sentence: `UnknownError`'s first argument
 * is the cause, and the message falls back to a generic one. So the original rides as the cause —
 * identity preserved for anything inspecting it — and its own text becomes the message, which is
 * the half a person reads in the form.
 */
const preserving = (cause: unknown): Cause.UnknownError =>
	new Cause.UnknownError(cause, getErrorMessage(cause));

/** Runs a collection mutation through its authoritative terminal settlement. */
export function submitCollectionMutation(
	mutation: () => ReturnType<CollectionWrite>
): Effect.Effect<CollectionMutationSubmission, Cause.UnknownError> {
	return Effect.tryPromise({ try: () => mutation(), catch: preserving }).pipe(
		Effect.flatMap((result) =>
			Effect.tryPromise({ try: () => result.settlement.settled, catch: preserving })
		),
		Effect.flatMap(submissionFromSettlement)
	);
}
