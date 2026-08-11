/**
 * The database surface the engine runs against.
 *
 * The build happens in the payroll run's `after` hook, so it holds the post-write capabilities:
 * relational reads plus elevated `mutate`/`delete`. Deriving the type from the hook signature
 * rather than restating it keeps the engine honest — if the platform narrows what an `after` hook
 * may do, this stops compiling instead of failing at run time.
 */

import type { Hooks } from '../$types.js';

type CreateAfterHook = NonNullable<NonNullable<Hooks['create']>['after']>['handler'];

/** Reads plus the elevated `mutate`/`delete` the build needs to write its four result collections. */
export type PayrollApi = Parameters<CreateAfterHook>[0]['api'];

/**
 * Reads only.
 *
 * `create.before`, `create.after` and an export pipeline are each handed a differently-shaped
 * capability set, and only the relational query surface is common to all three. Anything that only
 * reads is typed against this so it can be called from any of them.
 */
export type PayrollReadApi = { readonly db: Pick<PayrollApi['db'], 'query'> };

/** The largest page any single engine query will pull. A run that exceeds it is a run that lies. */
export const PAGE_LIMIT = 20_000;

/**
 * Read accounting, for profiling.
 *
 * Every engine read is an RPC out of the tenant runtime container before it is a query, so the
 * count of reads matters as much as the rows they return. `assertComplete` wraps every one of
 * them, which makes it the one place that sees them all.
 */
const reads: { what: string; rows: number }[] = [];

export function resetReadLog(): void {
	reads.length = 0;
}

export function readLog(): string {
	const total = reads.reduce((sum, read) => sum + read.rows, 0);
	return `${reads.length} reads, ${total.toLocaleString('en')} rows [${reads
		.map((read) => `${read.what}:${read.rows}`)
		.join(' ')}]`;
}

/** Read a page and refuse to continue silently if it was truncated. */
export function assertComplete<T>(rows: readonly T[], what: string): readonly T[] {
	reads.push({ what, rows: rows.length });
	if (rows.length >= PAGE_LIMIT)
		throw new Error(
			`Payroll reached its ${PAGE_LIMIT.toLocaleString('en')}-row ceiling loading ${what}. ` +
				'Split the run rather than trusting a truncated read.'
		);
	return rows;
}

/** Group rows by a derived key, preserving insertion order within each bucket. */
export function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
	const grouped = new Map<K, T[]>();
	for (const row of rows) {
		const value = key(row);
		const bucket = grouped.get(value);
		if (bucket) bucket.push(row);
		else grouped.set(value, [row]);
	}
	return grouped;
}
