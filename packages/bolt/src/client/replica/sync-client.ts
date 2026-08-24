import { Effect, Schema } from 'effect';
import { SyncChange, SyncCursor } from '#lib/runtime/sync/sync.js';

/**
 * The pull loop behind the browser replica.
 *
 * The server keeps an ordered outbox and answers `sync.diff` from a cursor; this walks that cursor
 * forward and hands each batch to a sink. It owns three things the callers kept re-deriving: where
 * the cursor is, what a `reset` means, and how to stop. Storage is the sink's problem — this never
 * touches SQL, which is what lets it be tested without a database.
 */

type SyncTransport = Readonly<{
	readonly head: () => Effect.Effect<SyncCursor, unknown>;
	readonly diff: (
		cursor: SyncCursor,
		limit: number
	) => Effect.Effect<ReadonlyArray<SyncChange>, unknown>;
}>;

type ReplicaSink = Readonly<{
	/** Applies one ordered batch. A `reset` change means the sink must drop everything it holds. */
	readonly apply: (changes: ReadonlyArray<SyncChange>) => Effect.Effect<void, unknown>;
	readonly reset: () => Effect.Effect<void, unknown>;
}>;

type SyncClientOptions = Readonly<{
	readonly transport: SyncTransport;
	readonly sink: ReplicaSink;
	/** Rows per round trip. The server clamps this; asking for more just wastes a request. */
	readonly batchSize?: number;
	/**
	 * Where to resume from, for a client that already holds state from a previous session.
	 *
	 * Without it every boot replays the outbox from the origin, which is the right behaviour only for
	 * a replica that keeps nothing across a reload. A client whose cache *is* persisted needs the
	 * opposite: the changes since it was written, and none of the ones already reflected in it.
	 */
	readonly initialCursor?: SyncCursor;
	/** Called after each batch so a UI can re-run its live queries. */
	readonly onAdvance?: (cursor: SyncCursor) => Effect.Effect<void, unknown>;
	readonly onError?: ((cause: unknown) => void) | undefined;
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
	/** Pulls until the server has nothing further. Returns how many changes were applied. */
	readonly drain: () => Effect.Effect<number, unknown>;
	/** Rewinds to the origin, for a caller that found its resume point no longer exists. */
	readonly reset: () => void;
	readonly stop: () => void;
}>;

export const createSyncClient = (options: SyncClientOptions): Effect.Effect<SyncClient, unknown> =>
	Effect.gen(function* () {
		const batchSize = Math.max(1, options.batchSize ?? 200);
		let cursor: SyncCursor = options.initialCursor ?? ORIGIN_CURSOR;
		let stopped = false;

		if (compareCursors(cursor, ORIGIN_CURSOR) > 0) {
			const head = yield* options.transport.head().pipe(
				Effect.match({
					onFailure: (cause) => {
						options.onError?.(cause);
						return cursor;
					},
					onSuccess: (current) => current
				})
			);
			if (compareCursors(cursor, head) > 0) {
				// A persisted cursor cannot be ahead of the database it mirrors. This happens when a
				// schema-compatible workspace is bootstrapped onto a replacement database: asking that
				// database for changes after the old cursor returns an empty batch forever, retaining rows
				// that exist only in the browser. Resetting here lets the replica sink resnapshot the
				// current rows before ordinary incremental draining resumes from a safe lower bound.
				yield* options.sink.reset();
				cursor = head;
				if (options.onAdvance !== undefined) yield* options.onAdvance(cursor);
			}
		}

		const pull = (): Effect.Effect<number> => {
			let applied = 0;
			let more = true;
			return Effect.gen(function* () {
				yield* Effect.whileLoop({
					while: () => !stopped && more,
					step: () => void 0,
					body: () =>
						Effect.gen(function* () {
							const changes = yield* options.transport.diff(cursor, batchSize);
							if (changes.length === 0) {
								more = false;
								return;
							}
							if (isResetBatch(changes)) {
								// The client is further behind than the server still remembers. Everything local is
								// unreconstructible from here, so the projection is dropped and rebuilt from the
								// reset point rather than silently diverging.
								yield* options.sink.reset();
								const reset = changes.find((change) => change.operation === 'reset');
								cursor = reset?.cursor ?? ORIGIN_CURSOR;
								if (options.onAdvance !== undefined) yield* options.onAdvance(cursor);
								return;
							}
							yield* options.sink.apply(changes);
							applied += changes.length;
							const last = changes[changes.length - 1];
							if (last !== undefined) cursor = last.cursor;
							if (options.onAdvance !== undefined) yield* options.onAdvance(cursor);
							if (changes.length < batchSize) more = false;
						}).pipe(
							Effect.catch((cause: unknown) => {
								more = false;
								options.onError?.(cause);
								return Effect.succeed(undefined);
							})
						)
				});
				return applied;
			});
		};
		const [drain, invalidateDrain] = yield* Effect.cachedInvalidateWithTTL(
			Effect.suspend(pull),
			'Infinity'
		);

		return {
			cursor: () => cursor,
			// Concurrent callers share one pass: two overlapping drains would read the same cursor and
			// apply the same batch twice.
			drain: () =>
				drain.pipe(
					// Keep the completed pass visible until every caller already scheduled in this burst has
					// observed it, then make the next notification pull from the advanced cursor.
					Effect.ensuring(Effect.yieldNow.pipe(Effect.andThen(invalidateDrain)))
				),
			reset: () => {
				cursor = ORIGIN_CURSOR;
			},
			stop: () => {
				stopped = true;
			}
		};
	});

/** Decodes a diff response from the wire into ordered changes. */
export const decodeChanges = (value: unknown): ReadonlyArray<SyncChange> =>
	Schema.decodeUnknownSync(Schema.Array(SyncChange))(value);

/** Decodes a head response from the wire. */
export const decodeCursor = (value: unknown): SyncCursor =>
	Schema.decodeUnknownSync(SyncCursor)(value);
