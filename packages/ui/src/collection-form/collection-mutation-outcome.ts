import type { CollectionOperations, CollectionType } from '@norbital-ai/std/collection';
import { Effect, Schema } from 'effect';

const PendingApprovalSignalSchema = Schema.Struct({
	pending: Schema.Literal(true),
	requestId: Schema.String,
	collection: Schema.String,
	id: Schema.String,
	action: Schema.Literals(['create', 'update', 'delete'])
});

type CollectionMutation = CollectionOperations<CollectionType<object, object, object>>['mutate'];

/**
 * Recognizes Bolt's approval acquisition outcome without coupling the UI package to Bolt's client
 * runtime. Collection clients expose Promise<void>, so this accepted command is delivered through
 * their rejection channel as a structured signal rather than a conventional mutation failure.
 */
export const isPendingApprovalSignal = Schema.is(PendingApprovalSignalSchema);

/** Runs a collection mutation while treating an acquired approval as a successful submission. */
export function submitCollectionMutation(
	mutation: () => ReturnType<CollectionMutation>
): Effect.Effect<void, unknown> {
	return Effect.tryPromise({ try: mutation, catch: (cause) => cause }).pipe(
		Effect.catch((cause) => (isPendingApprovalSignal(cause) ? Effect.void : Effect.fail(cause)))
	);
}
