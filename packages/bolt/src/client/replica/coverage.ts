// repository-health:allow SEM_PARALLEL -- this module is the proof layer over the structured
// replica store; the #lib aliases hide that direct dependency from the repository probe.
import { Effect, Result, Schema, Semaphore } from 'effect';
import { compareSyncCursors, type SyncCursor } from '#lib/runtime/sync/sync.js';
import {
	readReplicaPosition,
	writeReplicaPosition,
	withTransaction,
	type AuthoritativeReplicaRow,
	type LocalReplicaStore,
	type PGliteLike,
	type ReplicaPosition
} from '#lib/client/replica/pglite-sql.js';
import { stableStringify } from '#lib/client/replica/query-cache.js';
import type { ClientQueryWindowDescription } from '#lib/client/replica/query-window.js';
import { CollectionRelationshipMembership } from '@norbital-ai/bolt-protocol';

const asRecord = (input: unknown): Readonly<Record<string, unknown>> | undefined =>
	input === null || typeof input !== 'object' || Array.isArray(input)
		? undefined
		: (input as Readonly<Record<string, unknown>>);

const jsonRecord = (value: unknown): Readonly<Record<string, Schema.Json>> | undefined => {
	const decoded = Schema.decodeUnknownResult(Schema.Record(Schema.String, Schema.Json))(value);
	return Result.isSuccess(decoded) ? decoded.success : undefined;
};

const jsonValue = (value: unknown): Schema.Json | undefined => {
	if (typeof value !== 'string') return Schema.is(Schema.Json)(value) ? value : undefined;
	const parsed = Result.try(() => JSON.parse(value) as unknown);
	return Result.isSuccess(parsed) && Schema.is(Schema.Json)(parsed.success)
		? parsed.success
		: undefined;
};

const generationsOf = (value: unknown): Readonly<Record<string, number>> => {
	const record = asRecord(jsonValue(value));
	if (record === undefined) return {};
	const entries = Object.entries(record).filter(
		(entry): entry is [string, number] =>
			entry[0].length > 0 &&
			typeof entry[1] === 'number' &&
			Number.isSafeInteger(entry[1]) &&
			entry[1] >= 0
	);
	return entries.length === Object.keys(record).length ? Object.fromEntries(entries) : {};
};

const stringsOf = (value: unknown): ReadonlyArray<string> => {
	const decoded = Schema.decodeUnknownResult(Schema.Array(Schema.NonEmptyString))(jsonValue(value));
	return Result.isSuccess(decoded) ? decoded.success : [];
};

const serverResultOf = (value: unknown): ServerQueryResultDescriptor | undefined => {
	const record = asRecord(jsonValue(value));
	if (record?.['kind'] === 'count') {
		const count = record['value'];
		return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
			? { kind: 'count', value: count }
			: undefined;
	}
	if (record?.['kind'] !== 'findGrouped') return undefined;
	const groups = asRecord(record['groups']);
	if (groups === undefined) return undefined;
	const decoded: Record<string, ReadonlyArray<string>> = {};
	for (const [group, ids] of Object.entries(groups)) {
		if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || id.length === 0)) {
			return undefined;
		}
		const values = ids as ReadonlyArray<string>;
		if (new Set(values).size !== values.length) return undefined;
		decoded[group] = values;
	}
	return { kind: 'findGrouped', groups: decoded };
};

const validCursor = (cursor: SyncCursor): boolean =>
	Number.isSafeInteger(cursor.xid) &&
	Number.isSafeInteger(cursor.sequence) &&
	cursor.xid >= 0 &&
	cursor.sequence >= 0;

const validGenerationMap = (generations: Readonly<Record<string, number>>): boolean =>
	Object.entries(generations).every(
		([collection, generation]) =>
			collection.length > 0 && Number.isSafeInteger(generation) && generation >= 0
	);

export type QueryWindowDescriptor = Readonly<{
	readonly queryKey: string;
	readonly canonical: Readonly<Record<string, Schema.Json>>;
	readonly collection: string;
	readonly dependencies: ReadonlyArray<string>;
	readonly proofOwner: 'local' | 'server';
	readonly locallyReproducible: boolean;
}>;

/** Adapts the shared canonical-query authority into the durable window ledger. */
export const windowDescriptorOf = (
	description: ClientQueryWindowDescription
): QueryWindowDescriptor => {
	const canonical = jsonRecord(description.query);
	if (canonical === undefined) throw new Error('Canonical collection query is not JSON');
	const locallyReproducible = description.reproducibility._tag === 'LocalExact';
	return {
		queryKey: description.queryKey,
		canonical,
		collection: description.query.collection,
		dependencies: description.dependencies,
		proofOwner: locallyReproducible ? 'local' : 'server',
		locallyReproducible
	};
};

export type WindowBaseRow = AuthoritativeReplicaRow;
export type WindowReference = Readonly<{ readonly collection: string; readonly recordId: string }>;
export type ServerQueryResultDescriptor =
	| Readonly<{ readonly kind: 'count'; readonly value: number }>
	| Readonly<{
			readonly kind: 'findGrouped';
			readonly groups: Readonly<Record<string, ReadonlyArray<string>>>;
	  }>;

export const MAX_REPLICA_WINDOW_ROWS = 5_000;
export const MAX_REPLICA_WINDOW_LOOKAHEAD_ROWS = 500;
export const MAX_REPLICA_WINDOW_RELATIONSHIPS = 20_000;
export const INACTIVE_WINDOW_TTL_MILLIS = 5 * 60 * 1_000;

export type InstallQueryWindow = Readonly<{
	readonly window: QueryWindowDescriptor;
	readonly dependencies: ReadonlyArray<string>;
	readonly baseRows: ReadonlyArray<WindowBaseRow>;
	readonly orderedRowIds: ReadonlyArray<string>;
	/** Normalized relation edges; both base-row endpoints remain protected while the window lives. */
	readonly relationshipRefs?: ReadonlyArray<CollectionRelationshipMembership>;
	/** Exact aggregate/group result retained only for an authoritative ServerProof window. */
	readonly serverResult?: ServerQueryResultDescriptor;
	readonly nextCursor: string | null;
	readonly readCursor: SyncCursor;
	readonly dependencyGenerations: Readonly<Record<string, number>>;
	/** A continuation appends; a bounded root refill refreshes the prefix without discarding its tail. */
	readonly continuation: string | null;
	readonly lookaheadCount: number;
	readonly valid?: boolean;
	/** Stream facts buffered after readCursor; applied before this installation becomes observable. */
	readonly bufferedDeltas?: PartitionDeltaBatch;
}>;

export type QueryWindowProof = Readonly<{
	readonly queryKey: string;
	readonly canonical: Readonly<Record<string, Schema.Json>>;
	readonly collection: string;
	readonly dependencies: ReadonlyArray<string>;
	readonly proofOwner: 'local' | 'server';
	readonly locallyReproducible: boolean;
	readonly valid: boolean;
	readonly dirty: boolean;
	readonly readCursor: SyncCursor;
	readonly dependencyGenerations: Readonly<Record<string, number>>;
	readonly orderedRowIds: ReadonlyArray<string>;
	readonly relationshipRefs: ReadonlyArray<CollectionRelationshipMembership>;
	readonly serverResult?: ServerQueryResultDescriptor;
	readonly nextCursor: string | null;
	readonly lookaheadCount: number;
	readonly leaseCount: number;
}>;

