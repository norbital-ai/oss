import type { Schema } from 'effect';
import type { SyncQueryInput } from '@norbital-ai/bolt-protocol';
import { canonicalJson } from '../../canonical-json.js';
import { isObjectLike as isRecordOrArray } from '../../schema-decode.js';

/**
 * Stable live-query key over the single `canonicalJson` encoder.
 *
 * `canonicalJson` owns sorted-keys encoding; this wrapper preserves only the `orderBy` object key
 * order, where insertion order carries sort priority and sorting would change the query identity.
 * All other objects and all leaves encode exactly as `canonicalJson`.
 */
const encode = (value: unknown, preserveObjectOrder = false): string => {
	if (Array.isArray(value)) return `[${value.map((entry) => encode(entry)).join(',')}]`;
	if (!isRecordOrArray(value)) return canonicalJson(value);

	const entries = Object.entries(value);
	if (!preserveObjectOrder) {
		entries.sort(([left], [right]) => left.localeCompare(right));
	}
	return `{${entries
		.map(
			([key, entry]) =>
				`${JSON.stringify(key)}:${encode(entry, key === 'orderBy' && !Array.isArray(entry))}`
		)
		.join(',')}}`;
};

export const stableKey = (input: SyncQueryInput | Schema.Json): string => encode(input);
