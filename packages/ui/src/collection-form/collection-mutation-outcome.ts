import type { CollectionOperations, CollectionType } from '@norbital-ai/std/collection';
import { Effect, Schema } from 'effect';

const PendingApprovalSignalSchema = Schema.Struct({
	pending: Schema.Literal(true),
	requestId: Schema.String,
	collection: Schema.String,
	id: Schema.String,
	action: Schema.Literals(['create', 'update', 'delete'])
});

type CollectionMutation = CollectionOperations<CollectionType<object, object>>['mutate'];

/**
 * Recognizes Bolt's approval acquisition outcome without coupling the UI package to Bolt's client
 * runtime. This remains the compatibility path for a server-first client: local-first clients
 * resolve with their durable result and surface a later refusal through the platform sync issue.
 */
export const isPendingApprovalSignal = Schema.is(PendingApprovalSignalSchema);

/** Runs a collection mutation while treating an acquired approval as a successful submission. */
export function submitCollectionMutation(
	mutation: () => ReturnType<CollectionMutation>
): Effect.Effect<void, unknown> {
	return Effect.tryPromise({ try: mutation, catch: (cause) => cause }).pipe(
		Effect.asVoid,
		Effect.catch((cause) => (isPendingApprovalSignal(cause) ? Effect.void : Effect.fail(cause)))
	);
}
