import { Stream, type Effect } from 'effect';
import type { Live, Q, ViewBolt } from '../client/contract.js';
import { isRow } from './results.js';
/** The rows a later page reads to stay live (every page up to it); past this a later page is read once. */
const LIVE_PAGE_ROWS = 1_000;
/**
 * A view's page read (rule 64). A cursor page is not liveable, so page `index` (0-based) stays live as one live read of
 * every row up to it (no cursor), sliced to its own rows; its `next` cursor is the one after its last row. Past
 * `LIVE_PAGE_ROWS`, or with a cursor restored without its index (`index` null), the cursor page is read once. A filter
 * on `now`, `today` or a calendar start refreshes every minute unless the author set `every`.
 * ponytail: a live later page re-reads the pages before it; a keyset `where` would read only its own rows.
 */
export function pageRead<T>(
	bolt: Pick<ViewBolt, 'live'>,
	read: (limit: number, after?: string) => Q<T>,
	pageSize: number,
	index: number | null,
	after: string | null | undefined,
	every?: string
): Live<T> {
	const live = (q: Q<T>) => {
		const tick =
			every ?? (/"(now|today|startOf)":/.test(JSON.stringify(q.read)) ? '1min' : undefined);
		return bolt.live(q, tick === undefined ? {} : { every: tick });
	};
	if (after === null || after === undefined) return live(read(pageSize));
	if (index !== null && index > 0 && (index + 1) * pageSize <= LIVE_PAGE_ROWS) {
		const all = live(read((index + 1) * pageSize));
		return all.pipe(
			Stream.map((value) =>
				isRow(value) && Array.isArray(value['rows'])
					? ({ ...value, rows: value['rows'].slice(index * pageSize) } as T)
					: value
			)
		);
	}
	return once(read(pageSize, after));
}
/** A read that is not liveable (a cursor page, a similarity search), as a `Live` that answers once. */
export const once = <T, E>(read: Effect.Effect<T, E>): Stream.Stream<T, E> =>
	Stream.fromEffect(read);
/** Rule 7: a count is re-issued at most once every 30 s while the live page reports changes. */
export const COUNT_EVERY_MS = 30_000;
