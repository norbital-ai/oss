// What both `TenantDb` adapters share: values cross as JSON, so every row
// value is parsed from Postgres text the same way on PGlite and node-postgres, and every parameter is sent as text.
import { Predicate } from 'effect';
import * as EffectArray from 'effect/Array';
import type { DbBatch } from './tenant-db.ts';
import type { Json } from '../../decl/values.ts';
import type { Lock, Sql } from '../contracts.ts';
import { DbError } from '../errors.ts';

const q = (id: string): string => `"${id.replaceAll('"', '""')}"`;
const int = (s: string): Json => (Number.isSafeInteger(Number(s)) ? Number(s) : s);
/** ISO in UTC; microseconds are kept when the session zone is UTC (both adapters set it), else rounded to ms. */
const instant = (s: string): Json => {
	if (!/^\d/.test(s)) return s; // infinity
	const iso = s.replace(' ', 'T');
	return iso.endsWith('+00')
		? `${iso.slice(0, -3)}Z`
		: new Date(iso.replace(/([+-]\d\d)$/, '$1:00')).toISOString();
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
/** The server's json text: JSON by construction. */
const json = (s: string): Json => JSON.parse(s);
const SCALAR: { readonly [oid: number]: (s: string) => Json } = {
	16: (s) => s === 't',
	20: int,
	21: int,
	23: int,
	700: Number,
	701: Number,
	114: json,
	3802: json,
	1114: (s) => s.replace(' ', 'T'),
	1184: instant
};
const ARRAY: { readonly [oid: number]: number } = {
	1000: 16,
	1005: 21,
	1007: 23,
	1016: 20,
	1009: 25,
	1015: 1043,
	2951: 2950,
	1182: 1082,
	1185: 1184,
	3807: 3802
};
/** Postgres text → JSON: numbers and booleans as JSON, json as itself, everything else (numeric, date, uuid, ranges) as text. */
export function parse(oid: number, s: string): Json {
	const el = ARRAY[oid];
	if (el !== undefined) return array(s, SCALAR[el] ?? text);
	return (SCALAR[oid] ?? text)(s);
}
/** The OIDs whose parse is not identity (PGlite takes these as its `parsers`; its default for the rest is text). */
export const PARSED_OIDS: readonly number[] = [
	...Object.keys(SCALAR),
	...Object.keys(ARRAY),
	1082,
	1083,
	1700
].map(Number);

/** A JSON parameter as Postgres text: objects and arrays as JSON text (the statement casts). */
export const param = (v: Json): string | null =>
	v === null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v);

/** Server-side bounds stay below the adapter's 20-second whole-call wall. */
// one statement, so each batch pays one round trip for its transaction-local limits
export const DATABASE_SETTINGS: readonly string[] = Object.freeze([
	"select set_config('lock_timeout', '5s', true), set_config('statement_timeout', '15s', true), set_config('idle_in_transaction_session_timeout', '5s', true)"
]);

