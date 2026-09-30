// Typed read literals → the query IR (A4, K3). This is decode: an unknown key or operator is `invalid` here, never a
// silently ignored filter (§3.3.9). Field names are checked against the model; exposure is the compiler's (it knows
// who reads). Shared by the engine and the browser client (`decodeView`), so it lives outside `engine/` (L-BOLT-1000).
import type { Arg, Bucket, Cmp, Order, PageIR, Pred, ReadIR, RelSelectIR, SelectIR } from '../engine/contracts.ts';
import { BoltError, LIMITS } from '../engine/contracts.ts';
import type { Json } from '../decl/values.ts';
import type { Operand } from '../decl/where.ts';
import { ORDER_MAX_KEYS, WHERE_MAX_DEPTH, WHERE_MAX_LIST } from '../decl/where.ts';
import type { Catalog, FieldInfo, ModelInfo } from './catalog.ts';
import { SEMANTIC, SYSTEM_COLUMNS, collectionOf, family } from './catalog.ts';

type Obj = { readonly [k: string]: unknown };
const invalid = (message: string) => new BoltError('invalid', 'decode', message);
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const OPERAND_KEYS = ['field', 'param', 'now', 'today', 'actor', 'startOf'];
export const isOperand = (v: unknown): v is Operand => {
	if (!isObj(v)) return false;
	const ks = Object.keys(v);
	return 'startOf' in v ? ks.every((k) => k === 'startOf' || k === 'shift') : ks.length === 1 && OPERAND_KEYS.includes(ks[0]!);
};
const CMP: readonly string[] = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'];
const ORDERED = new Set(['int', 'decimal', 'money', 'sum', 'count', 'number', 'date', 'instant', 'time', 'duration', 'text']);
const NUM = new Set(['int', 'decimal', 'money', 'sum', 'count', 'number', 'duration']);
const UNITS_OF = ['week', 'month', 'quarter', 'year'];
const OFFSET = /^([+-]\d+(s|min|h|d))?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEC = /^-?\d+(\.\d+)?$/;

function model(cat: Catalog, name: string): ModelInfo {
	const m = cat.models.get(name);
	if (m === undefined) throw invalid(`unknown model '${name}'`);
	return m;
}
const and = (of: Pred[]): Pred => of.length === 1 ? of[0]! : { t: 'and', of };
/** An object's defined entries: `{ eq: undefined }` is `{}` on the wire, so it is `{}` here too. */
const entries = (o: Obj) => Object.entries(o).filter(([, v]) => v !== undefined);
/** Rule 11a: a node that must say something (`{ status: {} }`, `not: {}`) is refused with its path. */
function nonEmpty(o: unknown, path: string, what: string): [string, unknown][] {
	if (!isObj(o)) throw invalid(`${path}: ${what}`);
	const es = entries(o);
	if (es.length === 0) throw invalid(`${path}: empty; ${what}`);
	return es;
}
function list(v: unknown, path: string): readonly unknown[] {
	if (!Array.isArray(v)) throw invalid(`${path}: takes a list`);
	if (v.length > WHERE_MAX_LIST) throw invalid(`${path}: more than ${WHERE_MAX_LIST} items`);
	return v;
}
const untag = (v: unknown, tag: string) => isObj(v) && Object.keys(v).length === 1 && tag in v ? v[tag] : v;
const validDate = (v: unknown) => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

