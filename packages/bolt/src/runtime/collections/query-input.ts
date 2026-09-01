import type {
	NearestQueryInput,
	QueryInput
} from '#lib/runtime/collections/collections.contract.js';

type AuthoredQueryInput = { readonly [field: string]: unknown };

/** Preserves the wire shape accepted by authored collection reads. */
export const queryInput = (collection: string, input: AuthoredQueryInput): QueryInput => ({
	collection,
	...input
});

/** Preserves the runtime defaults for malformed authored vector-read fields. */
export const nearestQueryInput = (
	collection: string,
	input: AuthoredQueryInput
): NearestQueryInput => {
	const { column, probe, metric, ...rest } = input;
	return {
		collection,
		...rest,
		column: typeof column === 'string' ? column : '',
		probe: Array.isArray(probe) ? (probe as ReadonlyArray<number>) : [],
		metric: metric === 'cosine' || metric === 'ip' ? metric : 'l2'
	};
};
