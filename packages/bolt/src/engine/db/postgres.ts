// The node-postgres `TenantDb` (bolt-server). The host passes its `pg` Pool; bolt names only this shape, not the
// package. `read` and `write` are one round trip each: several statements go as one simple-protocol string with the
// parameters inlined as quoted literals (typed `unknown`, exactly as a text-format parameter is), which is the only way
// node-postgres sends `BEGIN; LOCK …; <statement>; COMMIT` without four round trips (rules 12, 20, 26).
import { createHash } from 'node:crypto';
import { DbError, LIMITS, type Lock, type Rows, type Sql, type TenantDb } from '../contracts.ts';
import type { Json } from '../../decl/values.ts';
import { dbError, lockStatements, param, parse } from './wire.ts';

type PgResult = { rows: { [column: string]: Json }[]; rowCount: number | null };
type PgQuery = { text: string; name?: string; values?: (string | null)[]; types: { getTypeParser: (oid: number) => (s: string) => Json } };
export type PgClient = { query(q: PgQuery): Promise<PgResult | PgResult[]>; release(destroy?: boolean): void };
export type PgPool = { connect(): Promise<PgClient> };

const types = { getTypeParser: (oid: number) => (s: string) => parse(oid, s) };
const literal = (v: Json): string => {
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
		if (m === null) { out += c; continue; }
		const n = Number(m[1]);
		if (n < 1 || n > s.params.length) throw new DbError('08P01', `parameter $${n} has no value`);
		out += literal(s.params[n - 1] as Json);
		i += (m[0] as string).length - 1;
	}
	return out;
}
const names = new Map<string, string>();
const named = (text: string): string => {
	let name = names.get(text);
	if (name === undefined) {
		name = `b${createHash('sha1').update(text).digest('base64url')}`;
		if (names.size >= 10_000) names.clear(); // ponytail: shapes are finite per artifact; an LRU if this churns
		names.set(text, name);
	}
	return name;
};
const rows = (r: PgResult): Rows => ({ rows: r.rows, affected: r.rowCount ?? r.rows.length });

export function postgresDb(pool: PgPool): TenantDb {
	/** One call on one connection under the database wall; a timed-out or aborted connection is destroyed, not reused. */
	async function call<T>(signal: AbortSignal | undefined, body: (client: PgClient) => Promise<T>): Promise<T> {
		const client = await pool.connect().catch((e: unknown) => { throw dbError(e); });
		const wall = AbortSignal.any([AbortSignal.timeout(LIMITS.callMs.database), ...(signal === undefined ? [] : [signal])]);
		let destroy = false;
		try {
			return await new Promise<T>((resolve, reject) => {
				wall.addEventListener('abort', () => { destroy = true; reject(new DbError('57014', 'the database call was cancelled at its wall')); }, { once: true });
				body(client).then(resolve, reject);
			});
		} finally {
			client.release(destroy);
		}
	}
	/** Several statements, one round trip; an error leaves the explicit transaction aborted, so roll it back. */
	async function batch(client: PgClient, statements: readonly string[]): Promise<PgResult[]> {
		try {
			const r = await client.query({ text: statements.join(';\n'), types });
			return Array.isArray(r) ? r : [r];
		} catch (e) {
			await client.query({ text: 'rollback', types }).catch(() => undefined);
			throw dbError(e);
		}
	}
	const send = (client: PgClient, text: string) => client.query({ text, types }).catch((e: unknown) => { throw dbError(e); });
	// named: each connection parses and plans a statement shape once, not per call
	const single = (client: PgClient, s: Sql) => client.query({ text: s.text, name: named(s.text), values: s.params.map(param), types })
		.then((r) => rows(Array.isArray(r) ? r[r.length - 1] as PgResult : r), (e: unknown) => { throw dbError(e); });
	return {
		read: (statements, signal) => call(signal, async (client) => {
			if (statements.length === 1) return [await single(client, statements[0] as Sql)];
			const r = await batch(client, ['begin isolation level repeatable read read only', ...statements.map(inline), 'commit']);
			return r.slice(1, -1).map(rows);
		}),
		write: (statement, lock?: Lock, signal?: AbortSignal) => call(signal, async (client) => {
			const r = await batch(client, ['begin', ...lockStatements(lock), inline(statement), 'commit']);
			return rows(r[r.length - 2] as PgResult);
		}),
		transaction: (body, lock) => call(undefined, async (client) => {
			await send(client, 'begin');
			try {
				for (const text of lockStatements(lock)) await send(client, text);
				const out = await body({ query: (s) => single(client, s) });
				await send(client, 'commit');
				return out;
			} catch (e) {
				await client.query({ text: 'rollback', types }).catch(() => undefined);
				throw e;
			}
		}),
	};
}