export type QueryWindowSummary = Readonly<{
	readonly id: string;
	readonly collection: string;
	readonly kind: 'window';
	readonly valid: boolean;
	readonly dirty: boolean;
	readonly leaseCount: number;
	readonly bytes: number;
	readonly lastAccess: number;
}>;

export type PartitionDelta =
	| Readonly<{
			readonly cursor: SyncCursor;
			readonly collection: string;
			readonly op: 'upsert';
			readonly recordId: string;
			readonly rowVersion: number;
			readonly row: Readonly<Record<string, unknown>>;
			readonly mutationId: string | null;
	  }>
	| Readonly<{
			readonly cursor: SyncCursor;
			readonly collection: string;
			readonly op: 'remove';
			readonly recordId: string;
			readonly rowVersion: number;
			readonly mutationId: string | null;
	  }>;

export type PartitionDeltaBatch = Readonly<{
	readonly deltas: ReadonlyArray<PartitionDelta>;
	readonly headCursor: SyncCursor;
	readonly generations: Readonly<Record<string, number>>;
	readonly affectedCollections: ReadonlyArray<string>;
	/** Link/policy or otherwise unexplained generation movement that always requires server refill. */
	readonly refillCollections: ReadonlyArray<string>;
}>;

export type DeltaApplyOutcome = Readonly<{
	readonly applied: number;
	readonly collections: ReadonlyArray<string>;
	readonly affectedWindowIds: ReadonlyArray<string>;
	readonly proofWithdrawals: ReadonlyArray<string>;
}>;

export type WindowDirtyOutcome = Readonly<{
	readonly affectedWindowIds: ReadonlyArray<string>;
	readonly proofWithdrawals: ReadonlyArray<string>;
}>;

export type RecomputedWindow = Readonly<{
	readonly queryKey: string;
	readonly orderedRowIds: ReadonlyArray<string>;
	/** O4-created rows allowed in membership without being persisted into authoritative O3. */
	readonly optimisticRowIds?: ReadonlyArray<string>;
	readonly readCursor: SyncCursor;
	readonly dependencyGenerations: Readonly<Record<string, number>>;
	readonly lookaheadCount: number;
	readonly nextCursor: string | null;
	readonly boundaryCovered: boolean;
}>;

export class ReplicaHeadMovedBackwards extends Error {
	readonly current: SyncCursor;
	readonly incoming: SyncCursor;

	constructor(current: SyncCursor, incoming: SyncCursor) {
		super(
			'Authoritative head moved behind the durable replica position; namespace rebuild required'
		);
		this.name = 'ReplicaHeadMovedBackwards';
		this.current = current;
		this.incoming = incoming;
	}
}

export type WindowLedger = Readonly<{
	readonly transaction: <Value>(
		body: Effect.Effect<Value, unknown>
	) => Effect.Effect<Value, unknown>;
	readonly readWindow: <Value>(
		queryKey: string,
		use: (proof: QueryWindowProof) => Effect.Effect<Value, unknown>
	) => Effect.Effect<Value | undefined, unknown>;
	readonly installWindow: (input: InstallQueryWindow) => Effect.Effect<QueryWindowProof, unknown>;
	readonly applyDeltaBatch: (
		input: PartitionDeltaBatch
	) => Effect.Effect<DeltaApplyOutcome, unknown>;
	readonly invalidateDependencies: (
		collections: ReadonlyArray<string>,
		generations?: Readonly<Record<string, number>>
	) => Effect.Effect<ReadonlyArray<string>, unknown>;
	/** O4 changed the read view: dirty LocalExact windows without moving authoritative O6. */
	readonly dirtyDependencies: (
		collections: ReadonlyArray<string>
	) => Effect.Effect<WindowDirtyOutcome, unknown>;
	readonly recomputeWindow: (input: RecomputedWindow) => Effect.Effect<boolean, unknown>;
	/** Idempotently acquires this exact owner's durable hold on one window. */
	readonly acquireWindowLease: (
		queryKey: string,
		ownerId: string
	) => Effect.Effect<boolean, unknown>;
	/** Releases only this exact owner's hold; an unmatched release changes nothing. */
	readonly releaseWindowLease: (
		queryKey: string,
		ownerId: string
	) => Effect.Effect<boolean, unknown>;
	readonly releaseWindow: (
		queryKey: string,
		protectedRows?: ReadonlyArray<WindowReference>
	) => Effect.Effect<number, unknown>;
	readonly expireInactiveWindows: (
		protectedRows?: ReadonlyArray<WindowReference>
	) => Effect.Effect<ReadonlyArray<string>, unknown>;
	readonly pruneBaseRows: (
		protectedRows?: ReadonlyArray<WindowReference>
	) => Effect.Effect<number, unknown>;
	readonly listWindows: () => Effect.Effect<ReadonlyArray<QueryWindowSummary>, unknown>;
	readonly dependencies: () => Effect.Effect<ReadonlyArray<string>, unknown>;
	readonly position: () => Effect.Effect<ReplicaPosition, unknown>;
	/** Advances O6 after an M3 rehydrate has installed every active window it covers. */
	readonly recordPosition: (position: ReplicaPosition) => Effect.Effect<ReplicaPosition, unknown>;
	/** Clears only reconstructible O3/O5 state and resets O6 to the origin. */
	readonly rebuildNamespace: () => Effect.Effect<void, unknown>;
}>;

type StoredWindowRow = Readonly<{
	readonly query_key: string;
	readonly collection: string;
	readonly canonical_query: unknown;
	readonly dependencies: unknown;
	readonly proof_owner: string;
	readonly locally_reproducible: boolean;
	readonly proof_confirmed: boolean;
	readonly valid: boolean;
	readonly dirty: boolean;
	readonly read_xid: number | string;
	readonly read_sequence: number | string;
	readonly dependency_generations: unknown;
	readonly server_result: unknown;
	readonly next_cursor: string | null;
	readonly lookahead_count: number | string;
	readonly lease_count: number | string;
}>;

type StoredWindowProofRow = StoredWindowRow &
	Readonly<{
		readonly membership: unknown;
		readonly relationships: unknown;
	}>;

const readStoredWindow = (
	database: PGliteLike,
	queryKey: string
): Effect.Effect<StoredWindowRow | undefined, unknown> =>
	database
		.query<StoredWindowRow>(
			`select query_key, collection, canonical_query, dependencies, proof_owner,
		 locally_reproducible, proof_confirmed, valid, dirty, read_xid, read_sequence,
		 dependency_generations, server_result, next_cursor, lookahead_count, lease_count
		 from bolt_replica_window where query_key = $1 limit 1`,
			[queryKey]
		)
		.pipe(Effect.map(({ rows }) => rows[0]));

