// Pooled scratch PGlite instances and the executor a host pairs the store with: one statement in, its rows out as JSON.
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { Effect, Scope } from 'effect';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

/** Every schema a test can create, dropped with whatever it holds (tables, types, functions, extensions). */
const EMPTY = `reset all;
set time zone 'UTC';
do $$ declare s text; begin
	for s in select nspname from pg_namespace
		where nspname not in ('pg_catalog', 'information_schema') and nspname not like 'pg\\_%'
	loop execute format('drop schema %I cascade', s); end loop;
end $$;
create schema public;`;
const extensions = { btree_gist, pg_trgm };
/** initdb once per machine and PGlite build (~2 s); every boot loads this dump instead (~0.15 s). */
const initdb = async () => {
	const path = createRequire(import.meta.url).resolve('@electric-sql/pglite'),
		info = await stat(path);
	const file = join(
		tmpdir(),
		'norbital-pglite',
		`store-${createHash('sha256').update(`${path}\0${info.size}\0${info.mtimeMs}`).digest('hex')}.tar`
	);
	const kept = await readFile(file).catch(() => undefined);
	if (kept !== undefined) return new Blob([new Uint8Array(kept)]);
	const pg = await PGlite.create({ extensions });
	const dump = await pg.dumpDataDir('none');
	await pg.close();
	// written whole, then renamed: a parallel worker never reads half a dump
	const temporary = `${file}.${randomUUID()}`;
	await mkdir(dirname(file), { recursive: true });
	await writeFile(temporary, new Uint8Array(await dump.arrayBuffer()));
	await rename(temporary, file);
	return dump;
};
let pristine: Promise<Blob> | undefined;
// ponytail: instances live until the worker exits; a boot costs 0.15 s, emptying one milliseconds.
const idle: PGlite[] = [];
/** A scratch PGlite (btree_gist and pg_trgm available), empty and in UTC; one boots per concurrent use in a file and is reused. */
export const database: Effect.Effect<PGlite, never, Scope.Scope> = Effect.acquireRelease(
	Effect.promise(async () => {
		const pg =
			idle.pop() ??
			(await PGlite.create({ loadDataDir: await (pristine ??= initdb()), extensions }));
		await pg.exec(EMPTY);
		return pg;
	}),
	(pg) => Effect.sync(() => void idle.push(pg))
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
