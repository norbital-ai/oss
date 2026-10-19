import { formatValue as show } from '../kinds/kind.js';
import type { Fields, Kind } from '../kinds/kind.js';
import type { CollectionExposure } from '../kinds/context.js';
import type { Row, Values } from '../collection/types.js';
import type { ViewBolt } from '../client/contract.js';
import { fill, humanize, msg } from '../text/messages.js';
import { objectsOf, rowsOf } from '../read/results.js';
import { valueAt } from '../cell/value.js';
export type TableState = { after: string | null; q: string };
/** Cursor and search from the URL (`?<key>.after=…`, final-ui rule 8). */
export const readTableState = (params: URLSearchParams, key: string): TableState => ({
	after: params.get(`${key}.after`),
	q: params.get(`${key}.q`) ?? ''
});
export function writeTableState(
	params: URLSearchParams,
	key: string,
	s: TableState
): URLSearchParams {
	const out = new URLSearchParams(params);
	const put = (k: string, v: string | null) =>
		v === null || v === '' ? out.delete(`${key}.${k}`) : out.set(`${key}.${k}`, v);
	put('after', s.after);
	put('q', s.q);
	return out;
}
/** L-BOLT-495: `/semantic <text>` reads the search box by meaning (rule 16), fused with the lexical match. */
export const SEMANTIC_SEARCH = /^\/semantic(\s+|$)/;
/**
 * The toolbar's `/<name>` search indexes: `semantic` over `search.semantic` (text, sent as `/semantic <text>`), then each
 * named similarity the viewer reads and each named query it holds, taking its typed `input`. `why` says why the box cannot
 * run one: an input a person never types (a raw vector, a derived kind), or a view that cannot show ranked rows (`typed` false).
 */
export type SearchIndex = {
	name: string;
	hint: string;
	via?: 'similar' | 'query';
	input?: Fields;
	why: string | null;
};
export function searchIndexes(
	x: CollectionExposure | undefined,
	typed: boolean,
	text: { meaning: string; raw: string; view: string }
): SearchIndex[] {
	const untypable = (k: Kind): boolean =>
		['seq', 'sum', 'count', 'vector', 'state'].includes(k.kind) ||
		(k.kind === 'list' && k.of.kind === 'number');
	const named = (
		via: 'similar' | 'query',
		of: { readonly [n: string]: { input: Fields; description: string } } = {}
	): SearchIndex[] =>
		Object.entries(of).map(([name, s]) => {
			const raw = Object.entries(s.input).find(([, k]) => untypable(k))?.[0];
			return {
				name,
				hint: s.description,
				via,
				input: s.input,
				why:
					raw !== undefined
						? fill(text.raw, { field: s.input[raw]?.label ?? humanize(raw) })
						: typed
							? null
							: text.view
			};
		});
	return [
		...(x?.semantic === true ? [{ name: 'semantic', hint: text.meaning, why: null }] : []),
		...named('similar', x?.similarity),
		...named('query', x?.queries)
	];
}
/** A `/` the box holds with no index chosen yet: the picker's text, never a search term. */
export const SLASH = /^\/\S*$/;
/**
 * The rows a `/<query>` index answers, in its order: a query whose output is a list of objects naming `collection` by an
 * `id` field returns those ids (the view reads the rows); any other output is taken as the rows themselves.
 */
export function queryIds(
	out: unknown,
	output: Kind | undefined,
	collection: string
): { ids: string[] } | { rows: readonly Row[] } {
	const item =
		output?.kind === 'list' && output.of.kind === 'object' ? output.of.fields : undefined;
	const key = Object.entries(item ?? {}).find(
		([, k]) => k.kind === 'id' && k.of === collection
	)?.[0];
	if (key === undefined) return { rows: rowsOf(out) };
	return {
		ids: [
			...new Set(
				objectsOf(out)
					.map((r) => r[key])
					.filter((v): v is string => typeof v === 'string')
			)
		]
	};
}
/** A local array's search over its columns (PH GAP-15: client-side). */
export const searchRows = <R extends Values>(
	rows: readonly R[],
	q: string,
	fields: readonly string[]
): readonly R[] => {
	const t = q.trim().toLowerCase();
	return t === ''
		? rows
		: rows.filter((r) => fields.some((f) => show(valueAt(r, f)).toLowerCase().includes(t)));
};
/** "rows 26–50 of 312" (final-ui rule 7); the count may still be loading. */
export function rangeText(
	bolt: Pick<ViewBolt, 't'>,
	offset: number,
	shown: number,
	count: number | null
): string {
	const from = shown === 0 ? 0 : offset + 1,
		to = offset + shown;
	if (shown === 0 && offset === 0) return msg(bolt, 'table.none', 'No rows');
	// the count is re-read at most every 30 s (rule 7): a live page ahead of it shows the rows it has, not a stale total
	return count === null || count < to
		? msg(bolt, 'table.range', 'rows {from}–{to}', { from, to })
		: msg(bolt, 'table.rangeOf', 'rows {from}–{to} of {count}', { from, to, count });
}
