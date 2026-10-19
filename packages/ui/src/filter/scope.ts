import type { Json } from '@norbital-ai/std/wire';
import { isRow } from '../read/results.js';
/** `and` of the author's scope and the viewer's clauses; the viewer never widens the author's `where` (final-ui rule 6). */
export function and(...parts: readonly (Json | undefined)[]): Json | undefined {
	const list = parts.filter(
		(p): p is Json => p !== undefined && p !== null && !(isRow(p) && Object.keys(p).length === 0)
	);
	return list.length === 0 ? undefined : list.length === 1 ? list[0] : { and: list };
}
/** Drops `undefined` members, so an options literal is `Json`. */
export const compact = (o: { readonly [k: string]: Json | undefined }): Json =>
	Object.fromEntries(Object.entries(o).filter((e): e is [string, Json] => e[1] !== undefined));
