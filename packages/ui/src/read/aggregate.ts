import { Predicate } from 'effect';
import type { Value } from '@norbital-ai/std/kind';
import type { Values } from '../model/types.js';
/** An aggregate row flattened: `{ key: { region }, count, sum: { amount } }` → `{ region, count, 'sum.amount' }`, numbers plain. */
export function flat(row: Values): { [k: string]: Value } {
	const out: { [k: string]: Value } = {};
	for (const [k, v] of Object.entries(row)) {
		if (k === 'key' && Predicate.isObject(v)) Object.assign(out, v);
		else if (Predicate.isObject(v) && ['sum', 'avg', 'min', 'max'].includes(k))
			for (const [f, x] of Object.entries(v)) out[`${k}.${f}`] = x;
		else out[k] = v;
	}
	return out;
}
