import type { Schema } from 'effect';
import type { SyncQueryInput } from '@norbital-ai/bolt-protocol';

const encode = (value: unknown, preserveObjectOrder = false): string => {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((entry) => encode(entry)).join(',')}]`;

	const entries = Object.entries(value);
	if (!preserveObjectOrder) {
		entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	}
	return `{${entries
		.map(
			([key, entry]) =>
				`${JSON.stringify(key)}:${encode(entry, key === 'orderBy' && !Array.isArray(entry))}`
		)
		.join(',')}}`;
};

export const stableKey = (input: SyncQueryInput | Schema.Json): string => encode(input);