/** Rule 11a: a literal of `f`'s kind; `null` is refused (`isNull` says it). */
function literal(f: FieldInfo, v: unknown, path: string): Json {
	const bad = (what: string): never => { throw invalid(`${path}: '${f.name}' takes ${what}`); };
	if (v === null || v === undefined) bad('a value (use isNull for null)');
	const k = f.kind;
	if (k === 'int' || k === 'count') { if (!Number.isSafeInteger(v)) bad('an integer'); }
	else if (k === 'decimal' || k === 'money' || k === 'sum' || k === 'number') {
		const x = untag(v, '$dec');
		if (!(typeof x === 'number' && Number.isFinite(x)) && !(typeof x === 'string' && DEC.test(x))) bad('a decimal');
	} else if (k === 'duration') { if (!Number.isSafeInteger(v) && !(typeof v === 'string' && /^\d+(s|min|h|d)$/.test(v))) bad('a duration'); }
	else if (k === 'bool') { if (typeof v !== 'boolean') bad('a boolean'); }
	else if (k === 'date') { if (!validDate(untag(v, '$d'))) bad('an ISO date'); }
	else if (k === 'instant') { const x = untag(v, '$t'); if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(x) || Number.isNaN(Date.parse(x))) bad('an ISO instant'); }
	else if (k === 'time') { if (typeof v !== 'string' || !/^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v)) bad('a time'); }
	else if (k === 'id') { if (typeof v !== 'string' || (f.pg === 'uuid' && !UUID.test(v))) bad('an id'); }
	else if (typeof v !== 'string') bad('text');
	else if (f.values !== undefined && !f.values.includes(v)) bad(`one of ${f.values.join(', ')}`);
	return v as Json;
}
/** Rule 11a: an operand only where its kind admits it (mirrors `Dyn`/`DynList` in `decl/where.ts`). */
function operand(info: ModelInfo, f: FieldInfo, o: Operand, path: string, list: boolean, kind = f.kind): Operand {
	const bad = (): never => { throw invalid(`${path}: '${f.name}' does not take ${JSON.stringify(o)}`); };
	if ('param' in o) { if (typeof o.param !== 'string') bad(); return o; }
	if (list) {
		if (!('actor' in o) || f.kind !== 'id') bad();
		const a = (o as { actor: unknown }).actor;
		if (a === 'teams' || a === 'teamTree' ? f.of !== 'sys_team' : !(isObj(a) && typeof a.scopes === 'string' && Object.keys(a).length === 1)) bad();
		return o;
	}
	if ('field' in o) {
		const g = typeof o.field === 'string' && !o.field.includes('.') ? info.fields.get(o.field) : undefined;
		if (g === undefined || family(g) !== family({ ...f, kind })) bad();
		return o;
	}
	if ('today' in o) { if (kind !== 'date' || typeof o.today !== 'string' || !OFFSET.test(o.today)) bad(); return o; }
	if ('now' in o) { if (kind !== 'instant' || typeof o.now !== 'string' || !OFFSET.test(o.now)) bad(); return o; }
	if ('startOf' in o) {
		if ((kind !== 'date' && kind !== 'instant') || !UNITS_OF.includes(o.startOf) || (o.shift !== undefined && !Number.isSafeInteger(o.shift))) bad();
		return o;
	}
	const a = o.actor;
	// an actor id is text too: ported grants compare `{ actor: 'id' }` with a text column (policy matrix, L-BOLT-229)
	if (a === 'email' ? !f.email : a === 'phone' ? !f.phone : a === 'id' ? f.of !== 'sys_user' && f.kind !== 'text' : a === 'party' ? f.kind !== 'id' : true) bad();
	return o;
}
const val = (info: ModelInfo, f: FieldInfo, v: unknown, path: string, kind?: string): Arg =>
	isOperand(v) ? operand(info, f, v, path, false, kind) : { lit: kind === undefined ? literal(f, v, path) : literal({ ...f, kind }, v, path) };
const point = (v: unknown) => isObj(v) && typeof v.lat === 'number' && typeof v.lng === 'number' && Number.isFinite(v.lat) && Number.isFinite(v.lng);
function periodArg(info: ModelInfo, f: FieldInfo, v: unknown, path: string): Arg {
	if (isOperand(v) && 'param' in v) return v;
	const [lo, hi] = f.periodOf === 'date' ? ['from', 'to'] : ['start', 'end'];
	const r = untag(v, '$period');
	if (!isObj(r) || !(lo! in r) || !(hi! in r) || Object.keys(r).length !== 2) throw invalid(`${path}: takes a period { ${lo}, ${hi} }`);
	const end = (x: unknown, p: string) => { const a = val(info, f, x, p, f.periodOf); return 'lit' in a ? a.lit : a as Json; };
	const [a, b] = [end(r[lo!], `${path}.${lo}`), r[hi!] === null ? null : end(r[hi!], `${path}.${hi}`)];
	const [x, y] = [untag(a, f.periodOf === 'date' ? '$d' : '$t'), untag(b, f.periodOf === 'date' ? '$d' : '$t')];
	if (typeof x === 'string' && typeof y === 'string' && (f.periodOf === 'date' ? x > y : Date.parse(x) > Date.parse(y))) throw invalid(`${path}: '${lo}' is after '${hi}'`);
	return { lit: { [lo!]: a, [hi!]: b } };
}

