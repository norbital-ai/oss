import { Schema } from 'effect';

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

/** Stable JSON bytes for identities and fingerprints that must ignore object insertion order. */
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
