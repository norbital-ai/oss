import type { CollectionMutationGraph, StoredRecord } from '@norbital-ai/bolt-protocol';

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

/**
 * Paints pending writes over rows the authoritative answer already holds.
 *
 * This function never evaluates query membership and never changes row position. A create for a row
 * outside the answer, or an update that would make a row enter it, waits for the authoritative
 * frame. Unchanged rows retain object identity; the returned array itself is always fresh.
 */
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