const copiedJson = (value: Json): Json => {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (EffectArray.isArray<typeof value>(value)) return Array.from(value, copiedJson);
	if (typeof value === 'object')
		return Object.fromEntries(
			Object.entries<Json>(value).map(([key, item]) => [key, copiedJson(item)])
		);
	throw DbError.make('22023', 'a database parameter must be JSON');
};
/** Snapshot all caller-owned values before acquiring a connection, including nested parameter getters. */
export const copiedSql = (statement: Sql): Sql => {
	const text = statement.text;
	if (typeof text !== 'string') throw DbError.make('22023', 'a database statement needs SQL text');
	return { text, params: Array.from(statement.params, copiedJson) };
};
export const copiedBatch = (batch: DbBatch): DbBatch => {
	const statements = Array.from(batch.statements, copiedSql);
	// A schema plan is one batch of DDL (native rules add several objects per table); the byte bound below is the
	// real limit on work, so the statement bound only stops an unbounded list.
	if (statements.length > 4_000)
		throw DbError.make('54000', 'a database batch exceeds 4000 statements');
	const bytes = statements.reduce(
		(total, statement) =>
			total +
			new TextEncoder().encode(statement.text).byteLength +
			new TextEncoder().encode(JSON.stringify(statement.params)).byteLength,
		0
	);
	if (bytes > 64 * 1024 * 1024) throw DbError.make('54000', 'a database batch exceeds 64 MiB');
	const lock = batch.lock;
	const tables = lock?.tables;
	const advisory = lock?.advisory;
	const mode = lock?.mode;
	const rollback = batch.rollback;
	if (mode !== undefined && mode !== 'SHARE ROW EXCLUSIVE')
		throw DbError.make('22023', 'an unsupported database lock mode was requested');
	if (rollback !== undefined && rollback !== true)
		throw DbError.make('22023', 'a database dry-run uses rollback: true');
	const copiedName = (name: string): string => {
		if (typeof name !== 'string') throw DbError.make('22023', 'a database lock needs string names');
		return name;
	};
	return {
		statements,
		...(lock === undefined
			? {}
			: {
					lock: {
						...(tables === undefined ? {} : { tables: Array.from(tables, copiedName) }),
						...(advisory === undefined ? {} : { advisory: Array.from(advisory, copiedName) }),
						...(mode === undefined ? {} : { mode })
					}
				}),
		...(rollback === true ? { rollback: true } : {})
	};
};

/** `lock table … ; select pg_advisory_xact_lock(…)`, sorted (rule 26: one global order, no deadlock). */
export function lockStatements(lock: Lock | undefined): string[] {
	if (lock === undefined) return [];
	const tables = [...(lock.tables ?? [])].sort();
	return [
		...(tables.length === 0
			? []
			: [`lock table ${tables.map(q).join(', ')} in ${lock.mode ?? 'SHARE ROW EXCLUSIVE'} mode`]),
		...[...(lock.advisory ?? [])]
			.sort()
			.map((k) => `select pg_advisory_xact_lock(hashtext('${k.replaceAll("'", "''")}'))`)
	];
}

/** A driver failure as a `DbError`: a SQLSTATE when the server gave one, else a connection failure. Call it only on
 * what the driver threw, never on an error the caller's own code raised inside a transaction. */
export function dbError(e: unknown): DbError {
	if (e instanceof DbError) return e;
	const field = (key: string): unknown => (Predicate.isObject(e) ? e[key] : undefined);
	// a driver's error names its SQLSTATE `code`; a DbError of another copy (another module graph, or one that crossed
	// into a cell) keeps its own `sqlstate`
	const message = field('message'),
		code = field('sqlstate') ?? field('code'),
		constraint = field('constraint'),
		column = field('column');
	return DbError.make(
		Predicate.isString(code) && /^[0-9A-Z]{5}$/.test(code) ? code : '08006',
		Predicate.isString(message) ? message : String(e),
		Predicate.isString(constraint) ? constraint : undefined,
		Predicate.isString(column) ? column : undefined
	);
}
/** What a call the database wall (or its caller) cancelled fails with: `refusalOf` answers it `timeout`. */
export const cancelled = (): DbError =>
	DbError.make('57014', 'the database call was cancelled at its wall');

export const literal = (v: Json): string => {
	const p = param(v);
	return p === null ? 'null' : `'${p.replaceAll("'", "''")}'`;
};
/** `$n` → its literal, outside quoted strings and identifiers. Needs `standard_conforming_strings` (the default). */
export function inline(s: Sql): string {
	if (s.params.length === 0) return s.text;
	let out = '';
	for (let i = 0; i < s.text.length; i++) {
		const c = s.text[i] as string;
		if (c === "'" || c === '"') {
			const end = s.text.indexOf(c, i + 1);
			out += s.text.slice(i, end + 1);
			i = end;
			continue;
		}
		const m = c === '$' ? /^\$(\d+)/.exec(s.text.slice(i)) : null;
		if (m === null) {
			out += c;
			continue;
		}
		const n = Number(m[1]);
		if (n < 1 || n > s.params.length) throw DbError.make('08P01', `parameter $${n} has no value`);
		out += literal(s.params[n - 1] as Json);
		i += (m[0] as string).length - 1;
	}
	return out;
}
