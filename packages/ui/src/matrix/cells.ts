import type { Row } from '../model/types.js';
import { isRow } from '../read/results.js';
import { valueAt } from '../cell/value.js';
export const cellKey = (
	row: import('@norbital-ai/std/kind').Value,
	col: import('@norbital-ai/std/kind').Value
) => `${String(row)}|${JSON.stringify(col)}`;
/** Items keyed by `<row id>|<column value>`; a relation value is read by its id. */
export function matrixCells(
	items: readonly Row[],
	rowField: string,
	colField: string
): Map<string, Row[]> {
	const id = (
		value: import('@norbital-ai/std/kind').Value | undefined
	): import('@norbital-ai/std/kind').Value =>
		isRow(value) && typeof value['id'] === 'string' ? value['id'] : (value ?? null);
	const out = new Map<string, Row[]>();
	for (const it of items) {
		const k = cellKey(id(it[rowField]), id(valueAt(it, colField)));
		out.set(k, [...(out.get(k) ?? []), it]);
	}
	return out;
}
export const MATRIX_PAGE = 50;
