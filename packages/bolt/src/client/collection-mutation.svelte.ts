import { Effect } from 'effect';

export class CollectionMutationState {
	pending = $state(0);

	run = <Value, E = never>(effect: Effect.Effect<Value, E>) => {
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
