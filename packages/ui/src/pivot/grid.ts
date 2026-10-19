import { formatValue as show } from '../kinds/kind.js';
import type { Values } from '../collection/types.js';
import { flat } from '../read/aggregate.js';
export type PivotValue<F extends string = string> = { sum: F } | { count: true };
const valueKey = (v: PivotValue) => ('sum' in v ? `sum.${v.sum}` : 'count');
/** An aggregate over `by: [rows, cols?]` as a grid with row and column totals. */
export function pivotGrid(
	agg: readonly Values[],
	rows: string,
	cols: string | undefined,
	value: PivotValue
) {
	const k = valueKey(value),
		cells = new Map<string, number>();
	const rowKeys: string[] = [],
		colKeys: string[] = [];
	for (const r of agg.map(flat)) {
		const rk = show(r[rows] ?? null),
			ck = cols === undefined ? '' : show(r[cols] ?? null);
		if (!rowKeys.includes(rk)) rowKeys.push(rk);
		if (!colKeys.includes(ck)) colKeys.push(ck);
		cells.set(`${rk}|${ck}`, (cells.get(`${rk}|${ck}`) ?? 0) + Number(String(r[k] ?? 0)));
	}
	const at = (r: string, c: string) => cells.get(`${r}|${c}`) ?? 0;
	const rowTotal = (r: string) => colKeys.reduce((s, c) => s + at(r, c), 0);
	const colTotal = (c: string) => rowKeys.reduce((s, r) => s + at(r, c), 0);
	return {
		rowKeys,
		colKeys,
		at,
		rowTotal,
		colTotal,
		total: rowKeys.reduce((s, r) => s + rowTotal(r), 0)
	};
}
