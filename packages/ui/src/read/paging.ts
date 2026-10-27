import type { Query } from '../client/contract.js';
import { Effect } from 'effect';
import { observeOnce } from '../effect/index.js';
import { pageOf } from './request.js';
import { isRow } from './results.js';
import { mapped, type Reading } from './state.js';
/** The rows a later page reads to stay live (every page up to it); past this a later page is read once. */
const LIVE_PAGE_ROWS = 1_000;
/**
 * A view's page read (rule 7). A cursor page is not liveable, so page `index` (0-based) stays live as one live read of
 * every row up to it (no cursor), sliced to its own rows; its `next` cursor is the one after its last row. Past
 * `LIVE_PAGE_ROWS`, or with a cursor restored without its index (`index` null), the cursor page is read once.
 * ponytail: a live later page re-reads the pages before it; a keyset `where` would read only its own rows.
 */
export function pageRead<T>(
	of: string,
	read: (limit: number, after?: string) => Query<unknown>,
	pageSize: number,
	index: number | null,
	after: string | null | undefined
): Reading<T> {
	// root `of`'s page of the read request's answer
	const page = (value: unknown) => pageOf(value, of) as T;
	if (after === null || after === undefined) return mapped(read(pageSize), page);
	if (index !== null && index > 0 && (index + 1) * pageSize <= LIVE_PAGE_ROWS)
		return mapped(read((index + 1) * pageSize), (answer) => {
			const value = pageOf(answer, of);
			return (
				isRow(value) && Array.isArray(value['rows'])
					? { ...value, rows: value['rows'].slice(index * pageSize) }
					: value
			) as T;
		});
	return observeOnce(() => read(pageSize, after).pipe(Effect.map(page)));
}
/** Rule 7: a count is re-issued at most once every 30 s while the live page reports changes. */
export const COUNT_EVERY_MS = 30_000;
