// What both `TenantDb` adapters share (memory `pod-db-adapters-must-emit-json`): values cross as JSON, so every row
// value is parsed from Postgres text the same way on PGlite and node-postgres, and every parameter is sent as text.
import type { Json } from '../../decl/values.ts';
import { DbError, type Lock } from '../contracts.ts';

const q = (id: string): string => `"${id.replaceAll('"', '""')}"`;
const int = (s: string): Json => (Number.isSafeInteger(Number(s)) ? Number(s) : s);
/** ISO in UTC; microseconds are kept when the session zone is UTC (both adapters set it), else rounded to ms. */
const instant = (s: string): Json => {
	if (!/^\d/.test(s)) return s; // infinity
	const iso = s.replace(' ', 'T');
	return iso.endsWith('+00') ? `${iso.slice(0, -3)}Z` : new Date(iso.replace(/([+-]\d\d)$/, '$1:00')).toISOString();
};

/** A one-dimensional array literal (`{a,"b c",NULL}`), the only arrays the schema declares. */
function array(s: string, each: (x: string) => Json): Json {
	const out: Json[] = [];
	let i = 1;
	while (i < s.length - 1) {
		let v = '';
		let quoted = false;
		if (s[i] === '"') {
			quoted = true;
			for (i++; s[i] !== '"'; i++) v += s[i] === '\\' ? s[++i] : s[i];
			i++;
		} else for (; s[i] !== ',' && i < s.length - 1; i++) v += s[i];
		out.push(!quoted && v === 'NULL' ? null : each(v));
		i++;
	}
	return out;
}
const text = (s: string): Json => s;
const SCALAR: { readonly [oid: number]: (s: string) => Json } = {
	16: (s) => s === 't', 20: int, 21: int, 23: int, 700: Number, 701: Number,
	114: (s) => JSON.parse(s) as Json, 3802: (s) => JSON.parse(s) as Json,
	1114: (s) => s.replace(' ', 'T'), 1184: instant,
};
const ARRAY: { readonly [oid: number]: number } = { 1000: 16, 1005: 21, 1007: 23, 1016: 20, 1009: 25, 1015: 1043, 2951: 2950, 1182: 1082, 1185: 1184, 3807: 3802 };
/** Postgres text → JSON: numbers and booleans as JSON, json as itself, everything else (numeric, date, uuid, ranges) as text. */
export function parse(oid: number, s: string): Json {
	const el = ARRAY[oid];
	if (el !== undefined) return array(s, SCALAR[el] ?? text);
	return (SCALAR[oid] ?? text)(s);
}
/** The OIDs whose parse is not identity (PGlite takes these as its `parsers`; its default for the rest is text). */
export const PARSED_OIDS: readonly number[] = [...Object.keys(SCALAR), ...Object.keys(ARRAY), 1082, 1083, 1700].map(Number);

/** A JSON parameter as Postgres text: objects and arrays as JSON text (the statement casts). */
export const param = (v: Json): string | null => (v === null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** `lock table … ; select pg_advisory_xact_lock(…)`, sorted (rule 26: one global order, no deadlock). */
export function lockStatements(lock: Lock | undefined): string[] {
	if (lock === undefined) return [];
	const tables = [...(lock.tables ?? [])].sort();
	return [
		...(tables.length === 0 ? [] : [`lock table ${tables.map(q).join(', ')} in ${lock.mode ?? 'SHARE ROW EXCLUSIVE'} mode`]),
		...[...(lock.advisory ?? [])].sort().map((k) => `select pg_advisory_xact_lock(hashtext('${k.replaceAll("'", "''")}'))`),
	];
}

/** A driver failure as a `DbError`: a SQLSTATE when the server gave one, else a connection failure. Call it only on
 * what the driver threw, never on an error the caller's own code raised inside a transaction. */
export function dbError(e: unknown): DbError {
	if (e instanceof DbError) return e;
	const x = (e ?? {}) as { code?: unknown; constraint?: unknown; message?: unknown };
	const message = typeof x.message === 'string' ? x.message : String(e);
	const code = typeof x.code === 'string' && /^[0-9A-Z]{5}$/.test(x.code) ? x.code : '08006';
	return new DbError(code, message, typeof x.constraint === 'string' ? x.constraint : undefined);
}
