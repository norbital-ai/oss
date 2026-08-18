import { Context, Effect, Layer } from 'effect';
import type { EffectId } from '@norbital-ai/bolt-protocol';
import { Transport } from '../facilities/services.js';

/**
 * Telling the replicas that something changed.
 *
 * The client used to find out by asking, on a timer. That is the wrong shape twice over: a workspace
 * is quiet for hours and the poll costs a request per tab regardless, and when something does happen
 * the tab learns about it a poll-interval late. Neither gets better by tuning the interval, because
 * the two failures pull in opposite directions.
 *
 * So the write path announces instead. Bolt holds no connection and keeps none — an invocation exists
 * for one command and is disposed after it — so the announcement is addressed to a *topic* and the
 * host, which does hold the connections, fans it out to the tenant's open ones.
 *
 * ## What travels, and what does not
 *
 * Only the names of the collections that changed. Not the rows, not the cursor, not the operation.
 * A replica that receives this asks for the changes through `sync.diff` exactly as it would have on
 * a poll, so the log stays the single ordered source of what happened. Putting the rows in the frame
 * would make this a second delivery path with weaker guarantees than the one beside it — no cursor,
 * no ordering, no replay — and every divergence between them would be invisible.
 *
 * ## Why it cannot fail a write
 *
 * The announcement happens after the write has committed. There is nothing left to roll back, and a
 * host whose transport is unavailable is not a reason to tell the user their save failed. A dropped
 * announcement costs latency and nothing else: the replica still converges the next time it drains,
 * which is what makes the frame a hint rather than a delivery.
 */

/** The topic every workspace replica listens on. */
export const SYNC_TOPIC = 'bolt.sync';

export type WakeFrame = Readonly<{ readonly collections: ReadonlyArray<string> }>;

export type Interface = Readonly<{
	/** Announces that these collections changed. Never fails, and never blocks the caller's result. */
	readonly announce: (
		effectId: EffectId,
		collections: ReadonlyArray<string>
	) => Effect.Effect<void>;
}>;

export const Service = Context.Service<Interface>('@norbital-ai/bolt/SyncWake');

export const encodeWake = (frame: WakeFrame): Uint8Array =>
	new TextEncoder().encode(JSON.stringify(frame));

export const decodeWake = (bytes: Uint8Array): WakeFrame => {
	const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
	const collections =
		parsed !== null &&
		typeof parsed === 'object' &&
		Array.isArray(Reflect.get(parsed, 'collections'))
			? (Reflect.get(parsed, 'collections') as ReadonlyArray<unknown>).filter(
					(entry): entry is string => typeof entry === 'string'
				)
			: [];
	return { collections };
};

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const transport = yield* Transport.Service;
		return Service.of({
			announce: Effect.fn('SyncWake.announce')(function* (effectId, collections) {
				const named = [...new Set(collections)].filter((name) => name.length > 0);
				if (named.length === 0) return;
				yield* transport
					.execute(effectId, {
						_tag: 'Publish',
						topic: SYNC_TOPIC,
						kind: 'text',
						bytes: encodeWake({ collections: named })
					})
					// Swallowed deliberately, and this is the only place in the write path where that is
					// the right call: the row is already committed, so there is no outcome left to report
					// and nothing a caller could do differently. A host with no transport bound at all
					// lands here too, which is what lets the engine run in environments that have none.
					.pipe(Effect.ignore);
			})
		});
	})
);

export * as SyncWake from './wake.js';
