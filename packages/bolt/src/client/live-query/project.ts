import {
	MAX_SYNC_LOADED_KEYS,
	mutationGraphDeleteIds,
	mutationGraphWriteRows,
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

const applyWriteRow = (
	rows: StoredRecord[],
	indexes: Map<string, number>,
	values: StoredRecord
): void => {
	const recordId = recordIdOf(values);
	if (recordId === undefined) return;
	const index = indexes.get(recordId);
	if (index === undefined) {
		rows.push({ ...values });
		indexes.set(recordId, rows.length - 1);
		return;
	}
	rows[index] = { ...rows[index], ...values };
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

		switch (graph.action) {
			case 'delete': {
				const removeIds = new Set(mutationGraphDeleteIds(graph));
				if (removeIds.size === 0) continue;
				const kept = rows.filter((row) => {
					const id = recordIdOf(row);
					return id === undefined || !removeIds.has(id);
				});
				if (kept.length === rows.length) continue;
				rows.splice(0, rows.length, ...kept);
				indexes.clear();
				for (let next = 0; next < rows.length; next += 1) {
					const shiftedId = recordIdOf(rows[next] as StoredRecord);
					if (shiftedId !== undefined) indexes.set(shiftedId, next);
				}
				break;
			}
			case 'create':
			case 'update':
			case 'mutate': {
				for (const row of mutationGraphWriteRows(graph)) applyWriteRow(rows, indexes, row.values);
				break;
			}
			default: {
				const _exhaustive: never = graph;
				throw new Error(`unhandled mutation action: ${JSON.stringify(_exhaustive)}`);
			}
		}
	}

	return rows;
};