/** `{ field: value }` is `eq` (a list `in`, null `isNull`), as a person writes it; a tagged literal (`{ $d }`) is a value. */
const shorthand = (f: FieldInfo, ops: unknown): unknown =>
	f.many || (isObj(ops) && !Object.keys(ops).some((k) => k.startsWith('$'))) ? ops : ops === null ? { isNull: true } : Array.isArray(ops) ? { in: ops } : { eq: ops };

function fieldOps(info: ModelInfo, f: FieldInfo, ops: unknown, path: string): Pred[] {
	return nonEmpty(shorthand(f, ops), path, `'${f.name}' takes an operator object`).map(([op, v]): Pred => {
		const at = `${path}.${op}`;
		if (op === 'isNull' && !f.many) {
			if (typeof v !== 'boolean') throw invalid(`${at}: takes a boolean`);
			return { t: 'null', field: f.name, is: v };
		}
		if (f.many) {
			if (op === 'isEmpty') { if (typeof v !== 'boolean') throw invalid(`${at}: takes a boolean`); return { t: 'list', field: f.name, op, arg: v }; }
			if (op === 'has') return { t: 'list', field: f.name, op, arg: literal(f, v, at) };
			if (op === 'hasAny' || op === 'hasAll') return { t: 'list', field: f.name, op, arg: list(v, at).map((x, i) => literal(f, x, `${at}[${i}]`)) };
		} else if (f.kind === 'period') {
			if (op === 'contains') return { t: 'period', field: f.name, op, arg: val(info, f, v, at, f.periodOf) };
			if (op === 'overlaps' || op === 'within') return { t: 'period', field: f.name, op, arg: periodArg(info, f, v, at) };
		} else if (f.kind === 'point') {
			if (op === 'near') {
				if (!Array.isArray(v) || v.length !== 2 || !point(v[0]) || typeof v[1] !== 'number' || !Number.isFinite(v[1]) || v[1] < 0) throw invalid(`${at}: takes [point, metres ≥ 0]`);
				return { t: 'geo', field: f.name, near: v as never };
			}
			if (op === 'within') {
				const ok = isObj(v) && Object.keys(v).length === 1 && (Array.isArray(v.bbox) ? v.bbox.length === 2 && v.bbox.every(point)
					: Array.isArray(v.polygon) && v.polygon.length >= 3 && v.polygon.length <= WHERE_MAX_LIST && v.polygon.every(point));
				if (!ok) throw invalid(`${at}: takes { bbox: [point, point] } or { polygon: ≥ 3 points }`);
				return { t: 'geo', field: f.name, within: v as never };
			}
		} else if (f.kind === 'json') {
			if (op === 'contains') return { t: 'json', field: f.name, contains: v as Json };
			if (op === 'isEmpty') { if (typeof v !== 'boolean') throw invalid(`${at}: takes a boolean`); return { t: 'json', field: f.name, isEmpty: v }; }
		} else if (!['file', 'vector', 'custom', 'ref'].includes(f.kind)) {
			if (CMP.includes(op)) {
				if (op !== 'eq' && op !== 'ne' && !ORDERED.has(f.kind)) throw invalid(`${at}: '${f.name}' is not ordered`);
				return { t: 'cmp', field: f.name, op: op as Cmp, arg: val(info, f, v, at) };
			}
			if (op === 'in' || op === 'nin') return { t: 'in', field: f.name, negated: op === 'nin',
				args: isOperand(v) ? operand(info, f, v, at, true) : list(v, at).map((x, i) => literal(f, x, `${at}[${i}]`)) };
			if (op === 'like' && f.kind === 'text') {
				if (typeof v !== 'string') throw invalid(`${at}: takes a pattern string`);
				return { t: 'like', field: f.name, pattern: v };
			}
		}
		throw invalid(`${at}: unknown operator '${op}' on '${f.name}'`);
	});
}

