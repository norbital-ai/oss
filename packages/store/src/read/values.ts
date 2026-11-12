// Wire values → what a statement binds: decimals as their text, periods as range literals, points as `(lng,lat)`,
// shared by the read and write compilers and the DDL.
import { Predicate } from 'effect';
import { literal } from '@norbital-ai/std/sql';
import type { Json } from '../values.ts';
import type { FieldInfo } from '../catalog.ts';

/**
 * Wire decimals (`$dec`) → their text, which Postgres casts per column; dates and instants are ISO strings. With the
 * column's field, a period becomes its range literal: a date period `{ from, to }` is inclusive `[from,to]` (Postgres
 * stores `[from,to+1)`), an instant period `{ start, end }` closed-open; a null end is open; a point `(lng,lat)`.
 */
export function database_value(v: Json, f?: Pick<FieldInfo, 'kind' | 'period_of'>): Json {
	if (Predicate.isObject(v)) {
		const o = v,
			keys = Object.keys(o);
		if (keys.length === 1 && keys[0] === '$dec') return o['$dec'] ?? null;
		// a point `{ lat, lng }` is a Postgres `point` literal (x = lng, y = lat)
		if (f?.kind === 'point') return `(${String(o['lng'])},${String(o['lat'])})`;
		if (f?.kind === 'period') {
			const [lo, hi] = f.period_of === 'date' ? [o['from'], o['to']] : [o['start'], o['end']];
			return `[${String(database_value(lo ?? null))},${hi == null ? '' : String(database_value(hi))}${f.period_of === 'date' ? ']' : ')'}`;
		}
	}
	return v;
}

/**
 * One field's stored columns (`database_value`d): a polymorphic relation's `{ model, id }` spreads over its arm
 * columns `<fk>__<arm>`, the named arm holding the id and every other arm null (the CHECK allows at most one).
 */
export function cells(
	k: string,
	v: Json,
	f?: Pick<FieldInfo, 'kind' | 'period_of' | 'arms' | 'column'>
): [string, Json][] {
	if (f?.arms === undefined) return [[k, database_value(v, f)]];
	const ref = Predicate.isObject(v) ? v : null;
	return f.arms.map((arm) => [`${f.column}__${arm}`, ref?.model === arm ? (ref.id ?? null) : null]);
}

/** A literal json path (`'{"a","b"}'`): inline, so a predicate's expression is the one a path index is built on. */
export const json_path = (path: readonly string[]): string =>
	literal(`{${path.map((s) => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(',')}}`);

/** Normalize numeric wire values at comparison/SQL boundaries; dates stay ISO strings. */
export function comparable(v: Json | undefined): Json {
	return database_value(v ?? null);
}

/** A period argument whose ends cross (a dynamic end past the other): matches nothing. */
export const inverted = (f: FieldInfo, lo: unknown, hi: unknown): boolean =>
	hi !== null &&
	hi !== undefined &&
	lo !== null &&
	lo !== undefined &&
	(f.period_of === 'date'
		? String(lo) >= String(hi)
		: Date.parse(String(lo)) > Date.parse(String(hi)));

/**
 * A period column `x` against a period `span` (SQL range text): `overlaps` and `contained_by` test the whole period;
 * `starts_within` its first day or start instant; `ends_within` its last day (the day before a date range's exclusive
 * upper bound) or end instant. An unbounded end is in no span.
 */
export const period_test = (
	op: 'overlaps' | 'contained_by' | 'starts_within' | 'ends_within',
	x: string,
	span: string,
	date: boolean
): string =>
	op === 'overlaps'
		? `(${x} && ${span})`
		: op === 'contained_by'
			? `(${x} <@ ${span})`
			: op === 'starts_within'
				? `(lower(${x}) <@ ${span})`
				: date
					? `((upper(${x}) - 1) <@ ${span})`
					: `(upper(${x}) > lower(${span}) AND (upper_inf(${span}) OR upper(${x}) <= upper(${span})))`;
