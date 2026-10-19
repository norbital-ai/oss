// The node-postgres `TenantDb` used by native Postgres hosts. The host's `pg` Pool; bolt names only this shape, not the
// package. A single read and an unlocked write are named (extended protocol: parse/plan once per connection). Several
// reads stay one simple-protocol string with parameters inlined as quoted literals. A locked write PREPAREs the
// statement shape on the connection, then `BEGIN; LOCK …; EXECUTE …; COMMIT` as one simple-protocol round trip
// (rules 12, 20, 26). Each call holds one connection under the database wall; an interrupted call (the wall, or its
// caller) destroys that connection instead of returning it.
import { createHash } from 'node:crypto';
import { Duration, Effect, Exit, Layer } from 'effect';
import { LIMITS, type Rows, type Sql } from '../contracts.ts';
import type { Json } from '../../decl/values.ts';
import { DbError } from '../errors.ts';
import { TenantDb, TenantTx, type RawDb, type TenantDbShape } from './tenant-db.ts';
import { cancelled, dbError, lockStatements, param, parse } from './wire.ts';

type PgResult = { rows: { [column: string]: Json }[]; rowCount: number | null };
type PgQuery = {
	text: string;
	name?: string;
	values?: (string | null)[];
	types: { getTypeParser: (oid: number) => (s: string) => Json };
};
export type PgClient = {
	query(q: PgQuery): Promise<PgResult | PgResult[]>;
	release(destroy?: boolean): void;
	on?(event: 'error' | 'end', listener: (error?: unknown) => void): unknown;
	removeListener?(event: 'error' | 'end', listener: (error?: unknown) => void): unknown;
};
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
const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
const NONE: PgResult = { rows: [], rowCount: 0 };
const last = (r: PgResult | PgResult[]): PgResult =>
	Array.isArray(r) ? (r[r.length - 1] ?? NONE) : r;
const rowsOf = (r: PgResult): Rows => ({ rows: r.rows, affected: r.rowCount ?? r.rows.length });

/** The adapter's calls over `pool`; its statement names live as long as it does. */
function raw(pool: PgPool): RawDb {
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
	const prepared = new WeakMap<PgClient, Set<string>>();
	const query = (client: PgClient, q: PgQuery) =>
		Effect.tryPromise({ try: () => client.query(q), catch: dbError });
	const send = (client: PgClient, text: string) => query(client, { text, types });
	const rollback = (client: PgClient) =>
		send(client, 'rollback').pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
	/** Several statements, one round trip; an error leaves the explicit transaction aborted, so roll it back. */
	const batch = (client: PgClient, statements: readonly string[]) =>
		query(client, { text: statements.join(';\n'), types }).pipe(
			Effect.map((r) => (Array.isArray(r) ? r : [r])),
			Effect.tapError(() => rollback(client))
		);
	// named: each connection parses and plans a statement shape once, not per call
	const single = (client: PgClient, s: Sql) =>
		Effect.map(
			query(client, { text: s.text, name: named(s.text), values: s.params.map(param), types }),
			(r) => rowsOf(last(r))
		);
	const prepare = (client: PgClient, s: Sql): Effect.Effect<string, DbError> => {
		const name = named(s.text),
			have = prepared.get(client) ?? new Set<string>();
		if (have.has(name)) return Effect.succeed(name);
		return send(client, `prepare ${ident(name)} as ${s.text}`).pipe(
			Effect.catch((e) => (e.sqlstate === '42P05' ? Effect.void : Effect.fail(e))), // prepared on this connection already
			Effect.andThen(Effect.sync(() => (have.add(name), prepared.set(client, have), name)))
		);
	};
	const execute = (name: string, s: Sql) =>
		s.params.length === 0
			? `execute ${ident(name)}`
			: `execute ${ident(name)}(${s.params.map(literal).join(', ')})`;
	/** One call on one connection under the database wall; the connection is destroyed when the call is interrupted. */
	const call = <A, E, R>(
		body: (client: PgClient) => Effect.Effect<A, E, R>
	): Effect.Effect<A, E | DbError, R> =>
		Effect.scoped(
			Effect.flatMap(
				Effect.acquireRelease(
					Effect.tryPromise({ try: () => pool.connect(), catch: dbError }),
					(client, exit) => Effect.sync(() => client.release(Exit.hasInterrupts(exit)))
				),
				body
			)
		).pipe(
			Effect.timeoutOrElse({
				duration: Duration.millis(LIMITS.callMs.database),
				orElse: () => Effect.fail(cancelled())
			})
		);
	return {
		read: (statements) =>
			call((client) => {
				const [first] = statements;
				if (statements.length === 1 && first !== undefined)
					return Effect.map(single(client, first), (r) => [r]);
				return Effect.try({ try: () => statements.map(inline), catch: dbError }).pipe(
					Effect.flatMap((texts) =>
						batch(client, ['begin isolation level repeatable read read only', ...texts, 'commit'])
					),
					Effect.map((r) => r.slice(1, -1).map(rowsOf))
				);
			}),
		write: (statement, lock) =>
			call((client) => {
				const locks = lockStatements(lock);
				if (locks.length === 0) return single(client, statement);
				return prepare(client, statement).pipe(
					Effect.flatMap((name) =>
						batch(client, ['begin', ...locks, execute(name, statement), 'commit'])
					),
					Effect.map((r) => rowsOf(r[r.length - 2] ?? NONE))
				);
			}),
		transaction: (body, lock) =>
			call((client) =>
				Effect.acquireUseRelease(
					send(client, 'begin'),
					() =>
						Effect.forEach(lockStatements(lock), (text) => send(client, text), {
							discard: true
						}).pipe(
							Effect.andThen(
								body.pipe(Effect.provideService(TenantTx, { query: (s) => single(client, s) }))
							),
							Effect.tap(() => send(client, 'commit'))
						),
					// interrupted: the call destroys the connection, and the server rolls back what it held
					(_, exit) =>
						Exit.isFailure(exit) && !Exit.hasInterrupts(exit) ? rollback(client) : Effect.void
				)
			)
	};
}

export const PostgresDb = {
	/** The adapter over a pool the host keeps (a multi-workspace host shares its pool across a cell's work). */
	make: (pool: PgPool): TenantDbShape => TenantDb.typed(raw(pool)),
	/** The host owns the pool; each query owns its connection. */
	layer: (pool: PgPool): Layer.Layer<TenantDb> =>
		Layer.sync(TenantDb, () => TenantDb.typed(raw(pool)))
};
