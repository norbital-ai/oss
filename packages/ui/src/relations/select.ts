import { formatValue as show } from '../kinds/kind.js';
import type { ModelExposure } from '../kinds/context.js';
import type { Json } from '@norbital-ai/std/wire';
import type { Row, Values } from '../model/types.js';
import { isRow } from '../read/results.js';
import { READ_LIMIT, type Layer, type Request } from '../read/request.js';
const HEAVY = new Set(['json', 'custom', 'file']);
type Catalog = { readonly [model: string]: ModelExposure } | undefined;
/** A many-relation's child: the model whose one-relation names `rel` as its inverse onto `of`. */
function manyTarget(cat: Catalog, of: string, rel: string): string | undefined {
	if (!(cat?.[of]?.many ?? []).includes(rel)) return undefined;
	return Object.keys(cat ?? {}).find((c) =>
		Object.values(cat?.[c]?.relations ?? {}).some(
			(r) => r.inverse === rel && r.targets.includes(of)
		)
	);
}
/** The fields a relation's target is shown by (RecordShell's rule: the relation's `label`, else the target's declared
 * `label`), those the caller reads; none for an arc or a target outside the catalog. A many-relation shows its child's. */
export function refLabel(cat: Catalog, of: string, rel: string): readonly string[] {
	const one = cat?.[of]?.relations?.[rel];
	const target =
		one === undefined
			? manyTarget(cat, of, rel)
			: one.targets.length === 1
				? one.targets[0]
				: undefined;
	const t = target === undefined ? undefined : cat?.[target];
	return t === undefined
		? []
		: [one?.label ?? t.label].flat().filter((l) => t.fields[l] !== undefined);
}
/** A many-relation cell's labels read with the row: the first `MANY_SHOWN`, one more to know there are more. */
export const MANY_SHOWN = 20;
/**
 * A list read of `of` as one read request: the root's `root` options and its fields (the light ones and the FKs,
 * plus any json, custom or file field `named`, X-33), and each relation
 * in `refs` its root declares as a read layer read with its target's label in the same statement (no read per row,
 * rule 12): a one-relation as a nested row, a named many-relation as its first `MANY_SHOWN + 1` rows, or every row when
 * `all` (an export).
 */
export function listRequest(
	cat: Catalog,
	of: string,
	root: Layer,
	named: readonly string[],
	refs = named,
	all = false
): Request {
	const declared = cat?.[of]?.layers ?? [];
	const many = (f: string) => manyTarget(cat, of, f) !== undefined;
	const layers: { [path: string]: Layer } = Object.fromEntries([
		...refs.flatMap((fk) => {
			const l = refLabel(cat, of, fk);
			return l.length > 0 && !many(fk) && declared.includes(fk)
				? [[`${of}.${fk}`, { fields: l }]]
				: [];
		}),
		...named
			.filter((f) => many(f) && declared.includes(f))
			.map((m) => [
				`${of}.${m}`,
				{ fields: refLabel(cat, of, m), limit: all ? READ_LIMIT : MANY_SHOWN + 1 }
			])
	]);
	const own = named.filter((f) => !many(f));
	const x = cat?.[of];
	// a list names its fields: the light ones and the FKs, plus any heavy one a column names (X-33)
	const fields =
		x === undefined
			? undefined
			: [
					...new Set([
						...Object.keys(x.fields).filter(
							(field) => !field.includes('.') && !HEAVY.has(x.fields[field]?.kind ?? '')
						),
						...Object.keys(x.relations ?? {}),
						...own
					])
				];
	return { [of]: { ...root, ...(fields === undefined ? {} : { fields }) }, ...layers };
}
/** A relation cell's link: the target model and its label text; a many-relation also lists each record (`more`: past `MANY_SHOWN`). */
export type Ref = {
	of: string;
	text: string;
	items?: readonly { id: string; text: string }[];
	more?: true;
};
export type Refs = { readonly [rel: string]: Ref };
/** Rows read by `listSelect` back to their FK ids (a many-relation to its ids, its first `MANY_SHOWN` unless `all`), each target's label beside them in `$refs` (the default cell's link). */
export function unref(
	cat: Catalog,
	of: string,
	refs: readonly string[],
	rows: readonly Row[],
	locale?: string,
	all?: boolean
): readonly Row[];
export function unref(
	cat: Catalog,
	of: string,
	refs: readonly string[],
	rows: readonly Values[],
	locale?: string,
	all?: boolean
): readonly Values[];
export function unref(
	cat: Catalog,
	of: string,
	refs: readonly string[],
	rows: readonly Values[],
	locale = 'en',
	all = false
): readonly Values[] {
	const rels = refs.filter(
		(r) => refLabel(cat, of, r).length > 0 || manyTarget(cat, of, r) !== undefined
	);
	if (rels.length === 0) return rows;
	const text = (rel: string, t: Values) =>
		refLabel(cat, of, rel)
			.map((l) => show(t[l] ?? null, locale))
			.filter(Boolean)
			.join(' · ') || '—';
	return rows.map((r) => {
		const refs: { [rel: string]: Ref } = {};
		const out: { [f: string]: import('@norbital-ai/std/kind').Value } = { ...r };
		for (const rel of rels) {
			const t = r[rel],
				child = manyTarget(cat, of, rel);
			if (child !== undefined) {
				const list = (Array.isArray(t) ? t : []).filter(
					(x): x is Row => isRow(x) && typeof x['id'] === 'string'
				);
				const items = (all ? list : list.slice(0, MANY_SHOWN)).map((x) => ({
					id: x.id,
					text: text(rel, x)
				}));
				out[rel] = items.map((i) => i.id);
				refs[rel] = {
					of: child,
					text: items.map((i) => i.text).join(', '),
					items,
					...(!all && list.length > MANY_SHOWN ? { more: true as const } : {})
				};
				continue;
			}
			// a relation its root reads as no layer keeps its FK id, unlabelled
			if (typeof t === 'string') continue;
			if (!isRow(t) || typeof t['id'] !== 'string') {
				out[rel] = null;
				continue;
			} // ponytail: an unreadable target reads as null, so its FK id is lost
			out[rel] = t['id'];
			const target = cat?.[of]?.relations?.[rel]?.targets[0];
			if (target !== undefined) refs[rel] = { of: target, text: text(rel, t) };
		}
		return { ...out, $refs: refs };
	});
}
export function refOf(row: Values, relation: string): Ref | undefined {
	const value = isRow(row['$refs']) ? row['$refs'][relation] : undefined;
	if (!isRow(value) || typeof value['of'] !== 'string' || typeof value['text'] !== 'string')
		return undefined;
	const items = Array.isArray(value['items'])
		? value['items'].flatMap((item) =>
				isRow(item) && typeof item['id'] === 'string' && typeof item['text'] === 'string'
					? [{ id: item['id'], text: item['text'] }]
					: []
			)
		: undefined;
	return {
		of: value['of'],
		text: value['text'],
		...(items === undefined ? {} : { items }),
		...(value['more'] === true ? { more: true } : {})
	};
}
