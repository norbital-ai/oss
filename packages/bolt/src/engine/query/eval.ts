// `Pred` → JS (K3): the second evaluator, for live routing and tests. It must answer exactly as the SQL compiler does
// (`sql.ts`); a randomized test holds the two equal. A null never matches (SQL's unknown collapses to false), `ne` and
// negated membership use "distinct from", and `not` negates the collapsed value.
import { DateTime, Predicate } from 'effect';
import { equal_json } from '@norbital-ai/store/kind';
import type { Authority, Bindings, RowData } from '../contracts.ts';

import { BoltError } from '../../protocol/errors.ts';
import type { Json } from '../../decl/values.ts';
import {
	argument_list,
	comparable,
	type Arg,
	type Catalog,
	type Cmp,
	type FieldInfo,
	type Operand,
	type Pred
} from '@norbital-ai/store';
import { operand_value, readPredicates } from '../access/authority.ts';
import { instantOrder, storedField, storedOrder, storedRange } from '../db/stored.ts';

const invalid = (message: string) => BoltError.make('invalid', 'decode', message);
const jsonArray = (value: Json | undefined): value is readonly Json[] => Array.isArray(value);
const day = (d: string) => new Date(`${d}T00:00:00Z`);
/** The first day of the calendar unit holding `today` (weeks start Monday), moved `shift` units: a filter's literal bound. */
export function startOfDate(
	o: { unit: string; shift?: number | undefined },
	today: string
): string {
	const d = day(today),
		n = o.shift ?? 0;
	const [y, m] = [d.getUTCFullYear(), d.getUTCMonth()];
	const out =
		o.unit === 'week'
			? new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000 + n * 7 * 86_400_000)
			: o.unit === 'month'
				? new Date(Date.UTC(y, m + n, 1))
				: o.unit === 'quarter'
					? new Date(Date.UTC(y, m - (m % 3) + 3 * n, 1))
					: new Date(Date.UTC(y + n, 0, 1));
	return out.toISOString().slice(0, 10);
}
/** The instant of 00:00 on `date` in `tz`. */
export function midnight(date: string, tz: string): string {
	return DateTime.formatIso(
		DateTime.makeZonedUnsafe(`${date}T00:00:00`, { timeZone: tz, adjustForTimeZone: true, disambiguation: 'compatible' })
	);
}
/** Resolve a tagged dynamic operand once against this invocation's fixed bindings. */
export function operand(
	o: Operand,
	bindings: Bindings,
	authority: Authority | null | undefined
): Json {
	switch (o._tag) {
		case 'Var': {
			if (authority == null) throw invalid('a requestor variable needs a caller');
			return operand_value(o, authority);
		}
		case 'Field':
			throw invalid('a field operand has no value of its own');
	}
}

/** ILIKE with `\` escapes. */
export function likeRegex(pattern: string): RegExp {
	let out = '';
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern.charAt(i);
		if (ch === '\\' && i + 1 < pattern.length)
			out += pattern.charAt(++i).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		else out += ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp(`^${out}$`, 'is');
}
const R = 6_371_008.8;
function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
	const rad = Math.PI / 180;
	const h =
		Math.sin(((a.lat - b.lat) * rad) / 2) ** 2 +
		Math.cos(b.lat * rad) * Math.cos(a.lat * rad) * Math.sin(((a.lng - b.lng) * rad) / 2) ** 2;
	return R * 2 * Math.asin(Math.sqrt(h));
}

/**
 * One row's evaluation. A relation predicate is decided only in SQL, which scopes each hop by the reader's root output
 * (access/authority.ts): the in-memory evaluator reads no related rows, so it has one scoping rule fewer to keep.
 */
export type EvalEnv = {
	cat: Catalog;
	bindings: Bindings;
	/** The caller: operands resolve against it. */
	authority?: Authority | null;
};

