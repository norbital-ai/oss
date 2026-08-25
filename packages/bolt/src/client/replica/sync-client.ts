import { Effect, Schema, Semaphore } from 'effect';
import { SyncChange, SyncCursor } from '#lib/runtime/sync/sync.js';

/**
 * The ordered apply loop behind the browser replica.
 *
 * The workspace's one SSE connection carries the permission-filtered outbox deltas themselves.
 * This client therefore has no transport and cannot poll or issue `sync.diff`: it serializes batches
 * arriving from that stream, advances the persisted cursor only after their rows land, and ignores
 * replayed changes after a reconnect. Storage is the sink's problem — this never touches SQL, which
 * is what lets it be tested without a database.
 */

type ReplicaSink = Readonly<{
	/** Applies one ordered batch. A `reset` change means the sink must drop everything it holds. */
	readonly apply: (changes: ReadonlyArray<SyncChange>) => Effect.Effect<void, unknown>;
	readonly reset: () => Effect.Effect<void, unknown>;
}>;

type SyncClientOptions = Readonly<{
	readonly sink: ReplicaSink;
	/** The cursor stored beside the replica rows at the end of the previous session. */
	readonly initialCursor?: SyncCursor;
	/** Called only after a batch is durably reflected by the sink. */
	readonly onAdvance?: (cursor: SyncCursor) => Effect.Effect<void, unknown>;
}>;

export const ORIGIN_CURSOR: SyncCursor = { xid: 0, sequence: 0 };

/** True when a batch tells the client its cursor fell off the retained history. */
const isResetBatch = (changes: ReadonlyArray<SyncChange>): boolean =>
	changes.some((change) => change.operation === 'reset');

/** Orders two cursors the way the server orders its outbox. */
export const compareCursors = (left: SyncCursor, right: SyncCursor): number =>
	left.xid === right.xid ? left.sequence - right.sequence : left.xid - right.xid;

type SyncClient = Readonly<{
	readonly cursor: () => SyncCursor;
	/** Applies one ordered SSE batch. Returns how many changes advanced the replica. */
	readonly apply: (changes: ReadonlyArray<SyncChange>) => Effect.Effect<number, unknown>;
	readonly stop: () => void;
}>;

export const createSyncClient = (options: SyncClientOptions): Effect.Effect<SyncClient> =>
	Effect.gen(function* () {
		let cursor: SyncCursor = options.initialCursor ?? ORIGIN_CURSOR;
		let stopped = false;
		const permit = yield* Semaphore.make(1);
		const apply = Effect.fn('ReplicaSyncClient.apply')(function* (
			changes: ReadonlyArray<SyncChange>
		) {
			if (stopped) return 0;
			if (isResetBatch(changes)) {
				if (changes.length !== 1 || changes[0]?.operation !== 'reset') {
					return yield* Effect.fail(new Error('A sync reset must be the only change in its batch'));
				}
				const reset = changes[0];
				// Compaction moves the cursor forward. Replacing an environment's database can move its
				// outbox head backwards. In both cases the host deliberately sends a reset, so honor it even
				// when its cursor is lower than the persisted cursor. An equal cursor is only an EventSource
				// replay of a reset already applied before the connection dropped.
				if (compareCursors(reset.cursor, cursor) === 0) return 0;
				yield* options.sink.reset();
				cursor = reset.cursor;
				if (options.onAdvance !== undefined) yield* options.onAdvance(cursor);
				return 1;
			}
			// EventSource reconnects at least once. A batch whose cursor was already recorded is a replay,
			// not a reason to rewrite the same PGlite rows or invalidate their queries again.
			const fresh = changes.filter((change) => compareCursors(change.cursor, cursor) > 0);
			if (fresh.length === 0) return 0;
			for (let index = 1; index < fresh.length; index += 1) {
				const previous = fresh[index - 1];
				const current = fresh[index];
				if (
					previous !== undefined &&
					current !== undefined &&
					compareCursors(previous.cursor, current.cursor) >= 0
				) {
					return yield* Effect.fail(new Error('Sync changes arrived out of cursor order'));
				}
			}
			yield* options.sink.apply(fresh);
			cursor = fresh[fresh.length - 1]?.cursor ?? cursor;
			if (options.onAdvance !== undefined) yield* options.onAdvance(cursor);
			return fresh.length;
		});

		return {
			cursor: () => cursor,
			// SSE delivery is sequential, but applying a batch yields to PGlite. The permit keeps a later
			// DOM event behind it so two cursor generations never write the shared replica at once.
			apply: (changes) => permit.withPermit(apply(changes)),
			stop: () => {
				stopped = true;
			}
		};
	});

/** Decodes one SSE data frame into its ordered, permission-filtered changes. */
export const decodeChanges = (value: unknown): ReadonlyArray<SyncChange> =>
	Schema.decodeUnknownSync(Schema.Array(SyncChange))(value);

