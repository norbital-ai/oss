import type { CollectionRecordHistoryEntry } from '@norbital-ai/platform-utils/collection';
import { isEqual } from 'es-toolkit/predicate';

export interface CollectionFieldHistoryEntry {
	readonly value: unknown;
	readonly validFrom: string;
	readonly validTo: string | null;
	readonly version: number;
}

export function collectionFieldHistory(
	history: readonly CollectionRecordHistoryEntry[],
	fieldName: string
): readonly CollectionFieldHistoryEntry[] {
	const changes: CollectionFieldHistoryEntry[] = [];
	for (const snapshot of [...history].sort((left, right) => left.version - right.version)) {
		const value = snapshot.values[fieldName];
		const previous = changes.at(-1);
		if (!previous || !isEqual(previous.value, value)) {
			changes.push({
				value,
				validFrom: snapshot.validFrom,
				validTo: snapshot.validTo,
				version: snapshot.version
			});
			continue;
		}
		changes[changes.length - 1] = { ...previous, validTo: snapshot.validTo };
	}
	return changes.reverse();
}