function field(env: EvalEnv, model: string, row: RowData, name: string): Json {
	const dot = name.indexOf('.');
	const head = dot < 0 ? name : name.slice(0, dot), descriptor = env.cat.models.get(model)?.fields.get(head);
	const value = descriptor === undefined ? row[head] : ['timestamptz', 'daterange', 'tstzrange'].includes(descriptor.pg) ? row[descriptor.column] : storedField(descriptor, row);
	if (dot < 0) return value ?? null;
	return Predicate.isObject(value) && value['model'] === name.slice(dot + 1) ? value['id'] ?? null : null;
}
function info(env: EvalEnv, c: string, name: string): FieldInfo {
	const f = env.cat.models.get(c)?.fields.get(name);
	if (f !== undefined) return f;
	const dot = name.indexOf('.'), head = name.slice(0, dot), arm = name.slice(dot + 1);
	const reference = env.cat.models.get(c)?.fields.get(head), target = env.cat.models.get(arm);
	const key = target?.key[0], scalar = key === undefined ? undefined : target?.fields.get(key);
	if (dot > 0 && reference?.arms?.includes(arm) === true && scalar !== undefined)
		return { ...scalar, name, column: `${reference.column}__${arm}` };
	throw invalid(`unknown field '${name}' on '${c}'`);
}
/** Admit a row through one output, or any granted output for related-row and write visibility. */
export function canRead(env: EvalEnv, model: string, row: RowData, output?: string): boolean {
	if (env.authority == null) return true;
	const predicates = readPredicates(env.authority, model, output);
	return predicates === undefined || predicates.some((where) =>
		evaluate(env, model, where, row)
	);
}
const cmp = (field: Pick<FieldInfo, 'pg' | 'email'>, op: Cmp, a: Json | undefined, b: Json | undefined): boolean => {
	const left = comparable(a), right = comparable(b);
	if (left === null || right === null) return op === 'ne' && left !== right;
	if ((op === 'eq' || op === 'ne') && (field.pg === 'jsonb' || field.pg.endsWith('[]')))
		return equal_json(left, right) === (op === 'eq');
	const fold = (value: Json): Json => field.email === true && typeof value === 'string' ? value.toLowerCase() : value;
	const order = storedOrder(field, fold(left), fold(right));
	if (order === undefined) throw invalid(`cannot compare a ${field.pg} value in memory`);
	return op === 'eq'
		? order === 0
		: op === 'ne'
			? order !== 0
			: op === 'lt'
				? order < 0
				: op === 'lte'
					? order <= 0
					: op === 'gt'
						? order > 0
						: order >= 0;
};

