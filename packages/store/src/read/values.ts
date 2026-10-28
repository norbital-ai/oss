// Wire values → what a statement binds: decimals as their text, periods as range literals, points as `(lng,lat)`,
// durations as seconds. Shared by the read and write compilers and the DDL.
import { Effect } from 'effect';
import type { Json } from '../values.ts';
import type { Operand } from '../ir.ts';
import type { FieldInfo } from '../catalog.ts';
import { isOperand, isTaggedOperand, taggedOperand } from '../decode.ts';
import type { StoreError } from '../errors.ts';

const UNIT_S: { readonly [unit: string]: number } = { s: 1, min: 60, h: 3_600, d: 86_400 };
const DURATION = /^(\d+)(s|min|h|d)$/;
const isObject = (value: Json): value is { readonly [key: string]: Json } =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Wire decimals (`$dec`) → their text, which Postgres casts per column; dates and instants are ISO strings. With the
 * column's field, a period becomes its range literal: a date period `{ from, to }` is inclusive `[from,to]` (Postgres
 * stores `[from,to+1)`), an instant period `{ start, end }` closed-open; a null end is open; a point `(lng,lat)`.
 */
export function databaseValue(v: Json, f?: Pick<FieldInfo, 'kind' | 'periodOf'>): Json {
	if (isObject(v)) {
		const o = v,
			keys = Object.keys(o);
		if (keys.length === 1 && keys[0] === '$dec') return o['$dec'] ?? null;
		// a point `{ lat, lng }` is a Postgres `point` literal (x = lng, y = lat)
		if (f?.kind === 'point') return `(${String(o['lng'])},${String(o['lat'])})`;
		if (f?.kind === 'period') {
			const [lo, hi] = f.periodOf === 'date' ? [o['from'], o['to']] : [o['start'], o['end']];
			return `[${String(databaseValue(lo ?? null))},${hi == null ? '' : String(databaseValue(hi))}${f.periodOf === 'date' ? ']' : ')'}`;
		}
	}
	return v;
}

/**
 * One field's stored columns (`databaseValue`d): a polymorphic relation's `{ model, id }` spreads over its arm
 * columns `<fk>__<arm>`, the named arm holding the id and every other arm null (the CHECK allows at most one).
 */
export function cells(
	k: string,
	v: Json,
	f?: Pick<FieldInfo, 'kind' | 'periodOf' | 'arms' | 'column'>
): [string, Json][] {
	if (f?.arms === undefined) return [[k, databaseValue(v, f)]];
	const ref = isObject(v) ? v : null;
	return f.arms.map((arm) => [`${f.column}__${arm}`, ref?.model === arm ? (ref.id ?? null) : null]);
}

/** A literal json path (`'{"a","b"}'`): inline, so a predicate's expression is the one a path index is built on. */
export const jsonPath = (path: readonly string[]): string =>
	`'{${path.map((s) => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll("'", "''")}"`).join(',')}}'`;

/** Normalize numeric wire values at comparison/SQL boundaries; dates stay ISO strings. */
export function comparable(v: Json | undefined, f?: FieldInfo): Json {
	const d = f?.kind === 'duration' && typeof v === 'string' ? DURATION.exec(v) : null;
	return d === null ? databaseValue(v ?? null) : Number(d[1]) * (UNIT_S[d[2] ?? ''] ?? 1);
}

/** A period argument whose ends cross (a dynamic end past the other): matches nothing. */
export const inverted = (f: FieldInfo, lo: unknown, hi: unknown): boolean =>
	hi !== null &&
	hi !== undefined &&
	lo !== null &&
	lo !== undefined &&
	(f.periodOf === 'date'
		? String(lo) >= String(hi)
		: Date.parse(String(lo)) > Date.parse(String(hi)));

/** A period argument's ends, each a literal or an operand resolved by `resolve`. */
export const periodEnds: (
	v: Json,
	resolve: (o: Operand) => Effect.Effect<Json, StoreError>
) => Effect.Effect<Json, StoreError> = Effect.fnUntraced(function* (
	v: Json,
	resolve: (o: Operand) => Effect.Effect<Json, StoreError>
) {
	const r = comparable(v);
	if (typeof r !== 'object' || r === null || Array.isArray(r)) return r;
	const out: { [k: string]: Json } = {};
	for (const [k, x] of Object.entries(r))
		out[k] =
			typeof x === 'object' && x !== null && !Array.isArray(x) && !Object.hasOwn(x, '$dec')
				? isOperand(x)
					? yield* resolve(taggedOperand(x))
					: isTaggedOperand(x)
						? yield* resolve(x)
						: x
				: x;
	const ends: Json = out;
	return ends;
});

/**
 * A period column `x` against a period `span` (SQL range text): `overlaps` and `within` test the whole period;
 * `startsWithin` its first day or start instant; `endsWithin` its last day (the day before a date range's exclusive
 * upper bound) or end instant. An unbounded end is in no span.
 */
export const periodTest = (
	op: 'overlaps' | 'within' | 'startsWithin' | 'endsWithin',
	x: string,
	span: string,
	date: boolean
): string =>
	op === 'overlaps'
		? `(${x} && ${span})`
		: op === 'within'
			? `(${x} <@ ${span})`
			: op === 'startsWithin'
				? `(lower(${x}) <@ ${span})`
				: date
					? `((upper(${x}) - 1) <@ ${span})`
					: `(upper(${x}) > lower(${span}) AND (upper_inf(${span}) OR upper(${x}) <= upper(${span})))`;
