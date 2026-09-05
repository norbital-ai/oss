import { Effect, Schema } from 'effect';

const Pending = Schema.Struct({
	_tag: Schema.Literal('Bolt.Collections.PendingApproval'),
	requestId: Schema.NonEmptyString,
	collection: Schema.NonEmptyString,
	id: Schema.NonEmptyString,
	action: Schema.Literals(['create', 'update', 'delete'])
});
const PhaseFailure = Schema.Struct({
	_tag: Schema.Literal('Bolt.Collections.MutationPhaseFailure'),
	cause: Schema.Unknown
});

/**
 * Submit a write and distinguish applied data from a durable request awaiting review.
 * Automations can finish their research receipt while HR reviews the proposed graph.
 * Use around a top-level write, not a write staged inside a before hook. Other failures propagate.
 */
export const captureApproval = <A, E, R>(write: Effect.Effect<A, E, R>) =>
	write.pipe(
		Effect.map((value) => ({ status: 'applied' as const, value })),
		Effect.catch((error) => {
			let current: unknown = error;
			const seen = new Set<unknown>();
			while (Schema.is(PhaseFailure)(current) && !seen.has(current)) {
				seen.add(current);
				current = current.cause;
			}
			return Schema.is(Pending)(current)
				? Effect.succeed({
						status: 'pending' as const,
						requestId: current.requestId,
						collection: current.collection,
						id: current.id,
						action: current.action
					})
				: Effect.fail(error);
		})
	);
