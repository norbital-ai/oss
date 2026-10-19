// The PGlite `TenantDb` (bolt dev, the test kit). In process, so a "round trip" is a call; there is no wire to bound.
// ponytail: no 60 s wall here (PGlite cannot cancel a running statement); the Postgres adapter carries it.
// Every call is one PGlite transaction: the only way to hold its connection exclusively.
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { vector } from '@electric-sql/pglite-pgvector';
import { Context, Effect, Layer, type Scope } from 'effect';
import type { Lock, Rows, Sql } from '../contracts.ts';
import type { DbError } from '../errors.ts';
import { callbackTransaction, TenantDb, type TenantDbShape } from './tenant-db.ts';
import { dbError, lockStatements, param, parse, PARSED_OIDS } from './wire.ts';

/** Native driver calls only: each release creates its own Effect adapter and database failures. */
export type PgliteClient = {
	query<Row>(text: string, params?: unknown[]): Promise<{ rows: Row[]; affectedRows?: number }>;
	transaction<A>(body: (tx: Pick<PgliteClient, 'query'>) => Promise<A>): Promise<A>;
};
/** A native data directory may be initialized from a dump; reopening uses that same directory. */
export type PgliteSource =
	string | Blob | { readonly dataDir: string; readonly loadDataDir?: Blob };
type Querier = Pick<PgliteClient, 'query'>;
const parsers = Object.fromEntries(PARSED_OIDS.map((oid) => [oid, (s: string) => parse(oid, s)]));
const extensions = { vector, btree_gist };

async function run(db: Querier, s: Sql): Promise<Rows> {
	const r = await db.query<Rows['rows'][number]>(s.text, s.params.map(param));
	return { rows: r.rows, affected: r.affectedRows ?? r.rows.length };
}
async function locked(tx: Querier, lock: Lock | undefined): Promise<void> {
	for (const text of lockStatements(lock)) await run(tx, { text, params: [] });
}
const closed = (pg: PGlite) =>
	Effect.tryPromise({ try: () => pg.close(), catch: dbError }).pipe(
		Effect.uninterruptible,
		Effect.tapCause(Effect.logWarning),
		Effect.orDie
	);
const dump = Effect.acquireUseRelease(
	Effect.tryPromise({ try: () => PGlite.create({ extensions }), catch: dbError }),
	(pg) =>
		Effect.tryPromise({ try: () => pg.dumpDataDir('none'), catch: dbError }).pipe(
			Effect.uninterruptible
		),
	closed
);
let pristineDump: Effect.Effect<Blob, DbError> | undefined;
const pristine = Effect.suspend(() =>
	pristineDump === undefined
		? Effect.map(Effect.cached(dump), (cached) => (pristineDump ??= cached))
		: Effect.succeed(pristineDump)
);

/** One initdb per process: an in-memory database starts from this dump (~4× faster than a fresh cluster). */
export class Pristine extends Context.Service<Pristine, Effect.Effect<Blob, DbError>>()(
	'bolt/PglitePristine'
) {
	static readonly layer = Layer.effect(Pristine, pristine);
}

/**
 * A PGlite with the extensions the schema may name (vector, btree_gist), in UTC: fresh, at a directory, or a copy of a
 * `pg.dumpDataDir()` (a test suite seeds once and copies the seeded database per test).
 */
const create = (from: PgliteSource | undefined): Effect.Effect<PGlite, DbError, Pristine> =>
	Effect.gen(function* () {
		const at =
			from === undefined
				? { loadDataDir: yield* yield* Pristine }
				: typeof from === 'string'
					? { dataDir: from }
					: 'dataDir' in from
						? from
						: { loadDataDir: from };
		const pg = yield* Effect.tryPromise({
			try: () => PGlite.create({ ...at, extensions, parsers }),
			catch: dbError
		});
		return pg;
	});

export const PgliteDb = {
	/** The adapter over an open PGlite (its session zone must be UTC; `open` sets it). */
	make: (pg: PgliteClient): TenantDbShape => {
		// `run` converted the driver's failures; PGlite's own BEGIN/COMMIT failures are converted here
		// A native statement cannot be cancelled: scope cleanup must wait for its COMMIT/ROLLBACK.
		const exclusive = <A>(body: (tx: Querier) => Promise<A>) =>
			Effect.tryPromise({ try: () => pg.transaction(body), catch: dbError }).pipe(
				Effect.uninterruptible
			);
		return TenantDb.typed({
			read: (statements) =>
				exclusive(async (tx) => {
					const out: Rows[] = [];
					for (const s of statements) out.push(await run(tx, s));
					return out;
				}),
			write: (statement, lock) =>
				exclusive(async (tx) => (await locked(tx, lock), run(tx, statement))),
			transaction: <A, E, R>(body: Effect.Effect<A, E, R>, lock?: Lock) =>
				callbackTransaction<Querier, A, E, R>(
					(callback) => pg.transaction(async (tx) => (await locked(tx, lock), callback(tx))),
					(tx: Querier) => ({
						query: (s) =>
							Effect.tryPromise({ try: () => run(tx, s), catch: dbError }).pipe(
								Effect.uninterruptible
							)
					}),
					body
				)
		});
	},
	/** Scope-owned PGlite; close settles uninterruptibly and an uncertain close remains a canonical DbError defect. */
	open: (from?: PgliteSource): Effect.Effect<PGlite, DbError, Pristine | Scope.Scope> =>
		Effect.acquireRelease(create(from), closed).pipe(
			Effect.tap((pg) =>
				Effect.tryPromise({ try: () => pg.exec(`set time zone 'UTC'`), catch: dbError }).pipe(
					Effect.uninterruptible
				)
			)
		),
	layer: (from?: PgliteSource): Layer.Layer<TenantDb, DbError> =>
		Layer.effect(TenantDb, Effect.map(PgliteDb.open(from), PgliteDb.make)).pipe(
			Layer.provide(Pristine.layer)
		)
};
