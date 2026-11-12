// Readable sort fields and total-order keys in author and URL forms.
import type { ModelExposure } from '../kinds/context.js';
import { type Catalog, filterable } from './catalog.js';
import { sortable as kindSortable } from '../kinds/registry.js';
import { type Json, isPoint } from '../kinds/kind.js';
import { jsonObject } from './node.js';

/** A sort key; `near` orders by distance from that point, nearest first (a point field). */
export type SortKey = { field: string; dir: 'asc' | 'desc'; near?: { lat: number; lng: number } };

/** One `OrderBy` key object: `{ field: dir }`, or through a one-relation `{ account: { name: dir } }`. */
type SortObject = { readonly [field: string]: 'asc' | 'desc' | SortObject };

/** An `OrderBy` literal: a field, a key object, or up to 4 of them. */
export type OrderBy = string | SortObject | readonly (string | SortObject)[];

// ── sorting ──
/** `Sortable<C>`: readable, ordered fields and `created_at`/`updated_at`; with the catalog, also each
 * one-relation's target fields the viewer reads (`account.name`, shown "Account › Name"), one hop. */
export function sortable(x: ModelExposure | undefined, system = true, cat?: Catalog): string[] {
	if (x === undefined) return [];
	const own = Object.keys(x.fields).filter(
		(f) => filterable(x, f) && x.fields[f] !== undefined && kindSortable(x.fields[f])
	);
	const related =
		cat === undefined
			? []
			: Object.entries(x.relations ?? {}).flatMap(([r, rel]) => {
					const t = rel.targets.length === 1 ? cat[rel.targets[0] ?? ''] : undefined;
					return t === undefined
						? []
						: sortable(t, false)
								.filter((f) => t.relations?.[f] === undefined)
								.map((f) => `${r}.${f}`);
				});
	return [
		...own,
		...(system && x.audit !== false
			? ['created_at', 'updated_at'].filter((f) => !own.includes(f))
			: []),
		...related
	];
}

export const ORDER_MAX_KEYS = 4;

export const orderText = (keys: readonly SortKey[]) =>
	keys
		.map((k) =>
			k.near === undefined ? `${k.field}:${k.dir}` : `${k.field}:near(${k.near.lat} ${k.near.lng})`
		)
		.join(',');

/** `field:asc,field:desc` → keys; each junk key is dropped (and counted). */
export function parseOrder(
	text: string,
	allowed: readonly string[] | null
): { keys: SortKey[]; dropped: number } {
	const keys: SortKey[] = [];
	let dropped = 0;
	for (const part of text.split(',').filter(Boolean)) {
		const m =
			/^(\w+(?:\.\w+){0,2}):(?:(asc|desc)|near\((-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)\))$/.exec(part);
		// a nearest-first key names a point, never in the sortable list: the decode holds it to a point the viewer reads
		const near = m?.[3] === undefined ? undefined : { lat: Number(m[3]), lng: Number(m[4]) };
		if (
			m === null ||
			(near === undefined && allowed !== null && !allowed.includes(m[1] ?? '')) ||
			keys.some((k) => k.field === m[1]) ||
			keys.length >= ORDER_MAX_KEYS
		)
			dropped++;
		else
			keys.push(
				near === undefined
					? { field: m[1] ?? '', dir: m[2] === 'desc' ? 'desc' : 'asc' }
					: { field: m[1] ?? '', dir: 'asc', near }
			);
	}
	return { keys, dropped };
}

/** An `OrderBy` literal as keys (an AI answer or the author's); a related key `{ account: { name: 'asc' } }` is `account.name`. */
export function orderKeys(o: Json | undefined): SortKey[] {
	const items = o === undefined || o === null ? [] : Array.isArray(o) ? o : [o];
	const flat = (value: Json, at: string): SortKey[] => {
		if (typeof value === 'string')
			return value === 'asc' || value === 'desc' ? [{ field: at, dir: value }] : [];
		if (!jsonObject(value)) return [];
		const near = value['near'];
		if (Object.keys(value).length === 1 && near !== undefined && isPoint(near))
			return [{ field: at, dir: 'asc', near }];
		return Object.entries(value).flatMap(([key, nested]) => flat(nested, `${at}.${key}`));
	};
	return items.flatMap((x): SortKey[] =>
		typeof x === 'string'
			? [{ field: x, dir: 'asc' }]
			: jsonObject(x)
				? Object.entries(x).flatMap(([k, v]) => flat(v, k))
				: []
	);
}

/** Keys as an `OrderBy`: a path nests (`account.name` → `{ account: { name: dir } }`). */
export const orderOf = (keys: readonly SortKey[]): Json =>
	keys.map((k) =>
		k.field
			.split('.')
			.reduceRight<Json>((v, f) => ({ [f]: v }), k.near === undefined ? k.dir : { near: k.near })
	);
