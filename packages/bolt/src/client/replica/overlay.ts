import type { Schema } from 'effect';

/** A row named by an optimistic mutation. This is also the unit protected from replica eviction. */
export type OverlayRowReference = Readonly<{
	readonly collection: string;
	readonly recordId: string;
}>;

/**
 * An overlay is deliberately a row operation, not a second copy of the replica table.
 *
 * `merge` preserves fields omitted by an update. `replace` is used for a locally-created row whose
 * complete locally-known value is the mutation graph. Neither operation is ever written into the
 * authoritative base store.
 */
export type MutationOverlayOperation = Readonly<
	| {
			readonly kind: 'merge' | 'replace';
			readonly row: OverlayRowReference;
			readonly values: Readonly<Record<string, Schema.Json>>;
	  }
	| {
			readonly kind: 'remove';
			readonly row: OverlayRowReference;
	  }
>;

/** One full permitted row from O3. Overlay projection treats this input as immutable. */
export type AuthoritativeBaseRow = Readonly<{
	readonly partitionKey: string;
	readonly collection: string;
	readonly recordId: string;
	readonly rowVersion: number;
	readonly row: Readonly<Record<string, Schema.Json>>;
}>;

/** The small journal surface needed to project O3 through O4 without coupling to persistence. */
export type OverlayMutation = Readonly<{
	/** Physical server partition originally proving this write; retained for transport, not view scope. */
	readonly partitionKey: string;
	/** Stable credential-free actor/authority binding that owns this overlay across M3. */
	readonly localActorBinding: string;
	readonly issuedAtEpochMs: number;
	readonly idempotencyKey: string;
	readonly deviceSequence: number;
	readonly active: boolean;
	readonly operations: ReadonlyArray<MutationOverlayOperation>;
}>;

export type OverlayProjectionScope = Readonly<{
	/** Current authoritative O3 partition. Base rows from any other physical proof are ignored. */
	readonly serverPartitionKey: string;
	/** Stable local owner. Old physical journals for this same actor remain applicable after M3. */
	readonly localActorBinding: string;
	/** Collection currently being evaluated; required even when its authoritative base is empty. */
	readonly collection: string;
}>;

export type BaseThroughOverlay = Readonly<{
	/** Materialized read view. It is derived data and must never be persisted as authoritative base. */
	readonly rows: ReadonlyMap<string, Readonly<Record<string, Schema.Json>>>;
	/** Every row a pending or quarantined journal entry keeps safe from eviction. */
	readonly protectedRows: ReadonlySet<string>;
}>;

const nonEmpty = (label: string, value: string): string => {
	const normalized = value.trim();
	if (normalized.length === 0) throw new Error(`Mutation overlay ${label} cannot be empty`);
	return normalized;
};

/** Collision-free local key for `(collection, record id)`. */
export const overlayRowKey = (row: OverlayRowReference): string => {
	const collection = nonEmpty('collection', row.collection);
	const recordId = nonEmpty('record id', row.recordId);
	return `${collection.length.toString(36)}.${collection}${recordId.length.toString(36)}.${recordId}`;
};

export const overlayReferences = (
	operations: ReadonlyArray<MutationOverlayOperation>
): ReadonlyArray<OverlayRowReference> => {
	const references = new Map<string, OverlayRowReference>();
	for (const operation of operations) references.set(overlayRowKey(operation.row), operation.row);
	return [...references.values()];
};

/**
 * Replays device-ordered optimistic operations over a snapshot of authoritative rows.
 *
 * The input rows are copied before the first operation. A delta writer can therefore update O3 in
 * parallel and ask for a fresh projection later; this function has no route back into O3.
 * Authoritative rows remain scoped to the current physical partition. Optimistic entries instead
 * follow the stable actor binding, so an M3 partition change cannot make durable local work vanish.
 */
export const deriveBaseThroughOverlay = (
	scope: OverlayProjectionScope,
	baseRows: Iterable<AuthoritativeBaseRow>,
	mutations: Iterable<OverlayMutation>
): BaseThroughOverlay => {
	const serverPartitionKey = nonEmpty('server partition', scope.serverPartitionKey);
	const localActorBinding = nonEmpty('local actor binding', scope.localActorBinding);
	const collection = nonEmpty('collection', scope.collection);
	const rows = new Map<string, Readonly<Record<string, Schema.Json>>>();
	for (const base of baseRows) {
		if (base.partitionKey !== serverPartitionKey || base.collection !== collection) continue;
		rows.set(overlayRowKey(base), { ...base.row });
	}

	const protectedRows = new Set<string>();
	const ordered = [...mutations]
		.filter((mutation) => mutation.localActorBinding === localActorBinding)
		.toSorted(
			(left, right) =>
				left.issuedAtEpochMs - right.issuedAtEpochMs ||
				left.deviceSequence - right.deviceSequence ||
				left.idempotencyKey.localeCompare(right.idempotencyKey)
		);
	for (const mutation of ordered) {
		for (const operation of mutation.operations) {
			const key = overlayRowKey(operation.row);
			protectedRows.add(key);
			if (operation.row.collection !== collection) continue;
			if (!mutation.active) continue;
			if (operation.kind === 'remove') {
				rows.delete(key);
				continue;
			}
			const current = rows.get(key);
			if (operation.kind === 'merge' && current === undefined) continue;
			rows.set(
				key,
				operation.kind === 'merge' ? { ...current, ...operation.values } : { ...operation.values }
			);
		}
	}

	return { rows, protectedRows };
};
