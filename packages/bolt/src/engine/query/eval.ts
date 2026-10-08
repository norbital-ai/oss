// `Pred` → JS (K3): the second evaluator, for live routing and tests. It must answer exactly as the SQL compiler does
// (`sql.ts`); a randomized test holds the two equal. A null never matches (SQL's unknown collapses to false), `ne` and
// `nin` are "distinct from", and `not` negates the collapsed value.
import type { Authority, Bindings, Pred, RowData } from '../contracts.ts';
import { BoltError } from '../contracts.ts';
import type { Json } from '../../decl/values.ts';
import type { Operand } from '../../decl/where.ts';
import type { Catalog, FieldInfo } from '../../protocol/catalog.ts';

const invalid = (message: string) => new BoltError('invalid', 'decode', message);
const UNIT_MS = { s: 1_000, min: 60_000, h: 3_600_000, d: 86_400_000 } as const;
/** `'+30d'`, `'-1h'`, `''` → milliseconds. */
export function offsetMs(o: string): number {
	if (o === '') return 0;
	const m = /^([+-])(\d+)(s|min|h|d)$/.exec(o);
	if (m === null) throw invalid(`'${o}' is not an offset`);
	return (m[1] === '-' ? -1 : 1) * Number(m[2]) * UNIT_MS[m[3] as keyof typeof UNIT_MS];
}
const DURATION = /^(\d+)(s|min|h|d)$/;
const TAGS = new Set(['$dec', '$t', '$d']);

/** A tagged wire value (`{ $dec: '1.20' }`) as its plain JSON form; a `Duration` literal of a duration field as seconds. */
export function plain(v: unknown, f?: FieldInfo): Json {
	if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
		const keys = Object.keys(v);
		if (keys.length === 1 && TAGS.has(keys[0]!)) return (v as { [k: string]: Json })[keys[0]!]!;
	}
	if (f?.kind === 'duration' && typeof v === 'string') {
		const m = DURATION.exec(v);
		if (m !== null) return Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS] / 1000;
	}
	return v as Json;
}

const day = (d: string) => new Date(`${d}T00:00:00Z`);
/** `{ startOf, shift? }` as a date: the first day of the unit holding `today` (weeks start Monday), moved `shift` units. */
export function startOfDate(o: { startOf: string; shift?: number }, today: string): string {
	const d = day(today), n = o.shift ?? 0;
	const [y, m] = [d.getUTCFullYear(), d.getUTCMonth()];
	const out = o.startOf === 'week' ? new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000 + n * 7 * 86_400_000)
		: o.startOf === 'month' ? new Date(Date.UTC(y, m + n, 1))
		: o.startOf === 'quarter' ? new Date(Date.UTC(y, m - (m % 3) + 3 * n, 1))
		: new Date(Date.UTC(y + n, 0, 1));
	return out.toISOString().slice(0, 10);
}
/** The instant of 00:00 on `date` in `tz`. */
export function midnight(date: string, tz: string): string {
	const utc = day(date).getTime();
	const offset = (at: number) => {
		const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
			hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at).map((x) => [x.type, x.value]));
		return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - at;
	};
	const guess = utc - offset(utc);
	return new Date(utc - offset(guess)).toISOString();
}
/** An operand's value (not `{ field }`), resolved once per invocation (rule 26 keeps `now` and `today` on replay);
 * `kind` is the value's kind where it matters (`startOf` on an instant is that day's 00:00 in the workspace zone). */
