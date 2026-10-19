import type { Values } from '../collection/types.js';
import { isRow } from './results.js';
/** An aggregate row flattened: `{ key: { region }, count, sum: { amount } }` → `{ region, count, 'sum.amount' }`, numbers plain. */
export function flat(row: Values): { [k: string]: import('@norbital-ai/std/kind').Value } {
	const out: { [k: string]: import('@norbital-ai/std/kind').Value } = {};
	for (const [k, v] of Object.entries(row)) {
		if (k === 'key' && isRow(v))
			Object.assign(out, Object.fromEntries(Object.entries(v).map(([f, x]) => [f, x])));
		else if (isRow(v) && ['sum', 'avg', 'min', 'max'].includes(k))
			for (const [f, x] of Object.entries(v)) out[`${k}.${f}`] = x;
		else out[k] = v;
	}
	return out;
}
