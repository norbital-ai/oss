import { Effect } from 'effect';

/**
 * One collection's reactive write state.
 *
 * The count, rather than a boolean, is the contract: two overlapping writes must leave the
 * collection pending until the second one settles. Keeping the cell beside the stable collection
 * proxy also means every component reading `client.db.<collection>.pending` observes the same
 * state, instead of whichever short-lived object a Proxy happened to return for that property read.
 */
export class CollectionMutationState {
	pending = $state(0);

	/** Runs one command and settles this collection's in-flight count on every exit. */
	run = <Value>(effect: Effect.Effect<Value, unknown>) => {
		this.pending += 1;
		return Effect.runPromise(
			effect.pipe(
				Effect.ensuring(
					Effect.sync(() => {
						this.pending -= 1;
					})
				)
			)
		);
	};
}