export function operand(o: Operand, bindings: Bindings, authority: Authority | null | undefined, kind?: string): Json {
	if ('startOf' in o) {
		const d = startOfDate(o, bindings.today);
		return kind === 'instant' ? midnight(d, bindings.tz) : d;
	}
	if ('param' in o) {
		if (!Object.hasOwn(bindings.params, o.param)) throw invalid(`no parameter '${o.param}'`);
		return bindings.params[o.param]!;
	}
	if ('now' in o) return new Date(Date.parse(bindings.now) + offsetMs(o.now)).toISOString();
	if ('today' in o) return new Date(Date.parse(`${bindings.today}T00:00:00Z`) + offsetMs(o.today)).toISOString().slice(0, 10);
	if ('actor' in o) {
		if (authority == null) throw invalid('an actor operand needs a caller');
		const a = authority.actor.kind === 'member' ? authority.actor : authority.actor.kind === 'envoy' ? authority.actor.linked ?? null : null; // hook:envoys (P32)
		const k = o.actor;
		if (typeof k === 'object') return [...(authority.scopes[k.scopes] ?? [])];
		if (k === 'teamTree') return [...authority.teamTree];
		if (k === 'teams') return a === null ? [] : [...a.teams];
		if (k === 'id') return a?.id ?? null;
		if (k === 'email') return a?.email ?? null;
		if (k === 'phone') return a?.phone ?? null;
		/** The anonymous identity: the visitor id for visitors, `null` for anyone signed in. */
		if (k === 'visitor') return authority.actor.kind === 'visitor' ? authority.actor.visitor : null;
		return a?.party?.id ?? null;
	}
	throw invalid('a field operand has no value of its own');
}

const NUMERIC = new Set(['int', 'decimal', 'money', 'sum', 'count', 'number', 'duration']);
/** A comparable form: numbers for numeric kinds, epoch ms for instants, case-folded email. */
function norm(f: FieldInfo, v: unknown): string | number | boolean | null {
	const p = plain(v, f);
	if (p === null || p === undefined) return null;
	if (NUMERIC.has(f.kind)) return Number(p);
	if (f.kind === 'instant') return Date.parse(p as string);
	if (f.email) return String(p).toLowerCase();
	return p as string | boolean;
}
/** ILIKE with `\` escapes. */
export function likeRegex(pattern: string): RegExp {
	let out = '';
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i]!;
		if (ch === '\\' && i + 1 < pattern.length) out += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		else out += ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp(`^${out}$`, 'is');
}
const R = 6_371_008.8;
export function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
	const rad = Math.PI / 180;
	const h = Math.sin((a.lat - b.lat) * rad / 2) ** 2 + Math.cos(b.lat * rad) * Math.cos(a.lat * rad) * Math.sin((a.lng - b.lng) * rad / 2) ** 2;
	return R * 2 * Math.asin(Math.sqrt(h));
}

export type EvalEnv = {
	cat: Catalog; bindings: Bindings;
	/** The caller: operands resolve against it; with `scoped`, related rows are filtered by its scope and fields masked. */
	authority?: Authority | null; scoped?: boolean;
	/** The rows of `target` related to `row` through `rel` of `collection` (a one-relation gives 0 or 1). */
	related?: (collection: string, rel: string, target: string, row: RowData) => readonly RowData[];
};

