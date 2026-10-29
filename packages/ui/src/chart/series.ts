import { formatValue as show } from '../kinds/kind.js';
import { flat } from '../read/aggregate.js';
import type { SourceRows } from '../read/source.js';
/** Chart data: rows (read, query or aggregate) as flat records, `x` as text, each `y` a number. */
export function series(
	v: SourceRows,
	x: string,
	y: readonly string[]
): { [k: string]: string | number | null }[] {
	return ('rows' in v ? v.rows : v).map(flat).map((r) => ({
		[x]: show(r[x] ?? null),
		...Object.fromEntries(
			y.map((k) => [k, r[k] === null || r[k] === undefined ? null : Number(String(r[k]))])
		)
	}));
}
