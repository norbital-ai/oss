import {
	MAX_SYNC_LOADED_KEYS,
	type CollectionMutationGraph,
	type StoredRecord,
	type SyncPrefixDelta
} from '@norbital-ai/bolt-protocol';

export type PendingProjectionWrite = Readonly<{
	readonly graph: CollectionMutationGraph;
}>;

const recordIdOf = (row: StoredRecord): string | undefined => {
	const id = row['id'];
	return typeof id === 'string' && id.length > 0 ? id : undefined;
};

const graphRecordId = (graph: CollectionMutationGraph): string | undefined => {
	if (graph.action === 'delete') return graph.id;
	const id = graph.values['id'];
	return typeof id === 'string' && id.length > 0 ? id : undefined;
};

const requireUniqueRecordIds = (rows: ReadonlyArray<StoredRecord>, label: string): string[] => {
	const ids = rows.map((row) => {
		const id = recordIdOf(row);
		if (id === undefined) throw new Error(`${label} contains a row without a stable id`);
		return id;
	});
	if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate row ids`);
	return ids;
};

export const applyPrefixDelta = (
	rows: ReadonlyArray<StoredRecord>,
	delta: SyncPrefixDelta
): ReadonlyArray<StoredRecord> => {
	const held = new Set(requireUniqueRecordIds(rows, 'Sync prefix'));
	const removeIds = new Set(delta.removeIds);
	if (removeIds.size !== delta.removeIds.length)
		throw new Error('Sync prefix delta removes one id more than once');
	for (const id of removeIds)
		if (!held.has(id)) throw new Error('Sync prefix delta removes an id outside its base');

	const putIds = new Set<string>();
	for (const put of delta.put) {
		if (putIds.has(put.id)) throw new Error('Sync prefix delta puts one id more than once');
		putIds.add(put.id);
		if (recordIdOf(put.row) !== put.id)
			throw new Error('Sync prefix delta put does not match its row id');
	}

	const displaced = new Set([...removeIds, ...putIds]);
	const next = rows.filter((row) => !displaced.has(recordIdOf(row) ?? ''));
	const finalLength = next.length + delta.put.length;
	if (finalLength > MAX_SYNC_LOADED_KEYS)
		throw new Error('Sync prefix delta exceeds the loaded-key ceiling');
	const indexes = new Set<number>();
	for (const put of delta.put) {
		if (!Number.isInteger(put.index) || put.index < 0 || put.index >= finalLength)
			throw new Error('Sync prefix delta contains an invalid final index');
		if (indexes.has(put.index))
			throw new Error('Sync prefix delta contains the same final index more than once');
		indexes.add(put.index);
	}
	for (const put of [...delta.put].sort((left, right) => left.index - right.index))
		next.splice(put.index, 0, put.row);
	requireUniqueRecordIds(next, 'Applied sync prefix');
	return next;
};

export const project = (
	answer: ReadonlyArray<StoredRecord>,
	pendingWrites: Iterable<PendingProjectionWrite>,
	collection?: string
): ReadonlyArray<StoredRecord> => {
	const rows = [...answer];
	const indexes = new Map<string, number>();
	for (let index = 0; index < rows.length; index += 1) {
		const id = recordIdOf(rows[index] as StoredRecord);
		if (id !== undefined) indexes.set(id, index);
	}

	for (const { graph } of pendingWrites) {
		if (collection !== undefined && graph.collection !== collection) continue;
		const recordId = graphRecordId(graph);
		if (recordId === undefined) continue;
		const index = indexes.get(recordId);
		if (index === undefined) continue;

		if (graph.action === 'delete') {
			rows.splice(index, 1);
			indexes.delete(recordId);
			for (let shifted = index; shifted < rows.length; shifted += 1) {
				const shiftedId = recordIdOf(rows[shifted] as StoredRecord);
				if (shiftedId !== undefined) indexes.set(shiftedId, shifted);
			}
			continue;
		}

		rows[index] = { ...rows[index], ...graph.values };
	}

	return rows;
};