function field(env: EvalEnv, c: string, row: RowData, name: string): Json {
	const dot = name.indexOf('.');
	let v: Json;
	if (dot > 0) {
		const ref = row[name.slice(0, dot)] as { collection?: string; id?: string } | null | undefined;
		v = ref?.collection === name.slice(dot + 1) ? ref.id ?? null : null;
	} else v = row[name] ?? null;
	const mask = env.scoped && env.authority && !env.authority.admin ? env.authority.collections[c]?.masks[name] : undefined;
	return mask === undefined || evaluate({ ...env, scoped: false }, c, mask, row) ? v : null;
}
function info(env: EvalEnv, c: string, name: string): FieldInfo {
	const f = env.cat.models.get(c)?.fields.get(name);
	if (f === undefined) throw invalid(`unknown field '${name}' on '${c}'`);
	return f;
}
function visible(env: EvalEnv, c: string, row: RowData): boolean {
	const a = env.authority;
	if (!env.scoped || a == null || a.admin) return true;
	return (a.collections[c]?.read ?? []).some((arm) => evaluate({ ...env, scoped: false }, c, arm.where, row));
}
function rows(env: EvalEnv, c: string, rel: string, target: string, row: RowData): RowData[] {
	if (env.related === undefined) throw invalid('this evaluation has no related rows');
	return env.related(c, rel, target, row).filter((r) => visible(env, target, r));
}
const cmp = (op: string, a: unknown, b: unknown): boolean => {
	if (op === 'ne') return a !== b;
	if (a === null || b === null) return false;
	const [x, y] = [a as number, b as number];
	return op === 'eq' ? x === y : op === 'lt' ? x < y : op === 'lte' ? x <= y : op === 'gt' ? x > y : x >= y;
};
type Range = { lo: number | string; hi: number | string | null };
function range(f: FieldInfo, v: unknown): Range | null {
	const r = plain(v) as { [k: string]: Json } | null;
	if (r == null) return null;
	const p = Object.fromEntries(Object.entries(r).map(([k, x]) => [k, plain(x)])) as { from?: string; to?: string | null; start?: string; end?: string | null };
	// a date period is inclusive: its exclusive upper bound is the day after `to`
	if (f.periodOf === 'date') return { lo: p.from!, hi: p.to == null ? null : new Date(Date.parse(`${p.to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) };
	return { lo: Date.parse(p.start!), hi: p.end == null ? null : Date.parse(p.end) };
}
const below = (x: number | string, hi: number | string | null) => hi === null || x < hi;
/** A period argument whose ends cross (a dynamic end past the other): matches nothing, in SQL too. */
export const inverted = (f: FieldInfo, lo: unknown, hi: unknown): boolean => hi !== null && hi !== undefined && lo !== null && lo !== undefined
	&& (f.periodOf === 'date' ? String(lo) >= String(hi) : Date.parse(String(lo)) > Date.parse(String(hi)));

/** Whether `row` of `collection` satisfies `p`. */
export function evaluate(env: EvalEnv, c: string, p: Pred, row: RowData): boolean {
	switch (p.t) {
		case 'const': return p.value;
		case 'and': return p.of.every((x) => evaluate(env, c, x, row));
		case 'or': return p.of.some((x) => evaluate(env, c, x, row));
		case 'not': return !evaluate(env, c, p.of, row);
		case 'null': return (field(env, c, row, p.field) === null) === p.is;
		case 'cmp': {
			const f = info(env, c, p.field);
			const rhs = 'lit' in p.arg ? p.arg.lit : 'field' in p.arg ? field(env, c, row, p.arg.field) : operand(p.arg, env.bindings, env.authority, f.kind);
			return cmp(p.op, norm(f, field(env, c, row, p.field)), norm(f, rhs));
		}
		case 'like': {
			const v = field(env, c, row, p.field);
			return typeof v === 'string' && likeRegex(p.pattern).test(v);
		}
		case 'in': {
			const f = info(env, c, p.field);
			const a = norm(f, field(env, c, row, p.field));
			const list = Array.isArray(p.args) ? p.args : operand(p.args as Operand, env.bindings, env.authority);
			const found = a !== null && (Array.isArray(list) ? list : list === null ? [] : [list]).some((x) => norm(f, x) === a);
			return p.negated ? !found : found;
		}
		case 'list': {
			const arr = field(env, c, row, p.field) as readonly Json[] | null;
			if (p.op === 'isEmpty') return p.arg === true ? arr === null || arr.length === 0 : arr !== null && arr.length > 0;
			if (arr === null) return false;
			const want = p.op === 'has' ? [p.arg] : p.arg as readonly Json[];
			return p.op === 'hasAny' ? want.some((x) => arr.includes(x)) : want.every((x) => arr.includes(x));
		}
		case 'period': {
			const f = info(env, c, p.field);
			const r = range(f, field(env, c, row, p.field));
			if (r === null) return false;
			const arg = 'lit' in p.arg ? p.arg.lit : 'field' in p.arg ? field(env, c, row, p.arg.field) : operand(p.arg, env.bindings, env.authority, f.periodOf);
			if (arg === null) return false;
			if (p.op === 'contains') {
				const x = f.periodOf === 'date' ? plain(arg) as string : Date.parse(plain(arg) as string);
				return r.lo <= x && below(x, r.hi);
			}
			const o = range(f, periodEnds(f, arg, env.bindings, env.authority))!;
			if (inverted(f, o.lo, o.hi)) return false;
			if (p.op === 'overlaps') return below(r.lo, o.hi) && below(o.lo, r.hi) && r.lo !== r.hi && o.lo !== o.hi;
			return o.lo <= r.lo && (o.hi === null || (r.hi !== null && r.hi <= o.hi));
		}
		case 'geo': {
			const v = field(env, c, row, p.field) as { lat: number; lng: number } | null;
			if (v === null) return false;
			if (p.near !== undefined) return haversine(v, p.near[0]) <= p.near[1];
			const s = p.within!;
			if ('bbox' in s) {
				const [a, b] = s.bbox;
				return v.lat >= Math.min(a.lat, b.lat) && v.lat <= Math.max(a.lat, b.lat) && v.lng >= Math.min(a.lng, b.lng) && v.lng <= Math.max(a.lng, b.lng);
			}
			let inside = false;
			const poly = s.polygon;
			for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
				const [pi, pj] = [poly[i]!, poly[j]!];
				if ((pi.lat > v.lat) !== (pj.lat > v.lat) && v.lng < (pj.lng - pi.lng) * (v.lat - pi.lat) / (pj.lat - pi.lat) + pi.lng) inside = !inside;
			}
			return inside;
		}
		// the search document and the embedding live in the database: only a read decides them
		case 'search': case 'similar': throw invalid(`$${p.t} is decided by a read, not in memory`);
		case 'one': return rows(env, c, p.rel, p.target, row).some((r) => evaluate(env, p.target, p.pred, r));
		case 'many': {
			const rs = rows(env, c, p.rel, p.target, row);
			const hit = (r: RowData) => evaluate(env, p.target, p.pred, r);
			return p.q === 'some' ? rs.some(hit) : p.q === 'none' ? !rs.some(hit) : rs.every(hit);
		}
		case 'count': return cmp(p.op, rows(env, c, p.rel, p.target, row).length, p.n);
		case 'agg': {
			const f = info(env, p.target, p.of);
			if (env.scoped && env.authority && !env.authority.admin && env.authority.collections[p.target]?.masks[p.of] !== undefined)
				throw new BoltError('forbidden', 'admission', `'${p.of}' is masked to this caller and cannot be aggregated (rule 14)`);
			const xs = rows(env, c, p.rel, p.target, row).map((r) => norm(f, r[p.of] ?? null)).filter((x): x is number => x !== null) as number[];
			// SQL sums decimals exactly; 15 significant digits keeps 10.10 + 10.20 equal to 20.3 here too
			const exact = (x: number) => Number(x.toPrecision(15));
			const v = p.fn === 'sum' ? exact(xs.reduce((s, x) => s + x, 0)) : xs.length === 0 ? null
				: p.fn === 'avg' ? exact(xs.reduce((s, x) => s + x, 0) / xs.length) : p.fn === 'min' ? xs.reduce((a, b) => a < b ? a : b) : xs.reduce((a, b) => a > b ? a : b);
			// ne of an empty aggregate is unknown too, as in SQL's `<>`
			return v !== null && cmp(p.op, v, norm(f, p.arg));
		}
		case 'json': {
			const v = field(env, c, row, p.field);
			if ('isEmpty' in p) return p.isEmpty ? v === null || (Array.isArray(v) && v.length === 0) : Array.isArray(v) && v.length > 0;
			return contains(v, p.contains, true);
		}
	}
}
/** jsonb `@>`: objects by key, arrays by any element, scalars by equality; a top-level array holds a bare scalar. */
export function contains(a: Json | undefined, b: Json, top = false): boolean {
	if (a === null || a === undefined) return !top && a === null && b === null;
	if (Array.isArray(a)) {
		if (!Array.isArray(b)) return top && typeof b !== 'object' && a.includes(b as never);
		return b.every((x) => a.some((y) => contains(y, x)));
	}
	if (typeof a === 'object') return typeof b === 'object' && b !== null && !Array.isArray(b) && Object.entries(b).every(([k, x]) => Object.hasOwn(a, k) && contains((a as { [k: string]: Json })[k]!, x));
	return a === b;
}
/** A period argument's ends, each a literal or a date operand (`{ startOf }`, `{ today }`). */
export function periodEnds(f: FieldInfo, v: Json, bindings: Bindings, authority: Authority | null | undefined): Json {
	const r = plain(v);
	if (typeof r !== 'object' || r === null || Array.isArray(r)) return r;
	return Object.fromEntries(Object.entries(r).map(([k, x]) => [k, typeof x === 'object' && x !== null && !Array.isArray(x) && !TAGS.has(Object.keys(x)[0]!)
		? operand(x as Operand, bindings, authority, f.periodOf) : x]));
}