const AGG = ['sum', 'min', 'max', 'avg'] as const;
/** Normalizes a `Where` literal over model `m` (K3), strictly (rule 11a): the first fault is `invalid` with its path. */
export function where(cat: Catalog, m: string, w: unknown, depth = 0, path = 'where', hops = 0): Pred {
	if (depth > WHERE_MAX_DEPTH) throw invalid(`${path}: nested deeper than ${WHERE_MAX_DEPTH}`);
	if (hops > 8) throw invalid(`${path}: crosses more than 8 relations`);
	if (!isObj(w)) throw invalid(`${path}: a predicate is an object`);
	const info = model(cat, m);
	const of: Pred[] = [];
	const sub = (x: unknown, p: string) => {
		if (isObj(x) && entries(x).length === 0) throw invalid(`${p}: an empty predicate (only a root or a quantifier body may be empty)`);
		return where(cat, m, x, depth + 1, p, hops);
	};
	for (const [key, v] of entries(w)) {
		const at = `${path}.${key}`;
		if (key === 'and' || key === 'or') of.push({ t: key, of: list(v, at).map((x, i) => sub(x, `${at}[${i}]`)) });
		else if (key === 'not') of.push({ t: 'not', of: sub(v, at) });
		else if (info.many.has(key)) {
			const rel = info.many.get(key)!;
			for (const [q, x] of nonEmpty(v, at, 'takes some, none, every, count, sum, min, max or avg')) {
				const qa = `${at}.${q}`;
				if (q === 'some' || q === 'none' || q === 'every') of.push({ t: 'many', rel: key, target: rel.child, q, pred: where(cat, rel.child, x, depth + 1, qa, hops + 1) });
				else if (q === 'count') for (const [op, n] of nonEmpty(x, qa, 'takes eq, ne, lt, lte, gt, gte')) {
					if (!CMP.includes(op) || !Number.isSafeInteger(n) || (n as number) < 0) throw invalid(`${qa}.${op}: count takes eq…gte of an integer ≥ 0`);
					of.push({ t: 'count', rel: key, target: rel.child, op: op as Cmp, n: n as number });
				}
				else if ((AGG as readonly string[]).includes(q)) {
					const es = nonEmpty(x, qa, 'takes { of, eq…gte }');
					const name = (x as Obj).of;
					const g = typeof name === 'string' && !name.includes('.') ? model(cat, rel.child).fields.get(name) : undefined;
					const kinds = q === 'min' || q === 'max' ? ['int', 'decimal', 'money', 'sum', 'count', 'duration', 'date', 'instant'] : ['int', 'decimal', 'money', 'sum', 'count', 'duration'];
					if (g === undefined || g.many || !kinds.includes(g.kind)) throw invalid(`${qa}.of: names a child field of ${kinds.join(', ')}`);
					const cmps = es.filter(([k]) => k !== 'of');
					if (cmps.length === 0) throw invalid(`${qa}: compares with eq…gte`);
					for (const [op, lit] of cmps) {
						if (!CMP.includes(op)) throw invalid(`${qa}.${op}: unknown operator`);
						// sum and avg are numbers even of a date-free kind; a duration's literal is its own
						const litKind = q === 'avg' && g.kind !== 'duration' ? { ...g, kind: 'decimal' } : g;
						of.push({ t: 'agg', rel: key, target: rel.child, fn: q as typeof AGG[number], of: g.name, op: op as Cmp, arg: literal(litKind, lit, `${qa}.${op}`) });
					}
				}
				else throw invalid(`${qa}: unknown quantifier '${q}' on '${key}' (some, none, every, count, sum, min, max, avg)`);
			}
		} else if (info.one.has(key)) {
			const rel = info.one.get(key)!;
			// `{ company_id: id }` is `eq`, as for a field (one target only: a polymorphic relation names its arm)
			const ops = rel.targets.length === 1 && !isObj(v) ? (v === null ? { isNull: true } : Array.isArray(v) ? { in: v } : { eq: v }) : v;
			const es = nonEmpty(ops, at, 'takes id operators or { is }');
			if (rel.targets.length > 1) {
				for (const [arm, x] of es) {
					if (!rel.targets.includes(arm)) throw invalid(`${at}.${arm}: not an arm of '${key}'`);
					of.push(...refOps(cat, info, key, arm, x, depth, `${at}.${arm}`, hops));
				}
			} else of.push(...refOps(cat, info, key, null, ops, depth, at, hops));
		} else {
			const f = info.fields.get(key);
			if (f === undefined || key.includes('.')) throw invalid(`${at}: unknown field '${key}' on '${m}'`);
			of.push(...fieldOps(info, f, v, at));
		}
	}
	return of.length === 0 ? { t: 'const', value: true } : and(of);
}
function refOps(cat: Catalog, info: ModelInfo, rel: string, arm: string | null, v: unknown, depth: number, path: string, hops: number): Pred[] {
	const target = arm ?? info.one.get(rel)!.targets[0]!;
	if (isObj(v) && 'is' in v) {
		if (entries(v).length !== 1) throw invalid(`${path}: takes id operators or { is }, not both`);
		if (!isObj(v.is) || entries(v.is).length === 0) throw invalid(`${path}.is: an empty predicate (use isNull: false)`);
		return [{ t: 'one', rel, target, pred: where(cat, target, v.is, depth + 1, `${path}.is`, hops + 1) }];
	}
	return fieldOps(info, info.fields.get(arm === null ? rel : `${rel}.${arm}`)!, v, path);
}

