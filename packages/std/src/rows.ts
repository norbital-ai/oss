/** Indexes rows by their IDs. The last row with a given ID wins. */
export function by_id<R extends { readonly id: string }>(rows: Iterable<R>): Map<R['id'], R> {
	const indexed = new Map<R['id'], R>();
	for (const row of rows) indexed.set(row.id, row);
	return indexed;
}

/** Keeps non-nullish values in their original order. */
export function present<A>(values: Iterable<A>): NonNullable<A>[] {
	const result: NonNullable<A>[] = [];
	for (const value of values) if (value !== undefined && value !== null) result.push(value);
	return result;
}
