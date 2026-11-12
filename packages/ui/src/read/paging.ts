import type { Query, QueryAnswer } from '../client/contract.js';
import { Effect } from 'effect';
import { observe_once } from '../effect/index.js';
import type { Page } from '../model/types.js';
import { page_of } from './request.js';
import { mapped, type Reading } from './state.js';
/** The rows a later page reads to stay live (every page up to it); past this a later page is read once. */
const LIVE_PAGE_ROWS = 1_000;
/**
 * A view's page read. A cursor page is not liveable, so page `index` (0-based) stays live as one live read of
 * every row up to it (no cursor), sliced to its own rows; its `next` cursor is the one after its last row. Past
 * `LIVE_PAGE_ROWS`, or with a cursor restored without its index (`index` null), the cursor page is read once.
 * ponytail: a live later page re-reads the pages before it; a keyset `where` would read only its own rows.
 */
export function pageRead<R>(
	of: string,
	read: (limit: number, after?: string) => Query<QueryAnswer<R>>,
	page_size: number,
	index: number | null,
	after: string | null | undefined
): Reading<Page<R>> {
	// root `of`'s page of the read request's answer
	const page = (answer: QueryAnswer<R>) => page_of(answer, of);
	if (after === null || after === undefined) return mapped(read(page_size), page);
	if (index !== null && index > 0 && (index + 1) * page_size <= LIVE_PAGE_ROWS)
		return mapped(read((index + 1) * page_size), (answer) => {
			const value = page_of(answer, of);
			return value && { ...value, rows: value.rows.slice(index * page_size) };
		});
	return observe_once(() => read(page_size, after).pipe(Effect.map(page)));
}