/** Rule 11a in the browser (`bolt.decode`): each top-level condition and sort key is kept or dropped alone. */
export function decodeView(cat: Catalog, collection: string, q: { where?: unknown; orderBy?: unknown }):
	{ where: Json; orderBy?: Json; dropped: { path: string; message: string }[] } {
	collectionOf(cat, collection);
	const dropped: { path: string; message: string }[] = [];
	const keep = (path: string, check: () => unknown) => {
		try { check(); return true; } catch (e) { dropped.push({ path, message: e instanceof Error ? e.message : String(e) }); return false; }
	};
	const w = isObj(q.where) ? Object.fromEntries(entries(q.where).filter(([k, v]) => keep(`where.${k}`, () => where(cat, collection, { [k]: v })))) : {};
	if (q.where !== undefined && !isObj(q.where)) dropped.push({ path: 'where', message: 'where: a predicate is an object' });
	const keys = q.orderBy === undefined ? [] : Array.isArray(q.orderBy) ? q.orderBy : [q.orderBy];
	const kept: unknown[] = [];
	keys.forEach((k, i) => { if (keep(`orderBy[${i}]`, () => order([...kept, k], cat, collection))) kept.push(k); });
	return { where: w as Json, ...(kept.length === 0 ? {} : { orderBy: kept as Json }), dropped };
}

export function page(p: Obj, max: number = LIMITS.page.max): PageIR {
	if (p.all === true) {
		if (p.limit !== undefined || p.after !== undefined) throw invalid('`all` takes no limit or cursor');
		return { all: true };
	}
	const limit = p.limit;
	if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0 || limit > max)
		throw invalid(`a read states { limit } (0–${max}) or { all: true } (rule 9)`);
	if (p.after !== undefined && typeof p.after !== 'string') throw invalid('a cursor is a string');
	return p.after === undefined ? { limit } : { limit, after: p.after };
}
const SORTABLE_SYSTEM = new Set(['created_at', 'updated_at']);
const UNSORTABLE = new Set(['json', 'file', 'custom', 'vector', 'point', 'period', 'ref']);
const ORDER_MAX_HOPS = 2;
/** A sort key's path and direction: `'f'`, `{ f: dir }`, or `{ rel: { f: dir } }` through at most `ORDER_MAX_HOPS` one-relations. */
function sortKey(x: unknown, i: number): [string, unknown] {
	const steps: string[] = [];
	let v: unknown = x;
	for (;;) {
		if (typeof v === 'string' && steps.length === 0 && !v.includes('.')) return [v, 'asc'];
		// nearest first: `{ location: { near: { lat, lng } } }`
		if (steps.length > 0 && isObj(v) && Object.keys(v).length === 1 && point(v.near)) return [steps.join('.'), { near: v.near }];
		const e = isObj(v) ? entries(v) : [];
		if (e.length !== 1 || e[0]![0].includes('.')) throw invalid(`orderBy[${i}]: one { field: 'asc' | 'desc' } per key`);
		steps.push(e[0]![0]);
		v = e[0]![1];
		if (!isObj(v)) return [steps.join('.'), v];
		if (steps.length > ORDER_MAX_HOPS) throw invalid(`orderBy[${i}]: a sort crosses at most ${ORDER_MAX_HOPS} relations`);
	}
}
/** `OrderBy<C>` (rule 11a): at most 4 keys, one field each, no field twice, each `Sortable` on its collection; a related key
 * (`{ account: { name: 'asc' } }`) is the path `account.name` in the IR. Readability of each hop is the compiler's (it knows who reads). */
