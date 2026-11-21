import { Predicate } from 'effect';
import { format_value as show } from '../kinds/kind.js';
import { flat } from '../read/aggregate.js';
import type { SourceRows } from '../read/source.js';

const numeric = (raw: unknown): number | null => {
	if (raw === null || raw === undefined) return null;
	const value =
		Predicate.isObject(raw) && 'amount' in raw ? Number(String(raw.amount)) : Number(String(raw));
	return Number.isFinite(value) ? value : null;
};

/** Chart data: rows (read, query or aggregate) as flat records, `x` as text, each `y` a number. */
export function series(
	v: SourceRows,
	x: string,
	y: readonly string[]
): { [k: string]: string | number | null }[] {
	return ('rows' in v ? v.rows : v).map(flat).map((r) => ({
		[x]: show(r[x] ?? null),
		...Object.fromEntries(y.map((k) => [k, numeric(r[k])]))
	}));
}
