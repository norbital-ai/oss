// The PGlite `TenantDb` (bolt dev, the test kit). In process, so a "round trip" is a call; there is no wire to bound.
// Every call is a complete SQL batch in one PGlite transaction, the only way to hold its connection exclusively.
// The 20 s wall requests rollback between native statements. A running WASM statement cannot be forcibly cancelled;
// interruption waits for its native transaction to settle before the database can be released.
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { vector } from '@electric-sql/pglite-pgvector';
import { Context, Duration, Effect, Layer, Schema, type Scope } from 'effect';
import { LIMITS, type Rows, type Sql } from '../../engine/contracts.ts';
import { DbError } from '../../engine/errors.ts';
import { TenantDb, type DbBatch, type TenantDbShape } from '../../engine/db/tenant-db.ts';
import {
	cancelled,
	copiedBatch,
	DATABASE_SETTINGS,
	dbError,
	lockStatements,
	param,
	parse,
	PARSED_OIDS
} from '../../engine/db/wire.ts';

/** Native driver calls only: each release creates its own Effect adapter and database failures. */
export type PgliteClient = {
	query<Row>(text: string, params?: unknown[]): Promise<{ rows: Row[]; affectedRows?: number }>;
	/** Parameter-free migration scripts use PostgreSQL's simple protocol. */
	exec?(text: string): Promise<{ rows: unknown[]; affectedRows?: number }[]>;
	transaction<A>(body: (tx: Pick<PgliteClient, 'query' | 'exec'>) => Promise<A>): Promise<A>;
};
/** A native data directory may be initialized from a dump; reopening uses that same directory. */
export type PgliteSource =
	string | Blob | { readonly dataDir: string; readonly loadDataDir?: Blob };
type Querier = Pick<PgliteClient, 'query' | 'exec'>;
const parsers = Object.fromEntries(PARSED_OIDS.map((oid) => [oid, (s: string) => parse(oid, s)]));
const extensions = { vector, btree_gist };
const rowsOf = Schema.decodeUnknownSync(Schema.Array(Schema.Record(Schema.String, Schema.Json)));

type NativeSql = { readonly text: string; readonly params: (string | null)[] };
type NativeRows = { readonly rows: readonly unknown[]; readonly affected: number | undefined };
const nativeSql = (statement: Sql): NativeSql => ({
	text: statement.text,
	params: statement.params.map(param)
});
class RolledBack {
	readonly rows: readonly NativeRows[];
	constructor(rows: readonly NativeRows[]) {
		this.rows = rows;
	}
}
async function run(db: Querier, s: NativeSql): Promise<NativeRows> {
	if (s.params.length === 0 && db.exec !== undefined) {
		const result = await db.exec(s.text);
		const last = result.at(-1);
		return { rows: last?.rows ?? [], affected: last?.affectedRows };
	}
	const r = await db.query<unknown>(s.text, s.params);
	return { rows: r.rows, affected: r.affectedRows };
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
		const exclusive = (batch: DbBatch): Effect.Effect<readonly Rows[], DbError> =>
			Effect.try({
				try: () => {
					const prepared = copiedBatch(batch);
					return {
						statements: prepared.statements.map(nativeSql),
						setup: [...DATABASE_SETTINGS, ...lockStatements(prepared.lock)].map((text) =>
							nativeSql({ text, params: [] })
						),
						rollback: prepared.rollback === true
					};
				},
				catch: dbError
			}).pipe(
				Effect.flatMap((prepared) =>
					Effect.uninterruptibleMask((restore) =>
						Effect.suspend(() => {
							let aborted = false;
							const deadline = performance.now() + LIMITS.callMs.database;
							const check = () => {
								if (aborted || performance.now() >= deadline) throw cancelled();
							};
							const pending: Promise<readonly NativeRows[]> = Promise.resolve()
								.then(() =>
									pg.transaction(async (tx) => {
										check();
										for (const statement of prepared.setup) {
											check();
											await run(tx, statement);
											check();
										}
										const results: NativeRows[] = [];
										for (const statement of prepared.statements) {
											check();
											results.push(await run(tx, statement));
											check();
										}
										check();
										if (prepared.rollback) throw new RolledBack(results);
										return results;
									})
								)
								.catch((error: unknown) => {
									if (error instanceof RolledBack) return error.rows;
									throw error;
								});
							return restore(Effect.tryPromise({ try: () => pending, catch: dbError })).pipe(
								Effect.onInterrupt(() =>
									Effect.sync(() => {
										aborted = true;
									})
								),
								// A queued callback must observe cancellation; a running native statement must finish
								// before its callback can throw and the driver can complete rollback.
								Effect.ensuring(
									Effect.tryPromise({
										try: () =>
											pending.then(
												() => undefined,
												() => undefined
											),
										catch: dbError
									}).pipe(Effect.ignore)
								)
							);
						})
					).pipe(
						Effect.timeoutOrElse({
							duration: Duration.millis(LIMITS.callMs.database),
							orElse: () => Effect.fail(cancelled())
						})
					)
				),
				Effect.flatMap((results) =>
					Effect.try({
						try: () =>
							results.map((result) => {
								const rows = rowsOf(result.rows);
								return { rows, affected: result.affected ?? rows.length };
							}),
						catch: dbError
					})
				)
			);
		return TenantDb.typed({
			read: (statements) => exclusive({ statements }),
			write: (statement, lock) =>
				exclusive({ statements: [statement], ...(lock === undefined ? {} : { lock }) }).pipe(
					Effect.map((rows) => rows[0] ?? { rows: [], affected: 0 })
				),
			transaction: exclusive,
			session: () =>
				Effect.fail(
					DbError.make(
						'0A000',
						'interactive transactions require a PostgreSQL 17+ host; in-process PGlite cannot enforce the hard transaction deadline'
					)
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
