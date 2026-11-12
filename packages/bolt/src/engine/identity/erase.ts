// Erasure. What identity owns: the build's erasable-field set and the admission of a model erase
// (admin-only, never routed to approval, `locked` rules).
// The remove/anonymise statement of a tenant model is the write compiler's generated delete/update without a
// transform (38e(d)); it consults `judgeErase` first.
import { Array as EffectArray, Effect, Predicate } from 'effect';
import type { BoltError } from '../../protocol/errors.ts';
import type { Json } from '../../decl/values.ts';
import type { Authority, Bindings, RowData } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import { evaluate } from '../query/eval.ts';
import { catalog_of, toPred } from '../access/pred.ts';
import { check_of } from '@norbital-ai/store'; // hook:write

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
 * 38e(d)3: a model's stored authored fields that are not a relationship key, a `state`, a `key`, a `unique` or
 * `no_overlap` field, and are read by no `check`, no roll-up (its summed field or its `where`), and no `computed` field
 * that one of those reads. `bolt check` prints this set.
 */
export function erasableFields(m: EngineManifest, model: string): string[] {
	const spec = m.models[model];
	if (spec === undefined) return [];
	const fixed = new Set<string>(spec.key ?? []);
	for (const u of spec.unique ?? []) for (const f of u.fields) fixed.add(f);
	for (const o of spec.no_overlap ?? []) {
		for (const f of o.key) fixed.add(f);
		fixed.add(o.period);
	}
	const read = new Set<string>();
	for (const rule of Object.values(spec.locks ?? {})) whereFields(rule.where, read);
	for (const c of Object.values(spec.check ?? {})) whereFields(check_of(c).where, read); // hook:write
	// roll-ups elsewhere that read this model's rows: `sum.of = '<rel>.<field>'` and `count.of = '<rel>'` on a parent
	for (const [parent, p] of Object.entries(m.models))
		for (const k of Object.values(p.fields)) {
			if (k.kind !== 'sum' && k.kind !== 'count') continue;
			const [rel = '', summed] = k.of.split('.');
			if (catalog_of(m).models.get(parent)?.many.get(rel)?.child !== model) continue;
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
				!fixed.has(name) &&
				!read.has(name) &&
				m.relationships[`${model}.${name}`] === undefined
		)
		.map(([name]) => name);
}

type EraseRequest =
	{ mode: 'remove' } | { mode: 'anonymise'; set: { readonly [field: string]: Json } };
/**
 * Admission of erasure on stored rows. Removal respects every lock, and anonymisation changes excepted or erasable fields.
 */
export const judgeErase = Effect.fnUntraced(function* (
	m: EngineManifest,
	auth: Authority,
	model: string,
	rows: readonly RowData[],
	req: EraseRequest,
	bindings: Bindings
): Effect.fn.Return<
	{ ok: true } | { ok: false; code: 'forbidden' | 'locked' | 'invalid_input'; message: string },
	BoltError
> {
	if (!auth.admin)
		return { ok: false, code: 'forbidden', message: 'Only an administrator can erase.' };
	const spec = m.models[model];
	if (spec === undefined)
		return { ok: false, code: 'invalid_input', message: `No model '${model}'.` };
	const cat = catalog_of(m);
	const rules = yield* Effect.forEach(Object.values(spec.locks ?? {}), (rule) =>
		Effect.map(toPred(m, model, rule.where), (where) => ({ where, except: rule.except }))
	);
	const locked = (row: RowData) => rules.filter((rule) => evaluate({ cat, bindings }, model, rule.where, row));
	if (req.mode === 'remove')
		return rows.some((row) => locked(row).length > 0)
			? { ok: false, code: 'locked', message: 'A locked record can only be anonymised.' }
			: { ok: true };
	const names = Object.keys(req.set);
	const stored = names.find((f) => {
		const k = spec.fields[f];
		return k === undefined || ['seq', 'sum', 'count'].includes(k.kind);
	});
	if (stored !== undefined)
		return {
			ok: false,
			code: 'invalid_input',
			message: `'${stored}' is not a stored authored field.`
		};
	const erasable = new Set(erasableFields(m, model));
	for (const row of rows)
		for (const rule of locked(row)) {
			const bad = names.find((field) => !erasable.has(field) && !rule.except?.includes(field));
			if (bad !== undefined)
				return { ok: false, code: 'locked', message: `'${bad}' is fixed on a locked record.` };
		}
	return { ok: true };
});
