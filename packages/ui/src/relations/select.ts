import { formatValue as show } from '../kinds/kind.js';
import type { CollectionExposure } from '../kinds/context.js';
import type { Json } from '@norbital-ai/std/wire';
import type { Row, Values } from '../collection/types.js';
import { isRow } from '../read/results.js';
/** `select` as a read's select object (final-ui 29b: the cell fields and the axes, never the whole row). */
export const selectOf = (fields: readonly string[]): Json =>
	Object.fromEntries([...new Set(fields)].map((f) => [f, true]));
const HEAVY = new Set(['json', 'custom', 'file']);
/** A list read leaves out json, custom and file fields (X-33): naming one reads the exposed fields, the relations and every named field. */
export function heavySelect(
	exposure: CollectionExposure | undefined,
	named: readonly string[]
): Json | undefined {
	const fields = exposure?.fields ?? {};
	const heavy = (f: string) => HEAVY.has(fields[f]?.kind ?? '');
	return named.some(heavy)
		? selectOf([
				...Object.keys(fields).filter((f) => !f.includes('.') && !heavy(f)),
				...Object.keys(exposure?.relations ?? {}),
				...named
			])
		: undefined;
}
type Catalog = { readonly [collection: string]: CollectionExposure } | undefined;
/** A many-relation's child: the collection whose one-relation names `rel` as its inverse onto `of`. */
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
 * A list read's select: `heavySelect`, and each relation in `refs` has its target's label read in the same statement
 * (no read per row, rule 12): a one-relation as a nested row, a named many-relation as its first `MANY_SHOWN + 1` rows,
 * or every row when `all` (an export).
 */
export function listSelect(
	cat: Catalog,
	of: string,
	named: readonly string[],
	refs = named,
	all = false
): Json | undefined {
	const many = (f: string) => manyTarget(cat, of, f) !== undefined;
	const arms = Object.fromEntries([
		...refs.flatMap((fk) => {
			const l = refLabel(cat, of, fk);
			return l.length > 0 && !many(fk) ? [[fk, { select: selectOf(l) }]] : [];
		}),
		...named.filter(many).map((m) => [
			m,
			{
				select: selectOf(refLabel(cat, of, m)),
				...(all ? { all: true } : { limit: MANY_SHOWN + 1 })
			}
		])
	]);
	const own = named.filter((f) => !many(f));
	if (Object.keys(arms).length === 0) return heavySelect(cat?.[of], own);
	const x = cat?.[of];
	if (x === undefined) return undefined;
	return {
		...Object.fromEntries(
			[
				...Object.keys(x.fields).filter(
					(field) => !field.includes('.') && !HEAVY.has(x.fields[field]?.kind ?? '')
				),
				...Object.keys(x.relations ?? {}),
				...own
			].map((field) => [field, true])
		),
		...arms
	};
}
/** A relation cell's link: the target collection and its label text; a many-relation also lists each record (`more`: past `MANY_SHOWN`). */
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
