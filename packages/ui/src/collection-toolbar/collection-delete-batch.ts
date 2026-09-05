import { Effect } from 'effect';
import { toError } from '@norbital-ai/std';

type CollectionDeleteBatchSettlement = Readonly<
	| { readonly kind: 'accepted' }
	| { readonly kind: 'rebased' }
	| { readonly kind: 'rejected'; readonly message: string }
	| { readonly kind: 'quarantined'; readonly quarantine: { readonly message: string } }
>;

type CollectionDeleteBatchClient = {
	readonly delete: (ids: readonly string[]) => Promise<{
		readonly settlement: {
			readonly wait: () => Promise<CollectionDeleteBatchSettlement>;
		};
	}>;
};

/** One `delete` write for the selected ids — the same batch path mutate uses. */
export const collectionDeleteBatch = (
	operations: CollectionDeleteBatchClient,
	ids: readonly string[]
) =>
	Effect.gen(function* () {
		if (ids.length === 0)
			return yield* Effect.fail(new Error('A delete batch must name at least one row.'));
		const local = yield* Effect.tryPromise({
			try: () => operations.delete(ids),
			catch: toError
		});
		const settlement = yield* Effect.tryPromise({
			try: () => local.settlement.wait(),
			catch: toError
		});
		switch (settlement.kind) {
			case 'accepted':
			case 'rebased':
				return;
			case 'rejected':
				return yield* Effect.fail(new Error(settlement.message));
			case 'quarantined':
				return yield* Effect.fail(new Error(settlement.quarantine.message));
			default: {
				const _exhaustive: never = settlement;
				return yield* Effect.fail(
					new Error(`unhandled delete settlement: ${JSON.stringify(_exhaustive)}`)
				);
			}
		}
	});
