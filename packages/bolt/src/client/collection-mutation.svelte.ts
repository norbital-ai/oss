import { Effect } from 'effect';

export class CollectionMutationState {
	pending = $state(0);

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
