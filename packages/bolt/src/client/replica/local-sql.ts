import type { SyncChange } from '../../runtime/sync/sync.js';

/**
 * The replica's local projection.
 *
 * A browser replica is a reconstructible client cache, never authority — so this deliberately keeps
 * rows as decoded records keyed by collection and id, exactly as the outbox delivers them, rather
 * than mirroring the server's SQL schema. That keeps `apply` total: a change for a collection the
 * client has never seen creates its table on the spot, which is what a freshly granted policy looks
 * like from here.
 */

export type ReplicaRow = Readonly<Record<string, unknown>>;

export type ReplicaSnapshot = ReadonlyMap<string, ReadonlyMap<string, ReplicaRow>>;

export type LocalStore = Readonly<{
	readonly apply: (changes: ReadonlyArray<SyncChange>) => Promise<void>;
	readonly reset: () => Promise<void>;
	readonly rows: (collection: string) => ReadonlyArray<ReplicaRow>;
	readonly row: (collection: string, id: string) => ReplicaRow | undefined;
	readonly snapshot: () => ReplicaSnapshot;
	readonly collections: () => ReadonlyArray<string>;
}>;

const asRecord = (value: unknown): ReplicaRow | undefined =>
	value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ReplicaRow) : undefined;

/** Builds an in-memory local store. One per runtime; it holds no cross-tab state. */
export const createLocalStore = (): LocalStore => {
	const tables = new Map<string, Map<string, ReplicaRow>>();
	const tableFor = (collection: string): Map<string, ReplicaRow> => {
		const existing = tables.get(collection);
		if (existing !== undefined) return existing;
		const created = new Map<string, ReplicaRow>();
		tables.set(collection, created);
		return created;
	};

	return {
		apply: async (changes) => {
			for (const change of changes) {
				if (change.operation === 'reset') {
					tables.clear();
					continue;
				}
				const table = tableFor(change.collection);
				if (change.operation === 'delete') {
					table.delete(change.recordId);
					continue;
				}
				const record = asRecord(change.record);
				if (record === undefined) continue;
				const identified = { ...record, norbital_id: change.recordId };
				// An update carries the columns that changed, not the whole row, so it merges onto
				// whatever the replica already holds instead of replacing it with a partial record.
				table.set(
					change.recordId,
					change.operation === 'create' ? identified : { ...(table.get(change.recordId) ?? {}), ...identified }
				);
			}
		},
		reset: async () => {
			tables.clear();
		},
		rows: (collection) => [...(tables.get(collection)?.values() ?? [])],
		row: (collection, id) => tables.get(collection)?.get(id),
		snapshot: () => new Map([...tables].map(([name, table]) => [name, new Map(table)])),
		collections: () => [...tables.keys()].toSorted()
	};
};