type Range = { lo: bigint | string; hi: bigint | string | null };
function range(f: FieldInfo, v: Json | undefined): Range | null {
	if (v == null || v === 'empty') return null;
	const period = storedRange(f, v);
	if (period === undefined) throw invalid('a period needs valid stored bounds');
	if (f.period_of === 'date') return { lo: period.from, hi: period.to === '' ? null : period.to };
	const lo = instantOrder(period.from), hi = period.to === '' ? null : instantOrder(period.to);
	if (lo === undefined || hi === undefined) throw invalid('an instant period needs valid instant bounds');
	return { lo, hi };
}
const below = (x: bigint | string, hi: bigint | string | null) => hi === null || x < hi;
/** Whether `row` of `model` satisfies `p`. */
export function evaluate(env: EvalEnv, c: string, p: Pred, row: RowData): boolean {
	switch (p.t) {
		case 'const':
			return p.value;
		case 'and':
			return p.of.every((x) => evaluate(env, c, x, row));
		case 'or':
			return p.of.some((x) => evaluate(env, c, x, row));
		case 'not':
			return !evaluate(env, c, p.of, row);
		case 'null':
			return (field(env, c, row, p.field) === null) === p.is;
		case 'cmp': {
			const f = info(env, c, p.field);
			const comparison = p.arg._tag === 'Field' && ['float4', 'float8'].includes(info(env, c, p.arg.field).pg)
				? { ...f, pg: 'float8' } : f;
			const rhs =
				p.arg._tag === 'Lit'
					? p.arg.value
					: p.arg._tag === 'Field'
						? field(env, c, row, p.arg.field)
						: operand(p.arg, env.bindings, env.authority);
			return cmp(comparison, p.op, field(env, c, row, p.field), rhs);
		}
		case 'like': {
			const v = field(env, c, row, p.field);
			return typeof v === 'string' && likeRegex(p.pattern).test(v);
		}
		case 'text': {
			const value = field(env, c, row, p.field);
			const normalize = (value: string) =>
				p.mode === 'folded' ? value.toLowerCase() : value.replace(/[^0-9]/g, '');
			return typeof value === 'string' && normalize(value) === normalize(p.value);
		}
		case 'age': {
			const value = instantOrder(field(env, c, row, p.field)), now = instantOrder(env.bindings.now);
			if (now === undefined) throw invalid('an age predicate needs a valid invocation instant');
			return value !== undefined && value < now - BigInt(p.seconds) * 1_000_000_000n;
		}
		case 'in': {
			const f = info(env, c, p.field);
			const a = field(env, c, row, p.field);
			let list: Json;
			if (argument_list(p.args)) list = p.args;
			else {
				if (p.args._tag === 'Member') throw invalid('a composed member is decided by a read, not in memory');
				list = operand(p.args, env.bindings, env.authority);
			}
			const found =
				a !== null &&
				(jsonArray(list) ? list : list === null ? [] : [list]).some((x) => cmp(f, 'eq', a, x));
			return p.negated ? !found : found;
		}
		case 'has': {
			const arr = field(env, c, row, p.field);
			if (arr !== null && !jsonArray(arr)) throw invalid('a list predicate needs an array');
			return arr !== null && arr.includes(p.arg);
		}
		case 'period': {
			const f = info(env, c, p.field);
			const r = range(f, field(env, c, row, p.field));
			if (r === null) return false;
			if (p.op === 'contains') {
				const arg =
					p.arg._tag === 'Lit'
						? p.arg.value
						: p.arg._tag === 'Field'
							? field(env, c, row, p.arg.field)
							: operand(p.arg, env.bindings, env.authority);
				if (arg === null) return false;
				const value = comparable(arg), x = f.period_of === 'date' ? value : instantOrder(value);
				if (typeof x !== 'string' && typeof x !== 'bigint') throw invalid('a period compares with a date or instant');
				return r.lo <= x && below(x, r.hi);
			}
			const end = (e: Arg): Json =>
				e._tag === 'Lit' ? e.value : operand(e, env.bindings, env.authority);
			const [lo, hi] = f.period_of === 'date' ? ['from', 'to'] : ['start', 'end'];
			const o = range(f, { [lo]: end(p.lo), [hi]: end(p.hi) });
			if (o === null || (o.hi !== null && (f.period_of === 'date' ? o.lo >= o.hi : o.lo > o.hi))) return false;
			if (p.op === 'overlaps')
				return below(r.lo, o.hi) && below(o.lo, r.hi) && r.lo !== r.hi && o.lo !== o.hi;
			// a bound in the span: the first day (start) from its start, the last day (end) up to its end; none unbounded
			if (p.op === 'starts_within') return o.lo <= r.lo && below(r.lo, o.hi);
			if (p.op === 'ends_within')
				return r.hi !== null && o.lo < r.hi && (o.hi === null || r.hi <= o.hi);
			return o.lo <= r.lo && (o.hi === null || (r.hi !== null && r.hi <= o.hi));
		}
		case 'geo': {
			const value = field(env, c, row, p.field);
			if (value === null) return false;
			if (!Predicate.isObject(value) || typeof value['lat'] !== 'number' || typeof value['lng'] !== 'number')
				throw invalid('a geo predicate needs a point');
			const v = { lat: value['lat'], lng: value['lng'] };
			if (p.near !== undefined) return haversine(v, p.near[0]) <= p.near[1];
			const s = p.within;
			if (s === undefined) throw invalid('a geo predicate needs near or within');
			if ('bbox' in s) {
				const [a, b] = s.bbox;
				return (
					v.lat >= Math.min(a.lat, b.lat) &&
					v.lat <= Math.max(a.lat, b.lat) &&
					v.lng >= Math.min(a.lng, b.lng) &&
					v.lng <= Math.max(a.lng, b.lng)
				);
			}
			let inside = false;
			const poly = s.polygon;
			let pj = poly.at(-1);
			if (pj === undefined) throw invalid('a polygon needs vertices');
			for (const pi of poly) {
				if (
					pi.lat > v.lat !== pj.lat > v.lat &&
					v.lng < ((pj.lng - pi.lng) * (v.lat - pi.lat)) / (pj.lat - pi.lat) + pi.lng
				)
					inside = !inside;
				pj = pi;
			}
			return inside;
		}
		// Inline paths use PostgreSQL's JSON casts: only a read decides them.
		case 'path':
		case 'each':
			throw invalid(`${p.t} is decided by a read, not in memory`);
		// the search document and the embedding live in the database: only a read decides them
		case 'search':
		case 'similar':
			throw invalid(`$${p.t} is decided by a read, not in memory`);
		// a relation is decided only in SQL, scoped by the reader's root output: one rule, never a second in memory
		case 'one':
		case 'many':
		case 'count':
		case 'agg':
			throw invalid(`a ${p.t} predicate is decided by a read, not in memory`);
		case 'json':
			return contains(field(env, c, row, p.field), p.contains, true);
	}
}
/** jsonb `@>`: objects by key, arrays by any element, scalars by equality; a top-level array holds a bare scalar. */
export function contains(a: Json | undefined, b: Json, top = false): boolean {
	if (a === null || a === undefined) return !top && a === null && b === null;
	if (jsonArray(a)) {
		if (!jsonArray(b)) return top && typeof b !== 'object' && a.some((value) => value === b);
		return b.every((x) => a.some((y) => contains(y, x)));
	}
	if (typeof a === 'object')
		return (
			Predicate.isObject(b) &&
			Object.entries(b).every(([k, x]) => Object.hasOwn(a, k) && contains(a[k], x))
		);
	return a === b;
}
