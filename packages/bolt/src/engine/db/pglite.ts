// The PGlite `TenantDb` (bolt dev, the test kit). In process, so a "round trip" is a call; there is no wire to bound.
// ponytail: no 60 s wall here (PGlite cannot cancel a running statement); the Postgres adapter carries it.
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { vector } from '@electric-sql/pglite-pgvector';
import type { Lock, Rows, Sql, TenantDb, TenantTx } from '../contracts.ts';
import { dbError, lockStatements, param, parse, PARSED_OIDS } from './wire.ts';

type Querier = Pick<Transaction, 'query'>;
const parsers = Object.fromEntries(PARSED_OIDS.map((oid) => [oid, (s: string) => parse(oid, s)]));

async function run(db: Querier, s: Sql): Promise<Rows> {
	try {
		const r = await db.query<Rows['rows'][number]>(s.text, s.params.map(param));
		return { rows: r.rows, affected: r.affectedRows ?? r.rows.length };
	} catch (e) {
		throw dbError(e);
	}
}
async function locked(tx: Querier, lock: Lock | undefined): Promise<void> {
	for (const text of lockStatements(lock)) await run(tx, { text, params: [] });
}

/** Wraps an open PGlite (session zone must be UTC; `openPglite` sets it). */
export function pgliteDb(pg: PGlite): TenantDb {
	// `run` already converted the driver's errors; anything else is the body's own and passes through
	const transaction = <T>(body: (tx: Querier) => Promise<T>): Promise<T> => pg.transaction((tx) => body(tx));
	return {
		read: (statements) => transaction(async (tx) => {
			const out: Rows[] = [];
			for (const s of statements) out.push(await run(tx, s));
			return out;
		}),
		write: (statement, lock) => transaction(async (tx) => (await locked(tx, lock), run(tx, statement))),
		transaction: (body, lock) => transaction(async (tx) => {
			await locked(tx, lock);
			const t: TenantTx = { query: (s) => run(tx, s) };
			return body(t);
		}),
	};
}

const extensions = { vector, btree_gist };
/** One initdb per process: an in-memory database starts from its dump (~4× faster than a fresh cluster). */
let pristine: Promise<Blob> | undefined;

/**
 * A PGlite with the extensions the schema may name (vector, btree_gist), in UTC: fresh, at a directory, or a copy of a
 * `pg.dumpDataDir()` (a test suite seeds once and copies the seeded database per test).
 */
export async function openPglite(from?: string | Blob): Promise<{ db: TenantDb; pg: PGlite }> {
	const at = from === undefined
		? { loadDataDir: await (pristine ??= PGlite.create({ extensions }).then(async (pg) => { const dump = await pg.dumpDataDir('none'); await pg.close(); return dump; })) }
		: typeof from === 'string' ? { dataDir: from } : { loadDataDir: from };
	const pg = await PGlite.create({ ...at, extensions, parsers });
	await pg.exec(`set time zone 'UTC'`);
	return { db: pgliteDb(pg), pg };
}