export function order(o: unknown, cat?: Catalog, m?: string): Order {
	if (o === undefined) return [];
	const items = Array.isArray(o) ? o : [o];
	if (items.length > ORDER_MAX_KEYS) throw invalid(`orderBy: at most ${ORDER_MAX_KEYS} keys`);
	const seen = new Set<string>();
	return items.map((x, i) => {
		const [field, key] = sortKey(x, i);
		const near = isObj(key) ? key.near as { lat: number; lng: number } : undefined;
		const dir = near === undefined ? key : 'asc';
		if (dir !== 'asc' && dir !== 'desc') throw invalid(`orderBy[${i}]: '${field}' is asc or desc`);
		if (seen.has(field)) throw invalid(`orderBy[${i}]: '${field}' twice`);
		seen.add(field);
		if (cat !== undefined && m !== undefined) {
			const steps = field.split('.');
			let info = model(cat, m);
			for (const s of steps.slice(0, -1)) {
				const rel = info.one.get(s);
				if (rel === undefined || rel.targets.length > 1) throw invalid(`orderBy[${i}]: '${s}' is not a one-relation of '${info.name}'`);
				info = model(cat, rel.targets[0]!);
			}
			const last = steps.at(-1)!;
			const f = last.includes('.') ? undefined : info.fields.get(last);
			const system = (SYSTEM_COLUMNS as readonly string[]).includes(last);
			if (near !== undefined ? f?.kind !== 'point' : f === undefined || f.many || UNSORTABLE.has(f.kind) || (system && !SORTABLE_SYSTEM.has(last)))
				throw invalid(`orderBy[${i}]: '${field}' is not ${near === undefined ? 'sortable' : 'a point'}`);
		}
		return near === undefined ? { field, dir } : { field, dir, near };
	});
}
export function select(cat: Catalog, m: string, s: unknown, depth = 0): SelectIR {
	if (s === undefined) return { fields: null, relations: {} };
	if (!isObj(s)) throw invalid('select is an object');
	if (depth > 8) throw invalid('a select is nested deeper than 8 relations');
	const info = model(cat, m);
	const fields: string[] = [];
	const relations: { [rel: string]: RelSelectIR } = {};
	for (const [key, v] of Object.entries(s)) {
		if (v === true && info.fields.has(key) && !key.includes('.')) fields.push(key);
		else if (isObj(v) && info.one.has(key)) {
			const rel = info.one.get(key)!;
			if (rel.targets.length > 1) throw invalid(`'${key}' is an arc; select it as true`);
			relations[key] = { target: rel.targets[0]!, many: false, select: select(cat, rel.targets[0]!, v.select ?? {}, depth + 1) };
		} else if (isObj(v) && info.many.has(key)) {
			const child = info.many.get(key)!.child;
			const { select: sub, where: w, orderBy, ...paged } = v;
			relations[key] = { target: child, many: true, select: select(cat, child, sub ?? {}, depth + 1), page: page(paged),
				...(w === undefined ? {} : { where: where(cat, child, w) }), ...(orderBy === undefined ? {} : { order: order(orderBy, cat, child) }) };
		} else throw invalid(`cannot select '${key}' of '${m}'`);
	}
	// `select: {}` is the default projection, as its type (`Row<C>`) says
	return fields.length === 0 && Object.keys(relations).length === 0 ? { fields: null, relations } : { fields, relations };
}

const optional = <K extends string, V>(key: K, v: V | undefined) => (v === undefined ? {} : { [key]: v }) as { [P in K]?: V };

