// std/label (§3.7): a record's title from its model's `label` paths. Each path's value is shown per kind (`show`, the
// ui's formatter where one is at hand; else a locale-free default for dates, instants, decimals and relations), empty
// terms are dropped and the rest joined with ' · '. Never a uuid and never a JSON blob: a record that cannot name
// itself is `null`, and the caller shows its own placeholder.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

const isObject = (v: unknown): v is { readonly [k: string]: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The locale-free text of one value: an instant as `YYYY-MM-DD HH:mm` UTC (a UTC midnight as its day), a wire tag or a
 * `Decimal` as its exact text, a relation as its own `label`; anything structured is no title. */
function text(v: unknown): string | null {
	if (v === null || v === undefined) return null;
	if (isObject(v)) {
		const keys = Object.keys(v);
		if (keys.length === 1 && ['$dec', '$d', '$t'].includes(keys[0]!)) return text(v[keys[0]!]);
		if (keys.length === 0 && typeof (v as { toJSON?: unknown }).toJSON === 'function') return text((v as { toJSON(): unknown }).toJSON());
		return typeof v['label'] === 'string' ? text(v['label']) : null;
	}
	if (Array.isArray(v)) return null;
	const s = String(v).trim();
	if (s === '' || UUID.test(s) || (/^[{[]/.test(s) && isJsonContainer(s))) return null;
	if (INSTANT.test(s)) {
		const iso = new Date(s).toISOString();
		return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
	}
	return s;
}

const isJsonContainer = (s: string) => { try { return typeof JSON.parse(s) === 'object'; } catch { return false; } };

/** A dotted path's value: `customer.name` reads a relation read `with` its target. */
const at = (row: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (isObject(v) ? v[k] : undefined), row);

/**
 * A record's title from its model's `label` paths: each value shown per kind (through `show` when given), empty terms dropped,
 * the rest joined with ` · `; `null` when nothing names the record (never a uuid or JSON).
 * @example
 * label({ name: 'Ann', team: { name: 'Ops' } }, ['name', 'team.name']) // 'Ann · Ops'
 */
export function label(
	row: { readonly [field: string]: unknown },
	paths: readonly string[],
	show?: (path: string, value: unknown) => string,
): string | null {
	const terms = paths.map((p) => {
		const v = at(row, p);
		const shown = show === undefined || v === null || v === undefined ? v : show(p, v);
		return text(shown);
	}).filter((t): t is string => t !== null);
	return terms.length === 0 ? null : terms.join(' · ');
}
