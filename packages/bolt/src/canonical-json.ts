import { isRecord } from './schema-decode.js';

/**
 * Single stable encoder for identities and fingerprints that must ignore object insertion order.
 * `stableKey` wraps this for live-query keys, preserving only `orderBy` object order.
 */
export const canonicalJson = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (isRecord(value)) {
		return `{${Object.entries(value)
			.toSorted(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
};
