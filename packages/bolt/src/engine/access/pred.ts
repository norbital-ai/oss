// Grant predicates: a grant's `Where` literal → `Pred` through the query area's normalizer (one K3 decode for reads and
// grants), the little Pred algebra the Authority compiler needs, and the JS judge of pre/post-images.
import type { Json } from '../../decl/values.ts';
import type { Operand } from '../../decl/where.ts';
import { BoltError, type Arg, type EngineManifest, type Pred, type RowData } from '../contracts.ts';
import { likeRegex, startOfDate } from '../query/eval.ts'; // hook:query (startOfDate)
import { catalog, type Catalog } from '../../protocol/catalog.ts';
import { where } from '../../protocol/ir.ts';

export const TRUE: Pred = { t: 'const', value: true };
export const FALSE: Pred = { t: 'const', value: false };
const isTrue = (p: Pred): boolean => p.t === 'const' && p.value;
export const or = (of: readonly Pred[]): Pred => of.some(isTrue) ? TRUE : of.length === 0 ? FALSE : of.length === 1 ? of[0]! : { t: 'or', of };

const catalogs = new WeakMap<EngineManifest, Catalog>();
export function catalogOf(m: EngineManifest): Catalog {
	let cat = catalogs.get(m);
	if (cat === undefined) catalogs.set(m, cat = catalog(m));
	return cat;
}
export const toPred = (m: EngineManifest, model: string, w: unknown): Pred => where(catalogOf(m), model, w);

const UNIT_MS: { readonly [u: string]: number } = { s: 1e3, min: 6e4, h: 36e5, d: 864e5 };
/** A `Duration` literal (`'15min'`, `'7d'`) in milliseconds. */
export function durationMs(d: string): number {
	const m = /^(\d+)(s|min|h|d)$/.exec(d);
	if (m === null) throw new BoltError('invalid', 'decode', `'${d}' is not a duration`);
	return Number(m[1]) * UNIT_MS[m[2]!]!;
}

// ── the JS judge of an image (rule 35) ──
// SQL's three-valued logic over one engine row, masks included (rule 14: a masked field reads as `CASE WHEN <admitting
// grants> THEN f END`, NULL where the caller may not see it). Relation predicates are judged in SQL (`needsSql`).
// ponytail: `query/eval` is the catalog-aware evaluator for live routing; this one needs no catalog, which the write
// path's pre/post-image judgments use. Fold them together when A4's `not` semantics settle.
/** What operands resolve against. */
export type Env = {
	now: string; today: string; params: { readonly [name: string]: Json };
	actor: (operand: Extract<Operand, { actor: unknown }>['actor']) => Json;
	masks?: { readonly [field: string]: Pred };
};
type Tri = boolean | null;
type Obj = { readonly [k: string]: unknown };
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Unwraps tagged wire values (`$dec`, `$t`, `$d`); numbers stay numbers. */
const plain = (v: Json | undefined): Json => {
	if (isObj(v)) { const keys = Object.keys(v); if (keys.length === 1 && keys[0]!.startsWith('$')) return v[keys[0]!] as Json; }
	return v ?? null;
};
// ponytail: decimals compare as JS numbers (15 significant digits); money past that needs the SQL judge.
const NUM = /^-?\d+(\.\d+)?$/;
const order = (a: Json, b: Json): number | null => {
	if (a === null || b === null || typeof a === 'object' || typeof b === 'object') return null;
	if (typeof a === 'number' || typeof b === 'number' || NUM.test(String(a)) && NUM.test(String(b))) {
		const na = Number(a), nb = Number(b);
		return na === nb ? 0 : na < nb ? -1 : 1;
	}
	return a === b ? 0 : a < b ? -1 : 1;
};
const shift = (at: string, offset: string): number => offset === '' ? Date.parse(at) : Date.parse(at) + (offset[0] === '-' ? -1 : 1) * durationMs(offset.slice(1));
function resolve(a: Arg, row: RowData, env: Env): Json {
	if ('lit' in a) return plain(a.lit);
	if ('field' in a) return read(a.field, row, env);
	if ('param' in a) return plain(env.params[a.param]);
	if ('now' in a) return new Date(shift(env.now, a.now)).toISOString();
	if ('today' in a) return new Date(shift(`${env.today}T00:00:00Z`, a.today)).toISOString().slice(0, 10);
	if ('startOf' in a) return startOfDate(a, env.today); // hook:query — ponytail: the date form; an instant compares by its day
	return env.actor(a.actor);
}
function read(field: string, row: RowData, env: Env): Json {
	const mask = env.masks?.[field];
	if (mask !== undefined) {
		const { masks: _, ...bare } = env;
		if (holds3(mask, row, bare) !== true) return null;
	}
	return plain(row[field]);
}
/** SQL's answer for one row: `null` is unknown, which a filter treats as false. */
export function holds3(p: Pred, row: RowData, env: Env): Tri {
	switch (p.t) {
		case 'const': return p.value;
		case 'and': { let r: Tri = true; for (const q of p.of) { const v = holds3(q, row, env); if (v === false) return false; if (v === null) r = null; } return r; }
		case 'or': { let r: Tri = false; for (const q of p.of) { const v = holds3(q, row, env); if (v === true) return true; if (v === null) r = null; } return r; }
		case 'not': { const v = holds3(p.of, row, env); return v === null ? null : !v; }
		case 'null': return (read(p.field, row, env) === null) === p.is;
		case 'cmp': {
			const a = read(p.field, row, env), b = resolve(p.arg, row, env);
			if (a === null || b === null) return null;
			const c = order(a, b);
			if (c === null) { const same = JSON.stringify(a) === JSON.stringify(b); return p.op === 'eq' ? same : p.op === 'ne' ? !same : null; }
			return { eq: c === 0, ne: c !== 0, lt: c < 0, lte: c <= 0, gt: c > 0, gte: c >= 0 }[p.op];
		}
		case 'in': {
			const v = read(p.field, row, env);
			if (v === null) return null;
			const list = Array.isArray(p.args) ? p.args as readonly Json[] : resolve(p.args as Operand, row, env);
			const hit = Array.isArray(list) && list.some((x) => order(v, plain(x)) === 0);
			return p.negated ? !hit : hit;
		}
		case 'like': {
			const v = read(p.field, row, env);
			return v === null ? null : likeRegex(p.pattern).test(String(v));
		}
		case 'list': {
			const v = read(p.field, row, env);
			if (v === null) return null;
			const xs = v as readonly Json[], want = Array.isArray(p.arg) ? p.arg as readonly Json[] : [p.arg];
			if (p.op === 'isEmpty') return (xs.length === 0) === (p.arg === true);
			return p.op === 'hasAll' ? want.every((w) => xs.includes(w)) : want.some((w) => xs.includes(w));
		}
		default: throw new BoltError('needsSql', 'admission', `a '${p.t}' predicate is judged in SQL`);
	}
}
export const holds = (p: Pred, row: RowData, env: Env): boolean => holds3(p, row, env) === true;
