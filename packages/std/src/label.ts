// std/label (§3.7): a record's title from its model's `label` paths. Each path's value is shown per kind (`show`, the
// ui's formatter where one is at hand; else a locale-free default for dates, instants, decimals and relations), empty
// terms are dropped and the rest joined with ' · '. Never a uuid and never a JSON blob: a record that cannot name
// itself is `null`, and the caller shows its own placeholder.
import { parseJsonResult } from './json.ts';
import { Decimal } from './decimal.ts';
import type { Value } from './kind.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The locale-free text of one value: an instant as `YYYY-MM-DD HH:mm` UTC (a UTC midnight as its day), a `Decimal` as its exact text, a relation as its own `label`; anything structured is no title. */
function text(v: Value | undefined): string | null {
	if (v === null || v === undefined) return null;
	if (v instanceof Decimal) return text(v.toString());
	if (typeof v === 'object') {
		const own = members(v)?.['label'];
		return typeof own === 'string' ? text(own) : null;
	}
	const s = String(v).trim();
	if (s === '' || UUID.test(s) || (/^[{[]/.test(s) && isJsonContainer(s))) return null;
	if (INSTANT.test(s)) {
		const iso = new Date(s).toISOString();
		return iso.endsWith('T00:00:00.000Z')
			? iso.slice(0, 10)
			: `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
	}
	return s;
}

const isJsonContainer = (s: string) => {
	const result = parseJsonResult(s);
	return result._tag === 'Success' && typeof result.success === 'object';
};

const isList = (v: Value): v is readonly Value[] => Array.isArray(v);
/** A structured value's members: a relation read `with` its target; a scalar, decimal or list has none. */
const members = (v: Value | undefined) =>
	v === null || v === undefined || typeof v !== 'object' || v instanceof Decimal || isList(v)
		? undefined
		: v;

/** A dotted path's value: `customer.name` reads a relation read `with` its target. */
const at = (row: Value, path: string): Value | undefined =>
	path.split('.').reduce<Value | undefined>((v, k) => members(v)?.[k], row);

/**
 * A record's title from its model's `label` paths: each value shown per kind (through `show` when given), empty terms dropped,
 * the rest joined with ` · `; `null` when nothing names the record (never a uuid or JSON).
 * @example
 * label({ name: 'Ann', team: { name: 'Ops' } }, ['name', 'team.name']) // 'Ann · Ops'
 */
export function label(
	row: { readonly [field: string]: Value },
	paths: readonly string[],
	show?: (path: string, value: Value) => string
): string | null {
	const terms = paths
		.map((p) => {
			const v = at(row, p);
			return text(show === undefined || v === null || v === undefined ? v : show(p, v));
		})
		.filter((t): t is string => t !== null);
	return terms.length === 0 ? null : terms.join(' · ');
}
