import { Schema } from 'effect';

type HistoryOperation = 'create' | 'update' | 'delete';
type HistoryRow = Readonly<Record<string, Schema.Json>>;

export type HistoryPatch = Readonly<{
	readonly sequence: number;
	readonly operation: HistoryOperation;
	readonly snapshot: HistoryRow;
	readonly createdAt: string;
}>;

type HistoryRevision = Readonly<{
	readonly sequence: number;
	readonly operation: HistoryOperation;
	readonly values: HistoryRow;
	readonly createdAt: string;
}>;

export const DEFAULT_HISTORY_HORIZON = 256;

/** Reconstructs patch history before applying policy so a mask never changes patch semantics. */
const reconstructHistory = (
	patches: ReadonlyArray<HistoryPatch>
): ReadonlyArray<HistoryRevision> => {
	let current: HistoryRow = {};
	const revisions: Array<HistoryRevision> = [];
	for (const patch of patches.toSorted((left, right) => left.sequence - right.sequence)) {
		current = patch.operation === 'update' ? { ...current, ...patch.snapshot } : patch.snapshot;
		revisions.push({
			sequence: patch.sequence,
			operation: patch.operation,
			values: current,
			createdAt: patch.createdAt
		});
	}
	return revisions;
};

type HistoryPolicy = Readonly<{
	/** The current row predicate is the sole visibility authority for its history. */
	readonly visible: (current: HistoryRow) => boolean;
	/** The current field grant masks every reconstructed historical snapshot. */
	readonly mask: (row: HistoryRow) => HistoryRow;
}>;

type HistoryProjection =
	| Readonly<{ readonly _tag: 'Denied'; readonly revisions: readonly [] }>
	| Readonly<{ readonly _tag: 'Visible'; readonly revisions: ReadonlyArray<HistoryRevision> }>;

/** Policy-correct, bounded history. A deleted/missing current row has no predicate-visible history. */
export const projectHistory = (
	input: Readonly<{
		readonly current: HistoryRow | undefined;
		readonly patches: ReadonlyArray<HistoryPatch>;
		readonly policy: HistoryPolicy;
		readonly horizon?: number;
	}>
): HistoryProjection => {
	if (input.current === undefined || !input.policy.visible(input.current)) {
		return { _tag: 'Denied', revisions: [] };
	}
	const horizon = Math.max(1, Math.trunc(input.horizon ?? DEFAULT_HISTORY_HORIZON));
	const revisions = reconstructHistory(input.patches)
		.slice(-horizon)
		.map((revision) => ({ ...revision, values: input.policy.mask(revision.values) }));
	return { _tag: 'Visible', revisions };
};

type HistoryStatement = Readonly<{
	readonly sql: string;
	readonly parameters: ReadonlyArray<Schema.Json>;
}>;

type HistoryPruneTarget = Readonly<{
	readonly collection: string;
	readonly id: string;
	readonly definition: Readonly<{ readonly history?: boolean }>;
}>;

/**
 * One statement bounds the history of every record a batch touched.
 *
 * `$1` is the JSON list of `{collection_name, record_id}` pairs, `$2` the horizon. Only records
 * whose log has outgrown the horizon enter the recursive fold — the common case, a record with a
 * handful of entries, costs one indexed count and nothing else. The earlier form was this same
 * walk emitted verbatim once per record: a payroll that pinned 2,500 rows sent 2,500 copies of a
 * 1.4 KB statement — 3.5 MB of a write whose own rows were a tenth of that.
 */
const HISTORY_PRUNE_SQL = `with recursive
							targets as materialized (
								select distinct collection_name, record_id
								from jsonb_to_recordset($1::jsonb) as target(collection_name text, record_id text)
							),
							ordered as materialized (
								select history.collection_name, history.record_id, history.sequence, history.operation,
									coalesce(history.snapshot, '{}'::jsonb) as snapshot,
									row_number() over (partition by history.collection_name, history.record_id order by history.sequence) as ordinal,
									count(*) over (partition by history.collection_name, history.record_id) as total
								from bolt_collection_history as history
								join targets on targets.collection_name = history.collection_name
									and targets.record_id = history.record_id
							),
							fold as (
								select collection_name, record_id, sequence, operation, snapshot, ordinal, total
								from ordered where ordinal = 1 and total > $2
								union all
								select next.collection_name, next.record_id, next.sequence, next.operation,
									case when next.operation = 'update'
										then previous.snapshot || next.snapshot
										else next.snapshot end,
									next.ordinal, next.total
								from fold as previous
								join ordered as next on next.collection_name = previous.collection_name
									and next.record_id = previous.record_id
									and next.ordinal = previous.ordinal + 1
							),
							boundary as materialized (
								select collection_name, record_id, sequence, snapshot from fold
								where ordinal = total - $2 + 1
							),
							rewritten as (
								update bolt_collection_history as history
								set snapshot = boundary.snapshot
								from boundary
								where history.collection_name = boundary.collection_name
									and history.record_id = boundary.record_id
									and history.sequence = boundary.sequence
								returning history.collection_name, history.record_id, history.sequence
							)
						delete from bolt_collection_history as history
						using boundary
						where history.collection_name = boundary.collection_name
							and history.record_id = boundary.record_id
							and history.sequence < boundary.sequence
							and exists(
								select 1 from rewritten
								where rewritten.collection_name = history.collection_name
									and rewritten.record_id = history.record_id
							)`;

