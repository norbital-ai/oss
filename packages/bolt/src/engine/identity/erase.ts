// Erasure (rule 38e, §5.13). What identity owns: the build's erasable-field set and the admission of a collection erase
// (admin-only, never routed to approval, `locked` rules).
// The remove/anonymise statement of a tenant collection is the write compiler's generated delete/update without a
// transform (38e(d)); it consults `judgeErase` first.
import { Array as EffectArray, Predicate } from 'effect';
import type { Json } from '../../decl/values.ts';
import type { Authority, RowData } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import { catalogOf } from '../access/pred.ts';
import { checkOf } from '@norbital-ai/store'; // hook:write

const LOGIC = new Set(['and', 'or', 'not']);
/** Field names a `Where`-shaped literal reads (own fields only; relation arms are not own fields). */
function whereFields(w: unknown, out: Set<string>): void {
	if (EffectArray.isArray(w)) for (const x of w) whereFields(x, out);
	else if (Predicate.isObject(w))
		for (const [k, v] of Object.entries(w)) {
			if (LOGIC.has(k)) whereFields(v, out);
			else {
				out.add(k);
				if (Predicate.isObject(v))
					for (const o of Object.values(v))
						if (Predicate.isObject(o) && typeof o.field === 'string') out.add(o.field);
			}
		}
}
export function exprFields(e: unknown, out: Set<string>): void {
	// hook:write — erase purges computed readers (38e(b))
	if (EffectArray.isArray(e)) for (const x of e) exprFields(x, out);
	else if (Predicate.isObject(e)) {
		if (typeof e.field === 'string' && Object.keys(e).length === 1) out.add(e.field);
		else for (const v of Object.values(e)) exprFields(v, out);
	}
}

/**
 * 38e(d)3: a model's stored authored fields that are not a relationship key, a `state`, a `key`, `unique` or
 * `noOverlap` field, and are read by no `check`, no roll-up (its summed field or its `where`), and no `computed` field
 * that one of those reads. `bolt check` prints this set.
 */
export function erasableFields(m: EngineManifest, model: string): string[] {
	const spec = m.models[model];
	if (spec === undefined) return [];
	const fixed = new Set<string>(spec.key ?? []);
	for (const u of spec.unique ?? []) for (const f of u.fields) fixed.add(f);
	for (const o of spec.noOverlap ?? []) {
		for (const f of o.key) fixed.add(f);
		fixed.add(o.period);
	}
	const read = new Set<string>();
	for (const c of Object.values(spec.check ?? {})) whereFields(checkOf(c).where, read); // hook:write
	// roll-ups elsewhere that read this model's rows: `sum.of = '<rel>.<field>'` and `count.of = '<rel>'` on a parent
	for (const [parent, p] of Object.entries(m.models))
		for (const k of Object.values(p.fields)) {
			if (k.kind !== 'sum' && k.kind !== 'count') continue;
			const [rel, summed] = k.of.split('.') as [string, string?];
			if (catalogOf(m).models.get(parent)?.many.get(rel)?.child !== model) continue;
			if (summed !== undefined) read.add(summed);
			whereFields(k.where, read);
		}
	for (let grew = true; grew;) {
		// a computed field read by any of those pulls in what it reads
		grew = false;
		for (const [name, c] of Object.entries(spec.computed ?? {})) {
			if (!read.has(name)) continue;
			const before = read.size;
			exprFields(c.expr, read);
			grew ||= read.size > before;
		}
	}
	return Object.entries(spec.fields)
		.filter(
			([name, k]) =>
				!['seq', 'sum', 'count', 'state'].includes(k.kind) &&
				k.unique !== true &&
				!fixed.has(name) &&
				!read.has(name) &&
				m.relationships[`${model}.${name}`] === undefined
		)
		.map(([name]) => name);
}

type EraseRequest =
	{ mode: 'remove' } | { mode: 'anonymise'; set: { readonly [field: string]: Json } };
/**
 * Admission of `<c>.erase` on stored rows (38e(d)): admin-only; remove refuses `locked` under a state whose `edit` is not `'all'`; anonymise writes stored authored
 * fields only, and on a row whose state's `edit` does not admit a field, only erasable ones.
 */
export function judgeErase(
	m: EngineManifest,
	auth: Authority,
	collection: string,
	rows: readonly RowData[],
	req: EraseRequest
): { ok: true } | { ok: false; code: 'forbidden' | 'locked' | 'invalidInput'; message: string } {
	if (!auth.admin)
		return { ok: false, code: 'forbidden', message: 'Only an administrator can erase.' };
	const spec = m.models[collection];
	if (spec === undefined)
		return { ok: false, code: 'invalidInput', message: `No collection '${collection}'.` };
	const states = Object.entries(spec.fields).flatMap(([f, k]) =>
		k.kind === 'state' ? [[f, k.states] as const] : []
	);
	const editOf = (r: RowData) => states.map(([f, st]) => st[String(r[f])]?.edit ?? 'all');
	if (req.mode === 'remove') {
		return rows.some((r) => editOf(r).some((e) => e !== 'all'))
			? { ok: false, code: 'locked', message: 'A locked record can be anonymised, not removed.' }
			: { ok: true };
	}
	const names = Object.keys(req.set);
	const stored = names.find((f) => {
		const k = spec.fields[f];
		return k === undefined || ['seq', 'sum', 'count'].includes(k.kind);
	});
	if (stored !== undefined)
		return {
			ok: false,
			code: 'invalidInput',
			message: `'${stored}' is not a stored authored field.`
		};
	const erasable = new Set(erasableFields(m, collection));
	for (const r of rows)
		for (const e of editOf(r)) {
			if (e === 'all') continue;
			const bad = names.find((f) => !erasable.has(f) && (e === 'none' || !e.includes(f)));
			if (bad !== undefined)
				return { ok: false, code: 'locked', message: `'${bad}' is fixed on a locked record.` };
		}
	return { ok: true };
}