const proofFrom = (stored: StoredWindowProofRow): QueryWindowProof | undefined => {
	const canonical = jsonRecord(jsonValue(stored.canonical_query));
	const dependencies = stringsOf(stored.dependencies);
	if (
		canonical === undefined ||
		dependencies.length === 0 ||
		(stored.proof_owner !== 'local' && stored.proof_owner !== 'server') ||
		(stored.proof_owner === 'local') !== stored.locally_reproducible
	)
		return undefined;
	const membershipValue = jsonValue(stored.membership);
	if (!Array.isArray(membershipValue)) return undefined;
	const membership = membershipValue.flatMap((value) => {
		const row = asRecord(value);
		const ordinal = row?.['ordinal'];
		const recordId = row?.['recordId'];
		return (typeof ordinal === 'number' || typeof ordinal === 'string') &&
			typeof recordId === 'string'
			? [{ ordinal, recordId }]
			: [];
	});
	if (membership.length !== membershipValue.length) return undefined;
	const dependencyGenerations = generationsOf(stored.dependency_generations);
	const generationKeys = Object.keys(dependencyGenerations).toSorted();
	const sortedDependencies = [...dependencies].toSorted();
	const readCursor = { xid: Number(stored.read_xid), sequence: Number(stored.read_sequence) };
	const lookaheadCount = Number(stored.lookahead_count);
	const leaseCount = Number(stored.lease_count);
	if (
		membership.length > MAX_REPLICA_WINDOW_ROWS ||
		membership.some((row, index) => Number(row.ordinal) !== index) ||
		generationKeys.length !== sortedDependencies.length ||
		generationKeys.some((collection, index) => collection !== sortedDependencies[index]) ||
		!validCursor(readCursor) ||
		!Number.isSafeInteger(lookaheadCount) ||
		lookaheadCount < 0 ||
		lookaheadCount > Math.min(membership.length, MAX_REPLICA_WINDOW_LOOKAHEAD_ROWS) ||
		!Number.isSafeInteger(leaseCount) ||
		leaseCount < 0
	)
		return undefined;
	const relationships = Schema.decodeUnknownResult(Schema.Array(CollectionRelationshipMembership))(
		jsonValue(stored.relationships)
	);
	if (
		Result.isFailure(relationships) ||
		relationships.success.length > MAX_REPLICA_WINDOW_RELATIONSHIPS
	)
		return undefined;
	const serverResult =
		stored.server_result == null ? undefined : serverResultOf(stored.server_result);
	if (
		(stored.server_result != null && serverResult === undefined) ||
		(serverResult !== undefined && stored.proof_owner !== 'server')
	)
		return undefined;
	return {
		queryKey: stored.query_key,
		canonical,
		collection: stored.collection,
		dependencies,
		proofOwner: stored.proof_owner,
		locallyReproducible: stored.locally_reproducible,
		valid: stored.valid,
		dirty: stored.dirty,
		readCursor,
		dependencyGenerations,
		orderedRowIds: membership.map(({ recordId }) => recordId),
		relationshipRefs: relationships.success,
		...(serverResult === undefined ? {} : { serverResult }),
		nextCursor: stored.next_cursor,
		lookaheadCount,
		leaseCount
	};
};

const uniqueNonEmpty = (values: ReadonlyArray<string>, label: string): ReadonlyArray<string> => {
	if (values.some((value) => value.length === 0) || new Set(values).size !== values.length) {
		throw new Error(`${label} must be unique non-empty strings`);
	}
	return values;
};

const proofGenerationsCurrent = (
	dependencies: ReadonlyArray<string>,
	proof: Readonly<Record<string, number>>,
	known: Readonly<Record<string, number>>
): boolean => dependencies.every((collection) => proof[collection] === (known[collection] ?? 0));

const mergeGenerations = (
	current: Readonly<Record<string, number>>,
	incoming: Readonly<Record<string, number>>
): Readonly<Record<string, number>> => {
	const merged: Record<string, number> = { ...current };
	for (const [collection, generation] of Object.entries(incoming)) {
		merged[collection] = Math.max(merged[collection] ?? 0, generation);
	}
	return merged;
};

const WINDOW_MEMBERSHIP_WRITE_BATCH = 500;

/** Bounded set-based membership writes preserve ordinals without one round trip per identity. */
const insertWindowMembership = Effect.fn('ReplicaWindow.insertMembership')(function* (
	database: PGliteLike,
	queryKey: string,
	collection: string,
	recordIds: ReadonlyArray<string>,
	startOrdinal = 0
): Effect.fn.Return<void, unknown> {
	for (let offset = 0; offset < recordIds.length; offset += WINDOW_MEMBERSHIP_WRITE_BATCH) {
		const batch = recordIds.slice(offset, offset + WINDOW_MEMBERSHIP_WRITE_BATCH);
		yield* database.query(
			`insert into bolt_replica_window_row (query_key, ordinal, collection, record_id)
			 select $1, $2::integer + member.ordinality::integer - 1, $3, member.record_id
			 from unnest($4::uuid[]) with ordinality as member(record_id, ordinality)`,
			[queryKey, startOrdinal + offset, collection, batch]
		);
	}
});

/** Relationship edges use the same bounded set-based write discipline as root membership. */
const insertWindowRelationships = Effect.fn('ReplicaWindow.insertRelationships')(function* (
	database: PGliteLike,
	queryKey: string,
	relationships: ReadonlyArray<CollectionRelationshipMembership>
): Effect.fn.Return<void, unknown> {
	for (let offset = 0; offset < relationships.length; offset += WINDOW_MEMBERSHIP_WRITE_BATCH) {
		const batch = relationships.slice(offset, offset + WINDOW_MEMBERSHIP_WRITE_BATCH);
		yield* database.query(
			`insert into bolt_replica_window_relationship
			 (query_key, source_collection, source_record_id, relation,
			  target_collection, target_record_id)
			 select $1, edge.source_collection, edge.source_record_id,
			  edge.relation, edge.target_collection, edge.target_record_id
			 from unnest($2::text[], $3::uuid[], $4::text[], $5::text[], $6::uuid[])
			 as edge(source_collection, source_record_id, relation, target_collection, target_record_id)
			 on conflict do nothing`,
			[
				queryKey,
				batch.map(({ sourceCollection }) => sourceCollection),
				batch.map(({ sourceRecordId }) => sourceRecordId),
				batch.map(({ relation }) => relation),
				batch.map(({ targetCollection }) => targetCollection),
				batch.map(({ targetRecordId }) => targetRecordId)
			]
		);
	}
});

