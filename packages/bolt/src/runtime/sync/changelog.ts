import { Effect, Schema } from 'effect';
import { EffectId, type EffectId as EffectIdType, type SyncCursor } from '@norbital-ai/bolt-protocol';
import * as Database from '#lib/runtime/facilities/database.js';

const Integer = Schema.Union([Schema.Number, Schema.NumberFromString]).check(Schema.isInt());
const BoundsRow = Schema.Struct({ first: Integer, head: Integer });
const CollectionRow = Schema.Struct({ collection: Schema.NonEmptyString });

const malformed = (operation: string) =>
	new Database.FacilityError({
		operation,
		code: 'malformed_response',
		message: `The sync changelog returned a malformed row for ${operation}.`,
		retryable: false,
		outcome: 'known'
	});

/**
 * How far below the head the changelog is kept, in sequences.
 *
 * Retention never has to be exact: `changelogSince` answers any cursor below the oldest surviving
 * row with `truncated`, and a truncated reconnect re-resolves every query. The bound only keeps the
 * table from growing forever.
 */
const CHANGELOG_HORIZON = 50_000;

/** Rows one bounded pass may retire; maintenance folded into a changelog read must stay bounded. */
const RETENTION_BATCH = 1_000;

/**
 * One bounded retention pass, run before every changelog read.
 *
 * Deletes the oldest slice of the expired window — sequences at or below `head − HORIZON` that are
 * already committed — and nothing else. The commit-horizon term keeps any transaction still in
 * flight (whose rows carry sequences at or above the head anyway) untouched.
 */
const retain = Effect.fn('Sync.changelogRetain')(function* (effectId: EffectIdType) {
	const database = yield* Database.Service;
	yield* database.execute(effectId, {
		_tag: 'Query',
		// repository-health:allow SQL1 -- fixed private changelog retention; the horizon is a constant.
		sql: `delete from bolt_sync_outbox where sequence > (select coalesce(max(sequence), 0) - $1 - $2 from bolt_sync_outbox) and sequence <= (select coalesce(max(sequence), 0) - $1 from bolt_sync_outbox) and xid < pg_snapshot_xmin(pg_current_snapshot())::text::bigint`,
		parameters: [CHANGELOG_HORIZON, RETENTION_BATCH]
	});
});

/**
 * Collection-granular reconnect hint and current committed head.
 *
 * Absence and truncation are correctness fallbacks, not errors: callers re-resolve every query.
 */
export const changelogSince = Effect.fn('Sync.changelogSince')(function* (
	effectId: EffectId,
	cursor: SyncCursor | undefined
) {
	yield* retain(EffectId.make(`${effectId}:retain`));
	const database = yield* Database.Service;
	const boundsResult = yield* database.execute(EffectId.make(`${effectId}:bounds`), {
		_tag: 'Query',
		// repository-health:allow SQL1 -- fixed private changelog and commit-horizon expression.
		sql: `select coalesce(min(sequence), 0) as first, coalesce(max(sequence), 0) as head from bolt_sync_outbox where xid < pg_snapshot_xmin(pg_current_snapshot())::text::bigint`,
		parameters: []
	});
	const bounds = yield* Schema.decodeUnknownEffect(BoundsRow)(
		boundsResult.rows[0] ?? { first: 0, head: 0 }
	).pipe(Effect.mapError(() => malformed('sync.changelogSince.bounds')));
	const head = { sequence: bounds.head } satisfies SyncCursor;
	if (cursor === undefined)
		return { collections: [], truncated: true, head };
	if (cursor.sequence > bounds.head || (bounds.first > 0 && cursor.sequence < bounds.first - 1))
		return { collections: [], truncated: true, head };
	if (cursor.sequence === bounds.head)
		return { collections: [], truncated: false, head };
	const changedResult = yield* database.execute(EffectId.make(`${effectId}:collections`), {
		_tag: 'Query',
		// repository-health:allow SQL1 -- fixed private changelog; cursor and horizon stay bound/derived.
		sql: `select distinct collection_name as collection from bolt_sync_outbox where sequence > $1 and sequence <= $2 and xid < pg_snapshot_xmin(pg_current_snapshot())::text::bigint order by collection_name`,
		parameters: [cursor.sequence, bounds.head]
	});
	const changed = yield* Schema.decodeUnknownEffect(Schema.Array(CollectionRow))(
		changedResult.rows
	).pipe(Effect.mapError(() => malformed('sync.changelogSince.collections')));
	return {
		collections: changed.map(({ collection }) => collection),
		truncated: false,
		head
	};
});
