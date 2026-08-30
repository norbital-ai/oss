import { Effect } from 'effect';
import {
	EffectId,
	MAX_SYNC_HELD_IDS,
	type SyncAdvanceSubscription,
	type SyncAdvanceUpdate,
	type SyncPatch
} from '@norbital-ai/bolt-protocol';
import type { Subject } from '#lib/runtime/identity/identity.js';
import { contentDigest, heldIdsOf } from './digest.js';
import { describeSyncQuery, resolveSyncQuery } from './resolver.js';

type ResolvedSubscription = Readonly<{
	readonly state: SyncAdvanceSubscription;
	readonly subject: Subject;
}>;

/**
 * Re-resolves one affected subscription through the authoritative read path.
 *
 * The changelog changes only select which subscriptions reach this function; they never become a
 * second query evaluator. A changed digest ships the complete answer (or scalar count), while an
 * unchanged digest can still carry policy and dependency metadata when the policy hash moved.
 */
export const advanceSubscription = Effect.fn('Sync.advanceSubscription')(function* (
	effectId: EffectId,
	entry: ResolvedSubscription
) {
	const described = yield* describeSyncQuery(entry.subject, entry.state.input);
	const answer = yield* resolveSyncQuery(
		EffectId.make(`${effectId}:resolve:${entry.state.subId}`),
		entry.subject,
		entry.state.input
	);
	const resolvedIds = heldIdsOf(answer);
	const digestOnly = resolvedIds.length > MAX_SYNC_HELD_IDS;
	const heldIds = digestOnly ? [] : resolvedIds;
	const digest = yield* Effect.promise(() => contentDigest(answer));
	if (digest === entry.state.digest && described.policyHash === entry.state.policyHash) {
		return undefined;
	}
	const patch: SyncPatch =
		entry.state.input.kind === 'count'
			? { op: 'scalar', value: typeof answer === 'number' ? answer : 0 }
			: { op: 'answer', answer };
	return {
		subId: entry.state.subId,
		from: entry.state.digest,
		to: digest,
		patch,
		heldIds,
		digestOnly,
		policyHash: described.policyHash,
		dependencies: described.dependencies,
		policyDependencies: described.policyDependencies
	} satisfies SyncAdvanceUpdate;
});
