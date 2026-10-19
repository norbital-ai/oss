import { formatValue as show } from '../kinds/kind.js';
import { objectsOf } from '../read/results.js';
import { flat } from '../read/aggregate.js';
/** Chart data: rows (read, query or aggregate) as flat records, `x` as text, each `y` a number. */
export function series(
	v: unknown,
	x: string,
	y: readonly string[]
): { [k: string]: string | number | null }[] {
	return objectsOf(v)
		.map(flat)
		.map((r) => ({
			[x]: show(r[x] ?? null),
			...Object.fromEntries(
				y.map((k) => [k, r[k] === null || r[k] === undefined ? null : Number(String(r[k]))])
			)
		}));
}