export const createWindowLedger = Effect.fn('ReplicaWindow.create')(function* (
	database: PGliteLike,
	store: LocalReplicaStore
): Effect.fn.Return<WindowLedger, never> {
	const permit = yield* Semaphore.make(1);
	const transaction = <Value>(body: Effect.Effect<Value, unknown>) =>
		permit.withPermit(withTransaction(database, body));
	const refreshConfirmedProofs = Effect.fn('ReplicaWindow.refreshConfirmedProofs')(function* (
		position: ReplicaPosition
	): Effect.fn.Return<void, unknown> {
		const windows = yield* database.query<StoredWindowRow>(
			`select query_key, collection, canonical_query, dependencies, proof_owner,
			 locally_reproducible, proof_confirmed, valid, dirty, read_xid, read_sequence,
			 dependency_generations, server_result, next_cursor, lookahead_count, lease_count
			 from bolt_replica_window`
		);
		for (const stored of windows.rows) {
			const dependencies = stringsOf(stored.dependencies);
			const proofCursor = { xid: Number(stored.read_xid), sequence: Number(stored.read_sequence) };
			const valid =
				stored.proof_confirmed &&
				!stored.dirty &&
				compareSyncCursors(proofCursor, position.cursor) <= 0 &&
				proofGenerationsCurrent(
					dependencies,
					generationsOf(stored.dependency_generations),
					position.generations
				) &&
				(stored.next_cursor === null || Number(stored.lookahead_count) > 0);
			if (valid === stored.valid) continue;
			yield* database.query('update bolt_replica_window set valid = $2 where query_key = $1', [
				stored.query_key,
				valid
			]);
		}
	});

	const readProof = Effect.fn('ReplicaWindow.readProof')(function* (
		queryKey: string
	): Effect.fn.Return<QueryWindowProof | undefined, unknown> {
		const snapshot = yield* database.query<StoredWindowProofRow>(
			`select stored_window.query_key, stored_window.collection, stored_window.canonical_query,
			 stored_window.dependencies, stored_window.proof_owner, stored_window.locally_reproducible,
			 stored_window.proof_confirmed, stored_window.valid, stored_window.dirty, stored_window.read_xid,
			 stored_window.read_sequence, stored_window.dependency_generations, stored_window.server_result,
			 stored_window.next_cursor, stored_window.lookahead_count, stored_window.lease_count,
			 coalesce((
				select jsonb_agg(
					jsonb_build_object('ordinal', member.ordinal, 'recordId', member.record_id)
					order by member.ordinal
				)
				from bolt_replica_window_row as member
				where member.query_key = stored_window.query_key
			 ), '[]'::jsonb) as membership,
			 coalesce((
				select jsonb_agg(
					jsonb_build_object(
						'sourceCollection', edge.source_collection,
						'sourceRecordId', edge.source_record_id,
						'relation', edge.relation,
						'targetCollection', edge.target_collection,
						'targetRecordId', edge.target_record_id
					)
					order by edge.source_collection, edge.source_record_id, edge.relation,
						edge.target_collection, edge.target_record_id
				)
				from bolt_replica_window_relationship as edge
				where edge.query_key = stored_window.query_key
			 ), '[]'::jsonb) as relationships
			 from bolt_replica_window as stored_window
			 where stored_window.query_key = $1
			 limit 1`,
			[queryKey]
		);
		const stored = snapshot.rows[0];
		if (stored === undefined) return undefined;
		return proofFrom(stored);
	});

	const invalidate = Effect.fn('ReplicaWindow.invalidate')(function* (
		collections: ReadonlyArray<string>,
		generations?: Readonly<Record<string, number>>
	): Effect.fn.Return<ReadonlyArray<string>, unknown> {
		const targets = new Set(collections);
		if (targets.size === 0) return [];
		const rows = yield* database.query<{
			readonly query_key: string;
			readonly dependencies: unknown;
		}>('select query_key, dependencies from bolt_replica_window');
		const affected = rows.rows.flatMap((row) =>
			stringsOf(row.dependencies).some((dependency) => targets.has(dependency))
				? [row.query_key]
				: []
		);
		if (affected.length > 0) {
			yield* database.query(
				`update bolt_replica_window set valid = false, dirty = false, proof_confirmed = false
				 where query_key = any($1::text[])`,
				[affected]
			);
		}
		if (generations !== undefined) {
			const current = yield* readReplicaPosition(database);
			yield* writeReplicaPosition(database, {
				cursor: current.cursor,
				generations: mergeGenerations(current.generations, generations)
			});
		}
		return affected;
	});

	const dirtyOverlayDependencies = Effect.fn('ReplicaWindow.dirtyOverlayDependencies')(function* (
		collections: ReadonlyArray<string>
	): Effect.fn.Return<WindowDirtyOutcome, unknown> {
		const targets = new Set(collections);
		if (targets.size === 0) return { affectedWindowIds: [], proofWithdrawals: [] };
		const rows = yield* database.query<{
			readonly query_key: string;
			readonly dependencies: unknown;
			readonly proof_owner: string;
			readonly locally_reproducible: boolean;
			readonly valid: boolean;
		}>(
			`select query_key, dependencies, proof_owner, locally_reproducible, valid
			 from bolt_replica_window`
		);
		const affectedWindowIds: Array<string> = [];
		const proofWithdrawals: Array<string> = [];
		for (const window of rows.rows) {
			if (!stringsOf(window.dependencies).some((dependency) => targets.has(dependency))) continue;
			affectedWindowIds.push(window.query_key);
			const dirty = window.valid && window.proof_owner === 'local' && window.locally_reproducible;
			yield* database.query(
				`update bolt_replica_window set valid = false, dirty = $2,
				 proof_confirmed = false where query_key = $1`,
				[window.query_key, dirty]
			);
			if (!dirty) proofWithdrawals.push(window.query_key);
		}
		return { affectedWindowIds, proofWithdrawals };
	});

	const prune = Effect.fn('ReplicaWindow.pruneBaseRows')(function* (
		protectedRows: ReadonlyArray<WindowReference> = []
	): Effect.fn.Return<number, unknown> {
		const protectedKeys = new Set(
			protectedRows.map(({ collection, recordId }) => `${collection}\u0000${recordId}`)
		);
		const candidates = yield* database.query<{
			readonly collection: string;
			readonly record_id: string;
			readonly present: boolean;
		}>(
			`select base.collection, base.record_id, base.present from bolt_replica_base_row base
			 where (base.present = true or (
				base.present = false and base.tombstone_until <= current_timestamp
			 ))
			 and not exists (select 1 from bolt_replica_window_row member
				where member.collection = base.collection and member.record_id = base.record_id)
			 and not exists (select 1 from bolt_replica_window_relationship related
				where (related.source_collection = base.collection and related.source_record_id = base.record_id)
				or (related.target_collection = base.collection and related.target_record_id = base.record_id))`
		);
		const evictions = new Map<string, Array<string>>();
		const expiredTombstones = new Map<string, Array<string>>();
		for (const candidate of candidates.rows) {
			if (protectedKeys.has(`${candidate.collection}\u0000${candidate.record_id}`)) continue;
			const target = candidate.present ? evictions : expiredTombstones;
			const ids = target.get(candidate.collection) ?? [];
			ids.push(candidate.record_id);
			target.set(candidate.collection, ids);
		}
		let removed = 0;
		for (const [collection, recordIds] of evictions) {
			removed += yield* store.deleteRecords(collection, recordIds);
		}
		for (const [collection, recordIds] of expiredTombstones) {
			const forgotten = yield* database.query<{ readonly record_id: string }>(
				`delete from bolt_replica_base_row
				 where collection = $1 and record_id = any($2::uuid[])
				 and present = false and tombstone_until <= current_timestamp
				 returning record_id`,
				[collection, recordIds]
			);
			removed += forgotten.rows.length;
		}
		return removed;
	});

	const applyBatch = Effect.fn('ReplicaWindow.applyDeltaBatch')(function* (
		input: PartitionDeltaBatch,
		flight?: Readonly<{
			readonly queryKey: string;
			readonly stagingCollections: ReadonlyArray<string>;
		}>
	): Effect.fn.Return<DeltaApplyOutcome, unknown> {
		if (!validCursor(input.headCursor) || !validGenerationMap(input.generations)) {
			return yield* Effect.fail(new Error('Invalid partition delta batch position'));
		}
		const refillCollections = new Set(
			uniqueNonEmpty([...input.refillCollections], 'Refill collections')
		);
		const reportedAffectedCollections = uniqueNonEmpty(
			[...input.affectedCollections],
			'Affected collections'
		);
		const current = yield* readReplicaPosition(database);
		if (compareSyncCursors(input.headCursor, current.cursor) < 0) {
			return yield* Effect.fail(new ReplicaHeadMovedBackwards(current.cursor, input.headCursor));
		}
		const windows = yield* database.query<{
			readonly query_key: string;
			readonly dependencies: unknown;
			readonly proof_owner: string;
			readonly locally_reproducible: boolean;
			readonly valid: boolean;
			readonly dirty: boolean;
			readonly lease_count: number | string;
		}>(
			`select query_key, dependencies, proof_owner, locally_reproducible, valid, dirty, lease_count
			 from bolt_replica_window`
		);
		const stagingCollections = new Set([
			...(flight?.stagingCollections ?? []),
			...windows.rows.flatMap((window) =>
				window.proof_owner === 'local' &&
				window.locally_reproducible &&
				(window.valid || window.dirty) &&
				Number(window.lease_count) > 0
					? stringsOf(window.dependencies)
					: []
			)
		]);
		let applied = 0;
		const rowActivityCollections = new Set<string>();
		const droppedCollections = new Set<string>();
		const latestByRecord = new Map<string, PartitionDelta>();
		for (const delta of input.deltas) {
			if (
				!validCursor(delta.cursor) ||
				compareSyncCursors(delta.cursor, input.headCursor) > 0 ||
				compareSyncCursors(delta.cursor, current.cursor) <= 0
			)
				continue;
			const key = `${delta.collection}\u0000${delta.recordId}`;
			const prior = latestByRecord.get(key);
			if (
				prior === undefined ||
				compareSyncCursors(delta.cursor, prior.cursor) > 0 ||
				(compareSyncCursors(delta.cursor, prior.cursor) === 0 &&
					delta.rowVersion > prior.rowVersion)
			)
				latestByRecord.set(key, delta);
		}
		const ordered = [...latestByRecord.values()].toSorted((left, right) =>
			compareSyncCursors(left.cursor, right.cursor)
		);
		for (const delta of ordered) {
			const retained = yield* store.hasRecord(delta.collection, delta.recordId);
			// ServerProof membership is opaque. An unseen upsert advances its causal fence but its
			// payload is immediately evicted, and every dependent proof is withdrawn for refill.
			const dropsPayload =
				!retained && (delta.op === 'remove' || !stagingCollections.has(delta.collection));
			const outcome =
				delta.op === 'upsert'
					? yield* store.applyAuthoritativeRow({
							collection: delta.collection,
							recordId: delta.recordId,
							rowVersion: delta.rowVersion,
							cursor: delta.cursor,
							row: delta.row
						})
					: yield* store.removeAuthoritativeRow({ ...delta, cursor: delta.cursor });
			if (dropsPayload) {
				droppedCollections.add(delta.collection);
				if (outcome.applied && delta.op === 'upsert') {
					yield* store.deleteRecords(delta.collection, [delta.recordId]);
				}
			}
			if (!outcome.applied || dropsPayload) continue;
			applied += 1;
			rowActivityCollections.add(delta.collection);
		}
		for (const collection of droppedCollections) refillCollections.add(collection);
		for (const [collection, generation] of Object.entries(input.generations)) {
			if (
				generation > (current.generations[collection] ?? 0) &&
				!rowActivityCollections.has(collection)
			)
				refillCollections.add(collection);
		}
		const affectedWindowIds: Array<string> = [];
		const proofWithdrawals: Array<string> = [];
		for (const window of windows.rows) {
			const dependencies = stringsOf(window.dependencies);
			const mustRefill = dependencies.some((dependency) => refillCollections.has(dependency));
			const needsRerun = dependencies.some((dependency) => rowActivityCollections.has(dependency));
			if (!mustRefill && !needsRerun) continue;
			affectedWindowIds.push(window.query_key);
			const dirty =
				(window.valid || window.dirty) &&
				needsRerun &&
				!mustRefill &&
				window.proof_owner === 'local' &&
				window.locally_reproducible &&
				(Number(window.lease_count) > 0 || window.query_key === flight?.queryKey);
			yield* database.query(
				`update bolt_replica_window set valid = false, dirty = $2,
				 proof_confirmed = false where query_key = $1`,
				[window.query_key, dirty]
			);
			if (!dirty) proofWithdrawals.push(window.query_key);
		}
		const recorded = {
			cursor: input.headCursor,
			generations: mergeGenerations(current.generations, input.generations)
		};
		yield* writeReplicaPosition(database, recorded);
		yield* refreshConfirmedProofs(recorded);
		return {
			applied,
			collections: [
				...new Set([
					...reportedAffectedCollections,
					...rowActivityCollections,
					...refillCollections
				])
			],
			affectedWindowIds,
			proofWithdrawals
		};
	});

	return {
		transaction,
		readWindow: (queryKey, use) =>
			Effect.gen(function* () {
				const before = yield* readProof(queryKey);
				if (before === undefined) return undefined;
				const value = yield* use(before);
				if (value === undefined) return undefined;
				// A local answer may read base rows after the proof snapshot. Confirm the same atomic proof is
				// still installed before returning it; a concurrent delta/window install makes this attempt
				// decline and retry remotely instead of serving mixed generations. Both snapshots are one
				// bounded SELECT and never acquire the writer permit or open a transaction.
				const after = yield* readProof(queryKey);
				return after !== undefined && stableStringify(before) === stableStringify(after)
					? value
					: undefined;
			}),
		installWindow: (input) =>
			transaction(
				Effect.gen(function* () {
					if (!validCursor(input.readCursor) || !validGenerationMap(input.dependencyGenerations)) {
						return yield* Effect.fail(new Error('Invalid authoritative query-window proof'));
					}
					const dependencies = uniqueNonEmpty([...input.dependencies], 'Window dependencies');
					if ((input.window.proofOwner === 'local') !== input.window.locallyReproducible) {
						return yield* Effect.fail(new Error('Window proof ownership is inconsistent'));
					}
					if (
						dependencies.length !== input.window.dependencies.length ||
						dependencies.some((dependency) => !input.window.dependencies.includes(dependency))
					) {
						return yield* Effect.fail(
							new Error('Installed dependencies differ from the confirmed canonical window')
						);
					}
					const generationKeys = Object.keys(input.dependencyGenerations).toSorted();
					const sortedDependencies = [...dependencies].toSorted();
					if (
						generationKeys.length !== sortedDependencies.length ||
						generationKeys.some((collection, index) => collection !== sortedDependencies[index])
					) {
						return yield* Effect.fail(
							new Error('Window generations must exactly cover the confirmed dependencies')
						);
					}
					const incomingIds = uniqueNonEmpty([...input.orderedRowIds], 'Window row ids');
					const baseRowKeys = new Set<string>();
					for (const row of input.baseRows) {
						const key = `${row.collection}\u0000${row.recordId}`;
						if (baseRowKeys.has(key)) {
							return yield* Effect.fail(
								new Error('Window hydration repeats one authoritative base row')
							);
						}
						baseRowKeys.add(key);
					}
					const relationships = input.relationshipRefs ?? [];
					if (relationships.length > MAX_REPLICA_WINDOW_RELATIONSHIPS) {
						return yield* Effect.fail(
							new Error('Window relationship membership exceeds the durable cap')
						);
					}
					const relationshipKeys = new Set<string>();
					for (const relationship of relationships) {
						const parts = [
							relationship.sourceCollection,
							relationship.sourceRecordId,
							relationship.relation,
							relationship.targetCollection,
							relationship.targetRecordId
						];
						if (parts.some((part) => part.length === 0)) {
							return yield* Effect.fail(new Error('Window relationship edge is empty'));
						}
						const key = parts.join('\u0000');
						if (relationshipKeys.has(key)) {
							return yield* Effect.fail(new Error('Window relationship edge is repeated'));
						}
						relationshipKeys.add(key);
					}
					if (input.serverResult !== undefined && input.window.proofOwner !== 'server') {
						return yield* Effect.fail(
							new Error('Only a ServerProof window may retain a server result')
						);
					}
					if (
						input.serverResult !== undefined &&
						serverResultOf(input.serverResult) === undefined
					) {
						return yield* Effect.fail(new Error('Server query result descriptor is invalid'));
					}
					if (
						!Number.isSafeInteger(input.lookaheadCount) ||
						input.lookaheadCount < 0 ||
						input.lookaheadCount > incomingIds.length ||
						input.lookaheadCount > MAX_REPLICA_WINDOW_LOOKAHEAD_ROWS
					)
						return yield* Effect.fail(new Error('Window lookahead count is invalid'));
					const existing = yield* readStoredWindow(database, input.window.queryKey);
					const append = input.continuation !== null;
					if (append && (input.serverResult !== undefined || existing?.server_result != null)) {
						return yield* Effect.fail(new Error('An aggregate server result cannot be extended'));
					}
					if (append && existing === undefined) {
						return yield* Effect.fail(
							new Error('A continuation cannot create a window without its prefix')
						);
					}
					if (
						existing !== undefined &&
						stableStringify(jsonValue(existing.canonical_query)) !==
							stableStringify(input.window.canonical)
					)
						return yield* Effect.fail(
							new Error('Query key is already bound to a different canonical query')
						);
					const priorIds =
						existing === undefined
							? []
							: (yield* database.query<{ readonly record_id: string }>(
									`select record_id from bolt_replica_window_row
					 where query_key = $1 order by ordinal asc`,
									[input.window.queryKey]
								)).rows.map(({ record_id }) => record_id);
					const preservesTail =
						existing !== undefined &&
						!append &&
						input.serverResult === undefined &&
						existing.server_result == null &&
						input.nextCursor !== null &&
						incomingIds.length < priorIds.length;
					const incomingSet = new Set(incomingIds);
					const retainedTail = preservesTail
						? priorIds.filter((recordId) => !incomingSet.has(recordId))
						: [];
					const priorSet = new Set(priorIds);
					const extension = append
						? incomingIds.filter((recordId) => !priorSet.has(recordId))
						: incomingIds;
					const orderedRowIds = append
						? [...priorIds, ...extension]
						: [...incomingIds, ...retainedTail];
					const retained = new Set(orderedRowIds);
					if (orderedRowIds.length > MAX_REPLICA_WINDOW_ROWS) {
						return yield* Effect.fail(new Error('Window membership exceeds the durable cap'));
					}
					const preservesRelationships = append || retainedTail.length > 0;
					const priorRelationships = !preservesRelationships
						? []
						: (yield* database.query<CollectionRelationshipMembership>(
								`select source_collection as "sourceCollection", source_record_id as "sourceRecordId",
					 relation, target_collection as "targetCollection", target_record_id as "targetRecordId"
					 from bolt_replica_window_relationship where query_key = $1`,
								[input.window.queryKey]
							)).rows;
					const storedRelationshipKeys = new Set<string>();
					const storedRelationships = [...priorRelationships, ...relationships].filter(
						(relationship) => {
							const key = [
								relationship.sourceCollection,
								relationship.sourceRecordId,
								relationship.relation,
								relationship.targetCollection,
								relationship.targetRecordId
							].join('\u0000');
							if (storedRelationshipKeys.has(key)) return false;
							storedRelationshipKeys.add(key);
							return true;
						}
					);
					if (storedRelationships.length > MAX_REPLICA_WINDOW_RELATIONSHIPS) {
						return yield* Effect.fail(
							new Error('Window relationship membership exceeds the durable cap')
						);
					}
					if (input.serverResult?.kind === 'findGrouped') {
						const groupedIds = Object.values(input.serverResult.groups).flat();
						if (
							groupedIds.length !== orderedRowIds.length ||
							new Set(groupedIds).size !== groupedIds.length ||
							groupedIds.some((id) => !retained.has(id))
						) {
							return yield* Effect.fail(
								new Error('Grouped server result is not an exact partition of retained root rows')
							);
						}
					}
					if (input.serverResult?.kind === 'count' && orderedRowIds.length > 0) {
						return yield* Effect.fail(new Error('A retained count cannot carry row membership'));
					}
					const currentPosition = yield* readReplicaPosition(database);
					if (compareSyncCursors(input.readCursor, currentPosition.cursor) > 0) {
						const storedWindows = yield* database.query<{
							readonly query_key: string;
							readonly dependencies: unknown;
						}>('select query_key, dependencies from bolt_replica_window');
						const dependencySet = new Set(dependencies);
						const quarantined = storedWindows.rows.flatMap((stored) =>
							stringsOf(stored.dependencies).some((dependency) => dependencySet.has(dependency))
								? [stored.query_key]
								: []
						);
						if (quarantined.length > 0) {
							yield* database.query(
								`update bolt_replica_window set valid = false, dirty = false
						 where query_key = any($1::text[])`,
								[quarantined]
							);
						}
					}
					for (const row of input.baseRows) {
						yield* store.applyAuthoritativeRow({ ...row, cursor: input.readCursor });
					}
					for (const recordId of incomingIds) {
						if (!(yield* store.hasRecord(input.window.collection, recordId))) {
							return yield* Effect.fail(
								new Error('Window membership names a missing authoritative base row')
							);
						}
					}
					for (const relationship of relationships) {
						if (
							!(yield* store.hasRecord(
								relationship.sourceCollection,
								relationship.sourceRecordId
							)) ||
							!(yield* store.hasRecord(relationship.targetCollection, relationship.targetRecordId))
						) {
							return yield* Effect.fail(
								new Error('Window relationship names a missing authoritative base row')
							);
						}
					}
					const proofCurrent =
						proofGenerationsCurrent(
							dependencies,
							input.dependencyGenerations,
							currentPosition.generations
						) && compareSyncCursors(input.readCursor, currentPosition.cursor) <= 0;
					const prefixConfirmed =
						!append ||
						(existing?.proof_confirmed === true &&
							proofGenerationsCurrent(
								dependencies,
								generationsOf(existing.dependency_generations),
								input.dependencyGenerations
							));
					const boundaryCovered =
						(input.nextCursor === null || input.lookaheadCount > 0) &&
						retainedTail.length === 0 &&
						prefixConfirmed;
					const leaseRows = yield* database.query<{ readonly lease_count: number | string }>(
						`select count(*)::integer as lease_count from bolt_replica_window_lease
				 where query_key = $1`,
						[input.window.queryKey]
					);
					const leaseCount = Number(leaseRows.rows[0]?.lease_count ?? 0);
					const bytes =
						stableStringify(input.window.canonical).length +
						orderedRowIds.reduce((total, id) => total + id.length, 0) +
						stableStringify(storedRelationships).length +
						(input.serverResult === undefined ? 0 : stableStringify(input.serverResult).length);
					yield* database.query(
						`insert into bolt_replica_window
				 (query_key, collection, canonical_query, dependencies, proof_owner,
				  locally_reproducible, valid, dirty, read_xid, read_sequence,
				  dependency_generations, server_result, next_cursor, row_count, lookahead_count,
				  lease_count, expires_at, bytes, proof_confirmed, last_access)
				 values ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, false, $8, $9,
				  $10::jsonb, $11::jsonb, $12, $13, $14, $15,
				  case when $15 > 0 then null else current_timestamp + ($17 * interval '1 millisecond') end,
				  $16, $18, current_timestamp)
				 on conflict (query_key) do update set
				 collection = excluded.collection, canonical_query = excluded.canonical_query,
				 dependencies = excluded.dependencies, proof_owner = excluded.proof_owner,
				 locally_reproducible = excluded.locally_reproducible,
				 proof_confirmed = excluded.proof_confirmed,
				 valid = excluded.valid, dirty = false, read_xid = excluded.read_xid,
				 read_sequence = excluded.read_sequence,
				 dependency_generations = excluded.dependency_generations,
				 server_result = excluded.server_result,
				 next_cursor = excluded.next_cursor, row_count = excluded.row_count,
				 lookahead_count = excluded.lookahead_count, expires_at = excluded.expires_at,
				 bytes = excluded.bytes,
				 last_access = excluded.last_access`,
						[
							input.window.queryKey,
							input.window.collection,
							JSON.stringify(input.window.canonical),
							JSON.stringify(dependencies),
							input.window.proofOwner,
							input.window.locallyReproducible,
							(input.valid ?? true) && proofCurrent && boundaryCovered,
							input.readCursor.xid,
							input.readCursor.sequence,
							JSON.stringify(input.dependencyGenerations),
							input.serverResult === undefined ? null : JSON.stringify(input.serverResult),
							input.nextCursor,
							orderedRowIds.length,
							input.lookaheadCount,
							leaseCount,
							bytes,
							INACTIVE_WINDOW_TTL_MILLIS,
							(input.valid ?? true) && boundaryCovered
						]
					);
					if (!append) {
						yield* database.query('delete from bolt_replica_window_row where query_key = $1', [
							input.window.queryKey
						]);
						yield* insertWindowMembership(
							database,
							input.window.queryKey,
							input.window.collection,
							orderedRowIds
						);
					} else {
						yield* insertWindowMembership(
							database,
							input.window.queryKey,
							input.window.collection,
							extension,
							priorIds.length
						);
					}
					if (!preservesRelationships) {
						yield* database.query(
							'delete from bolt_replica_window_relationship where query_key = $1',
							[input.window.queryKey]
						);
					}
					yield* insertWindowRelationships(database, input.window.queryKey, relationships);
					if (input.bufferedDeltas !== undefined) {
						yield* applyBatch(
							input.bufferedDeltas,
							input.window.proofOwner === 'local'
								? { queryKey: input.window.queryKey, stagingCollections: dependencies }
								: undefined
						);
					}
					const installed = yield* readProof(input.window.queryKey);
					if (installed === undefined)
						return yield* Effect.fail(new Error('Installed window is unreadable'));
					return installed;
				})
			),
		applyDeltaBatch: (input) => transaction(applyBatch(input)),
		invalidateDependencies: (collections, generations) =>
			transaction(invalidate(collections, generations)),
		dirtyDependencies: (collections) => transaction(dirtyOverlayDependencies(collections)),
		recomputeWindow: (input) =>
			transaction(
				Effect.gen(function* () {
					const stored = yield* readStoredWindow(database, input.queryKey);
					if (
						stored === undefined ||
						!stored.locally_reproducible ||
						stored.proof_owner !== 'local' ||
						!stored.dirty ||
						!validCursor(input.readCursor) ||
						!validGenerationMap(input.dependencyGenerations)
					)
						return false;
					const dependencies = stringsOf(stored.dependencies).toSorted();
					const generationKeys = Object.keys(input.dependencyGenerations).toSorted();
					if (
						generationKeys.length !== dependencies.length ||
						generationKeys.some((collection, index) => collection !== dependencies[index])
					)
						return false;
					const ids = uniqueNonEmpty([...input.orderedRowIds], 'Recomputed window row ids');
					if (
						ids.length > MAX_REPLICA_WINDOW_ROWS ||
						!Number.isSafeInteger(input.lookaheadCount) ||
						input.lookaheadCount < 0 ||
						input.lookaheadCount > Math.min(ids.length, MAX_REPLICA_WINDOW_LOOKAHEAD_ROWS)
					)
						return false;
					const optimisticRowIds = new Set(
						uniqueNonEmpty([...(input.optimisticRowIds ?? [])], 'Optimistic window row ids')
					);
					for (const id of ids) {
						if (!optimisticRowIds.has(id) && !(yield* store.hasRecord(stored.collection, id))) {
							return false;
						}
					}
					const position = yield* readReplicaPosition(database);
					const current =
						compareSyncCursors(input.readCursor, position.cursor) === 0 &&
						proofGenerationsCurrent(
							dependencies,
							input.dependencyGenerations,
							position.generations
						);
					const valid = current && input.boundaryCovered;
					yield* database.query('delete from bolt_replica_window_row where query_key = $1', [
						input.queryKey
					]);
					yield* insertWindowMembership(database, input.queryKey, stored.collection, ids);
					yield* database.query(
						`update bolt_replica_window set valid = $2, dirty = false,
					 proof_confirmed = $9,
					 read_xid = $3, read_sequence = $4,
					 dependency_generations = $5::jsonb,
					 row_count = $6::bigint, lookahead_count = $7::bigint,
					 next_cursor = $8,
					 bytes = greatest(0::bigint, bytes - row_count * 36::bigint)
						+ $6::bigint * 36::bigint,
					 last_access = current_timestamp
					 where query_key = $1`,
						[
							input.queryKey,
							valid,
							input.readCursor.xid,
							input.readCursor.sequence,
							JSON.stringify(input.dependencyGenerations),
							ids.length,
							input.lookaheadCount,
							input.nextCursor,
							input.boundaryCovered
						]
					);
					return valid;
				})
			),
		acquireWindowLease: (queryKey, ownerId) =>
			ownerId.length === 0
				? Effect.fail(new Error('Replica window lease owner cannot be empty'))
				: transaction(
						database
							.query<{ readonly query_key: string }>(
								`with acquired as (
							insert into bolt_replica_window_lease (query_key, owner_id)
							select $1, $2 where exists (
								select 1 from bolt_replica_window where query_key = $1
							)
							on conflict do nothing returning query_key
							), counted as (
								select (
									count(*) + (select count(*) from acquired)
								)::integer as lease_count
								from bolt_replica_window_lease where query_key = $1
						)
						update bolt_replica_window
						set lease_count = counted.lease_count,
							expires_at = null,
							last_access = current_timestamp
						from counted
						where query_key = $1 and exists (select 1 from acquired)
						returning query_key`,
								[queryKey, ownerId]
							)
							.pipe(Effect.map(({ rows }) => rows.length > 0))
					),
		releaseWindowLease: (queryKey, ownerId) =>
			ownerId.length === 0
				? Effect.fail(new Error('Replica window lease owner cannot be empty'))
				: transaction(
						database
							.query<{ readonly query_key: string }>(
								`with released as (
							delete from bolt_replica_window_lease
							where query_key = $1 and owner_id = $2
							returning query_key
							), counted as (
								select greatest(
									0::bigint, count(*) - (select count(*) from released)
								)::integer as lease_count
								from bolt_replica_window_lease where query_key = $1
						)
						update bolt_replica_window
						set lease_count = counted.lease_count,
							expires_at = case when counted.lease_count > 0 then null
								else current_timestamp + ($3 * interval '1 millisecond') end,
							last_access = current_timestamp
						from counted
						where query_key = $1 and exists (select 1 from released)
						returning query_key`,
								[queryKey, ownerId, INACTIVE_WINDOW_TTL_MILLIS]
							)
							.pipe(Effect.map(({ rows }) => rows.length > 0))
					),
		releaseWindow: (queryKey, protectedRows) =>
			transaction(
				Effect.gen(function* () {
					// Replica sessions disable FK cascade triggers. Remove the reconstructible children
					// explicitly before their window or they keep base rows artificially reachable.
					yield* database.query('delete from bolt_replica_window_lease where query_key = $1', [
						queryKey
					]);
					yield* database.query(
						'delete from bolt_replica_window_relationship where query_key = $1',
						[queryKey]
					);
					yield* database.query('delete from bolt_replica_window_row where query_key = $1', [
						queryKey
					]);
					const deleted = yield* database.query<{ readonly query_key: string }>(
						'delete from bolt_replica_window where query_key = $1 returning query_key',
						[queryKey]
					);
					if (deleted.rows.length === 0) return 0;
					return yield* prune(protectedRows);
				})
			),
		expireInactiveWindows: (protectedRows) =>
			transaction(
				Effect.gen(function* () {
					const candidates = yield* database.query<{ readonly query_key: string }>(
						`select query_key from bolt_replica_window
				 where lease_count = 0 and expires_at <= current_timestamp`
					);
					const queryKeys = candidates.rows.map(({ query_key }) => query_key);
					if (queryKeys.length === 0) return [];
					yield* database.query(
						'delete from bolt_replica_window_lease where query_key = any($1::text[])',
						[queryKeys]
					);
					yield* database.query(
						'delete from bolt_replica_window_relationship where query_key = any($1::text[])',
						[queryKeys]
					);
					yield* database.query(
						'delete from bolt_replica_window_row where query_key = any($1::text[])',
						[queryKeys]
					);
					const expired = yield* database.query<{ readonly query_key: string }>(
						`delete from bolt_replica_window where query_key = any($1::text[])
				 and lease_count = 0 and expires_at <= current_timestamp returning query_key`,
						[queryKeys]
					);
					if (expired.rows.length > 0) yield* prune(protectedRows);
					return expired.rows.map(({ query_key }) => query_key);
				})
			),
		pruneBaseRows: (protectedRows) => transaction(prune(protectedRows)),
		listWindows: () =>
			database
				.query<{
					readonly query_key: string;
					readonly collection: string;
					readonly valid: boolean;
					readonly dirty: boolean;
					readonly lease_count: number | string;
					readonly bytes: number | string;
					readonly last_access: Date | string;
				}>(
					`select query_key, collection, valid, dirty, lease_count, bytes, last_access
			 from bolt_replica_window`
				)
				.pipe(
					Effect.map(({ rows }) =>
						rows.map((row) => ({
							id: row.query_key,
							collection: row.collection,
							kind: 'window' as const,
							valid: row.valid,
							dirty: row.dirty,
							leaseCount: Number(row.lease_count),
							bytes: Number(row.bytes),
							lastAccess:
								row.last_access instanceof Date
									? row.last_access.getTime()
									: new Date(row.last_access).getTime()
						}))
					)
				),
		dependencies: () =>
			database
				.query<{ readonly dependencies: unknown }>(
					'select dependencies from bolt_replica_window where lease_count > 0'
				)
				.pipe(
					Effect.map(({ rows }) => [
						...new Set(rows.flatMap(({ dependencies }) => stringsOf(dependencies)))
					])
				),
		position: () => readReplicaPosition(database),
		recordPosition: (position) =>
			transaction(
				Effect.gen(function* () {
					if (!validCursor(position.cursor) || !validGenerationMap(position.generations)) {
						return yield* Effect.fail(new Error('Invalid durable replica position'));
					}
					const current = yield* readReplicaPosition(database);
					if (compareSyncCursors(position.cursor, current.cursor) < 0) {
						return yield* Effect.fail(
							new ReplicaHeadMovedBackwards(current.cursor, position.cursor)
						);
					}
					const recorded = {
						cursor: position.cursor,
						generations: mergeGenerations(current.generations, position.generations)
					};
					yield* writeReplicaPosition(database, recorded);
					yield* refreshConfirmedProofs(recorded);
					return recorded;
				})
			),
		rebuildNamespace: () => transaction(store.clearNamespace())
	};
});