/** `read(collection, { where?, select?, orderBy?, search? } & Paged)`. */
export function read(cat: Catalog, collection: string, q: Obj): ReadIR {
	const { where: w, select: s, orderBy, search, ...paged } = q;
	collectionOf(cat, collection);
	if (search !== undefined && typeof search !== 'string') throw invalid('search is a string');
	return { kind: 'read', collection, select: select(cat, collection, s), page: page(paged),
		...optional('where', w === undefined ? undefined : where(cat, collection, w)),
		...optional('order', orderBy === undefined ? undefined : order(orderBy, cat, collection)),
		...optional('search', search === '' ? undefined : search as string | undefined) };
}
export function get(cat: Catalog, collection: string, id: string, q: Obj = {}): ReadIR {
	collectionOf(cat, collection);
	// L-BOLT-181: a revision get is the history fold, not a table read; ponytail: `select` does not narrow it
	if (q.revision !== undefined) {
		if (!Number.isInteger(q.revision)) throw invalid('revision is an integer');
		return { kind: 'history', collection, id, at: { revision: q.revision as number }, full: true };
	}
	return { kind: 'get', collection, id, select: select(cat, collection, q.select) };
}
const UNITS = ['day', 'week', 'month', 'quarter', 'year'] as const;
/** `aggregate(collection, { by?, count?, sum?, avg?, min?, max?, where? } & Paged?)`; `by` needs a page (rule 9). */
export function aggregate(cat: Catalog, collection: string, q: Obj): ReadIR {
	const { where: w, by, count, sum, avg, min, max, ...paged } = q;
	collectionOf(cat, collection);
	const buckets: Bucket[] = (by === undefined ? [] : Array.isArray(by) ? by : [by]).map((b): Bucket => {
		if (typeof b === 'string') return { field: b };
		const [unit, field] = isObj(b) ? Object.entries(b)[0] ?? [] : [];
		if (!UNITS.includes(unit as never) || typeof field !== 'string') throw invalid('a bucket is a field or { <unit>: field }');
		return { field, unit: unit as NonNullable<Bucket['unit']> };
	});
	if (buckets.length > 0 && Object.keys(paged).length === 0) throw invalid('an aggregate with `by` states { limit } or { all: true } (rule 9)');
	const list = (v: unknown) => v === undefined ? undefined : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v as string[] : (() => { throw invalid('sum, avg, min, max take field lists'); })();
	return { kind: 'aggregate', collection, by: buckets, ...optional('count', count === true ? true as const : undefined),
		...optional('sum', list(sum)), ...optional('avg', list(avg)), ...optional('min', list(min)), ...optional('max', list(max)),
		...optional('where', w === undefined ? undefined : where(cat, collection, w)),
		...optional('page', buckets.length > 0 ? page(paged) : undefined) };
}
/** `similar(collection, { to, where?, select?, limit })` over `search.semantic` (L-BOLT-123): `to` is text or `{ record: { id } }`. */
export function semantic(cat: Catalog, collection: string, q: Obj): ReadIR {
	const c = collectionOf(cat, collection);
	if (c.model.semantic === undefined) throw invalid(`'${collection}' declares no search.semantic (rule 16)`);
	const { to, where: w, select: s, ...paged } = q;
	const record = isObj(to) && isObj(to.record) ? to.record : undefined;
	if (!(typeof to === 'string' && to.trim() !== '') && typeof record?.id !== 'string') throw invalid('similar takes { to: text | { record: { id } } }');
	const p = page(paged);
	if (!('limit' in p) || p.after !== undefined) throw invalid('similar takes { limit }');
	return { kind: 'similar', collection, similarity: SEMANTIC, input: typeof to === 'string' ? to : { record: { id: record!.id as string } }, limit: p.limit,
		...optional('where', w === undefined ? undefined : where(cat, collection, w)), ...optional('select', s === undefined ? undefined : select(cat, collection, s)) };
}
/** `similar(collection, '<search>', input, { where?, select?, limit })`. */
export function similar(cat: Catalog, collection: string, similarity: string, input: Json, q: Obj): ReadIR {
	const c = collectionOf(cat, collection);
	if (!Object.hasOwn(c.similarity, similarity)) throw invalid(`'${collection}' declares no similarity '${similarity}'`);
	const p = page(q);
	if (!('limit' in p) || p.after !== undefined) throw invalid('similar takes { limit }');
	return { kind: 'similar', collection, similarity, input, limit: p.limit, ...optional('where', q.where === undefined ? undefined : where(cat, collection, q.where)),
		...optional('select', q.select === undefined ? undefined : select(cat, collection, q.select)) };
}
