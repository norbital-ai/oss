// A scratch PGlite and the executor a host pairs the store with: one statement in, its rows out as JSON.
import { PGlite } from '@electric-sql/pglite';
import { Effect, Scope } from 'effect';
import type { Json } from '../src/values.ts';
import type { ResultRow, Sql, Statement, StoreError } from '../src/index.ts';

class DbFailed extends Error {}
export const required = <A>(value: A | undefined): A => {
	if (value === undefined) throw new Error('fixture row missing');
	return value;
};
/** A driver value as the store's JSON: a count's bigint as a number, a timestamp as ISO text. */
const json = (v: unknown): Json =>
	v === null || v === undefined
		? null
		: typeof v === 'bigint'
			? Number(v)
			: v instanceof Date
				? v.toISOString()
				: Array.isArray(v)
					? v.map(json)
					: typeof v === 'object'
						? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, json(x)]))
						: typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
							? v
							: String(v);
const param = (v: Json): string | number | boolean | null =>
	v === null || typeof v !== 'object' ? v : JSON.stringify(v);

export const database: Effect.Effect<PGlite, never, Scope.Scope> = Effect.acquireRelease(
	Effect.promise(async () => {
		const pg = await PGlite.create();
		await pg.exec(`set time zone 'UTC'`);
		return pg;
	}),
	(pg) => Effect.promise(() => pg.close())
);
export const exec =
	(pg: PGlite) =>
	(s: Sql): Effect.Effect<readonly ResultRow[]> =>
		Effect.promise(() =>
			pg
				.query<{ readonly [k: string]: unknown }>(s.text, s.params.map(param))
				.catch((e: unknown) => {
					throw new DbFailed(`${e instanceof Error ? e.message : String(e)}\n${s.text}`);
				})
		).pipe(
			Effect.map((r) =>
				r.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, json(v)])))
			)
		);
/** Many statements as one script (DDL, a migration file). */
export const script = (pg: PGlite, sql: string): Effect.Effect<void> =>
	Effect.promise(() => pg.exec(sql).then(() => undefined));
/** Execute a statement and decode its answer. */
export const run =
	(pg: PGlite) =>
	<A>(st: Statement<A>): Effect.Effect<A, StoreError> =>
		Effect.flatMap(exec(pg)(st.sql), st.decode);
