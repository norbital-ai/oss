import { Schema } from 'effect';

/**
 * What an approval request governs, derived from history rather than tracked beside it.
 *
 * Every write already writes a `bolt_collection_history` row carrying `collection_name`,
 * `record_id`, `operation`, `snapshot`, `subject_id` and a monotonic `sequence`. Stamping that row
 * with `approval_id` makes history the ledger: the set of records a request touched is a query, not
 * a structure to maintain.
 *
 * That removes the problems a tracked set has, rather than solving them one at a time:
 *
 * - **Growth.** A revision that creates `b4` writes history under the request, so `b4` is in the
 *   ledger the moment it exists. Nothing has to remember to add it.
 * - **Cascades.** A row removed by `ON DELETE CASCADE` writes history too, so it is recovered on a
 *   rejection - the case a declared graph silently misses.
 * - **Dynamic collections.** History is one shared table keyed by name. Collections may be added,
 *   renamed or removed with no approval-side migration.
 * - **Supersession.** An inherited anchor is just the earliest sequence across both requests.
 * - **The sync engine.** A rollback is an ordinary write, so it emits outbox deltas and replicas
 *   converge without knowing approvals exist.
 */
export const LedgerEntry = Schema.Struct({
	collection_name: Schema.NonEmptyString,
	record_id: Schema.NonEmptyString,
	/** Earliest history sequence written under this request for this record. */
	first_sequence: Schema.Number,
	/**
	 * Newest history sequence for this record strictly before the request touched it.
	 *
	 * `null` means the record did not exist, so rejecting deletes it. That is the right answer for a
	 * create and for anything a revision added along the way, and it needs no special case.
	 */
	base_sequence: Schema.NullOr(Schema.Number)
});
export type LedgerEntry = Schema.Schema.Type<typeof LedgerEntry>;

/** What rejecting a request does to one record. */
export type RollbackStep =
	| Readonly<{ readonly kind: 'delete'; readonly entry: LedgerEntry }>
	| Readonly<{
			readonly kind: 'restore';
			readonly entry: LedgerEntry;
			readonly toSequence: number;
	  }>;

/**
 * The reversal, ordered so foreign keys survive it.
 *
 * Deletions run before restorations: a mixed rejection otherwise re-inserts a child before its
 * parent, or deletes a parent while a child still points at it. Within each group the newest write
 * is undone first, which unwinds nested graphs in the order they were built. The caller runs the
 * plan in one transaction with constraints deferred, covering the cycles ordering alone cannot.
 */
export const rollbackPlan = (
	ledger: ReadonlyArray<LedgerEntry>
): ReadonlyArray<RollbackStep> => {
	const newestFirst = [...ledger].toSorted((left, right) => right.first_sequence - left.first_sequence);
	return [
		...newestFirst
			.filter((entry) => entry.base_sequence === null)
			.map((entry): RollbackStep => ({ kind: 'delete', entry })),
		...newestFirst
			.filter(
				(entry): entry is LedgerEntry & { base_sequence: number } => entry.base_sequence !== null
			)
			.map((entry): RollbackStep => ({ kind: 'restore', entry, toSequence: entry.base_sequence }))
	];
};

/**
 * Folds a superseded request's ledger into its replacement.
 *
 * The replacement must roll back to what existed before the *first* request, not to what that
 * request produced - otherwise approving the replacement bakes in a change nobody approved. Because
 * both ledgers are sequences, that is simply the earlier anchor and the earlier first touch.
 */
export const inheritLedger = (
	superseded: ReadonlyArray<LedgerEntry>,
	replacement: ReadonlyArray<LedgerEntry>
): ReadonlyArray<LedgerEntry> => {
	const held = new Map<string, LedgerEntry>();
	for (const entry of [...superseded, ...replacement]) {
		const key = `${entry.collection_name} ${entry.record_id}`;
		const existing = held.get(key);
		if (existing === undefined || entry.first_sequence < existing.first_sequence) {
			held.set(key, entry);
			continue;
		}
	}
	return [...held.values()];
};