/** One prune for the batch's distinct history-bearing records; later writes reuse the same bounded log. */
export const historyPruneStatements = (
	operations: ReadonlyArray<HistoryPruneTarget>,
	horizon: number = DEFAULT_HISTORY_HORIZON
): ReadonlyArray<HistoryStatement> => {
	const targets = [
		...new Map(
			operations
				.filter((operation) => operation.definition.history)
				.map((operation) => [`${operation.collection}\u0000${operation.id}`, operation])
		).values()
	].map((operation) => ({ collection_name: operation.collection, record_id: operation.id }));
	return targets.length === 0
		? []
		: [{ sql: HISTORY_PRUNE_SQL, parameters: [JSON.stringify(targets), horizon] }];
};

export const PersistedCollectionHistoryRow = Schema.Struct({
	sequence: Schema.Number,
	created_at: Schema.String,
	operation: Schema.Literals(['create', 'update', 'delete']),
	snapshot: Schema.NullOr(Schema.Record(Schema.String, Schema.Json))
});
export type PersistedCollectionHistoryRow = typeof PersistedCollectionHistoryRow.Type;

export const PersistedCollectionAuditRow = Schema.Struct({
	kind: Schema.Literals(['data-write', 'browser-outcome', 'approval-decision']),
	created_at: Schema.String,
	actor: Schema.String,
	effect_id: Schema.NullOr(Schema.String),
	governing_request: Schema.NullOr(Schema.String),
	payload: Schema.Json
});
export type PersistedCollectionAuditRow = typeof PersistedCollectionAuditRow.Type;

/** The patch log for one record, newest last — the same order `projectHistory` folds. */
export const collectionHistoryReadStatement = (
	collection: string,
	id: string
): HistoryStatement => ({
	// repository-health:allow SQL1 -- fixed system table; collection and id are bound.
	sql: `select sequence, created_at, operation, snapshot from bolt_collection_history where collection_name = $1 and record_id = $2 order by sequence`,
	parameters: [collection, id]
});

/** Data-write, browser-outcome, and approval-decision rows for one record, newest first. */
export const collectionAuditJoinStatement = (
	collection: string,
	id: string,
	limit: number
): HistoryStatement => ({
	// repository-health:allow SQL1 -- fixed system tables; collection/id/limit are bound.
	sql: `select * from (
	select 'data-write'::text as kind, h.created_at::text as created_at, h.subject_id::text as actor, h.effect_id::text as effect_id, h.approval_id::text as governing_request, coalesce(h.snapshot, '{}'::jsonb) as payload
	from bolt_collection_history h where h.collection_name = $1 and h.record_id = $2
	union all
	select 'browser-outcome'::text, b.created_at::text, b.principal_id::text, b.idempotency_key::text, null::text, coalesce(b.outcome, '{}'::jsonb)
	from bolt_browser_mutation b where b.outcome->>'collection' = $1 and b.outcome->>'id' = $2
	union all
	select 'approval-decision'::text, a.created_at::text, a.subject_id::text, null::text, a.request_id::text, a.payload
	from bolt_audit a join bolt_approvals s on s.request_id = a.request_id
	where s.state->'operation'->>'collection' = $1 and s.state->'operation'->>'id' = $2
) audit order by created_at desc limit $3`,
	parameters: [collection, id, limit]
});

export const historyPatchesFromRows = (
	rows: ReadonlyArray<PersistedCollectionHistoryRow>
): ReadonlyArray<HistoryPatch> =>
	rows.map((row) => ({
		sequence: row.sequence,
		operation: row.operation,
		snapshot: row.snapshot ?? {},
		createdAt: row.created_at
	}));

type PresentedHistoryRevision = Readonly<{
	readonly values: HistoryRow;
	readonly validFrom: string;
	readonly validTo: string | null;
	readonly version: number;
}>;

/** Browser-facing snapshots: each patch is a complete row with an effective interval. */
export const presentHistoryRevisions = (
	revisions: ReadonlyArray<HistoryRevision>
): ReadonlyArray<PresentedHistoryRevision> =>
	revisions.map((revision, index) => ({
		values: revision.values,
		validFrom: revision.createdAt,
		validTo: revisions[index + 1]?.createdAt ?? null,
		version: revision.sequence
	}));
