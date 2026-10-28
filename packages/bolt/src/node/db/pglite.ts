// The PGlite `TenantDb` (bolt dev, the test kit). In process, so a "round trip" is a call; there is no wire to bound.
// Every call is a complete SQL batch in one PGlite transaction, the only way to hold its connection exclusively.
// The 20 s wall requests rollback between native statements. A running WASM statement cannot be forcibly cancelled;
// interruption waits for its native transaction to settle before the database can be released.
import { parse as protocolResults, PGlite, protocol } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { vector } from '@electric-sql/pglite-pgvector';
import { Context, Duration, Effect, Layer, Option, Schema, type Scope } from 'effect';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LIMITS, type Rows, type Sql } from '../../engine/contracts.ts';
import { DbError } from '../../engine/errors.ts';
import { TenantDb, type DbBatch, type TenantDbShape } from '../../engine/db/tenant-db.ts';
import {
	cancelled,
	copiedBatch,
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
} & Pick<PGlite, 'execProtocol' | 'parsers'>;
/** A native data directory may be initialized from a dump; reopening uses that same directory. */
export type PgliteSource =
	string | Blob | { readonly dataDir: string; readonly loadDataDir?: Blob };
type Querier = Pick<PgliteClient, 'query' | 'exec'>;
const parsers = Object.fromEntries(PARSED_OIDS.map((oid) => [oid, (s: string) => parse(oid, s)]));
/**
 * PGlite scans every array type on open to install its own array parsers over these (hundreds, which it then copies on
 * every query). Bolt parses each value itself (`parsers`, text otherwise), exactly as the node-postgres adapter does.
 */
class Pglite extends PGlite {
	override async _initArrayTypes(): Promise<void> {}
}
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
const { serialize } = protocol;
/** Distinct statements a session keeps parsed before it closes them all. */
const NAMED = 2_000;
/**
 * Named statements, as the PostgreSQL adapter's: each text is parsed and analysed once per session, then only bound
 * and executed (its plan cached once a generic one is as cheap), one protocol call each. Called inside the batch's
 * transaction, whose lock keeps every other batch out.
 */
const namedRunner = (
	execProtocol: PGlite['execProtocol'],
	parsers: PGlite['parsers']
): ((s: NativeSql) => Promise<NativeRows>) => {
	const names = new Map<string, string>();
	return async (s) => {
		let name = names.get(s.text);
		if (name === undefined) {
			if (names.size >= NAMED) {
				// only its own: the session may hold others' (the test kit's)
				await execProtocol(
					Buffer.concat([
						...[...names.values()].map((old) => serialize.close({ type: 'S', name: old })),
						serialize.sync()
					]),
					{ syncToFs: false }
				);
				names.clear();
			}
			name = `bolt_${createHash('sha1').update(s.text).digest('hex')}`;
			await execProtocol(
				Buffer.concat([serialize.parse({ name, text: s.text }), serialize.sync()]),
				{
					syncToFs: false
				}
			);
			names.set(s.text, name);
		}
		const { messages } = await execProtocol(
			Buffer.concat([
				serialize.bind({ statement: name, values: s.params }),
				serialize.describe({ type: 'P' }),
				serialize.execute({}),
				serialize.sync()
			]),
			{ syncToFs: false }
		);
		const result = protocolResults.parseResults(messages, parsers)[0];
		return { rows: result?.rows ?? [], affected: result?.affectedRows };
	};
};
/** One runner per open session: its statement names live as long as the session does. */
// keyed by the session's own parser table: every client wrapping one PGlite shares its prepared statements
const runners = new WeakMap<PgliteClient['parsers'], (s: NativeSql) => Promise<NativeRows>>();
const closed = (pg: PGlite) =>
	Effect.tryPromise({ try: () => pg.close(), catch: dbError }).pipe(
		Effect.uninterruptible,
		Effect.tapCause(Effect.logWarning),
		Effect.orDie
	);
/**
 * A dump that opens without redo: `dumpDataDir` alone leaves every change since the last checkpoint to replay on each
 * open of the dump.
 */
const checkpointed = (pg: PGlite) =>
	Effect.tryPromise({
		try: async () => {
			await pg.exec('checkpoint');
			return pg.dumpDataDir('none');
		},
		catch: dbError
	}).pipe(Effect.uninterruptible);
// The smallest data directory to unpack per open: 1 MiB WAL segments (16 MiB by default), a checkpoint removes spent
// segments instead of keeping them as future ones, and no template databases (PGlite serves its one database; nothing
// creates another). Each open writes every file into the in-memory FS. No full-page images: PGlite already runs
// without fsync (`-F`), so a torn page is no new risk, and every first write after a load would otherwise log 8 KiB.
const INITDB = [
	'--wal-segsize=1',
	'--set=min_wal_size=2MB',
	'--set=wal_recycle=off',
	'--set=full_page_writes=off'
];
const TEMPLATES = [
	`update pg_database set datistemplate = false where datname in ('template0', 'template1')`,
	'drop database template0',
	'drop database template1'
];
const initdb = Effect.acquireUseRelease(
	Effect.tryPromise({
		try: () => PGlite.create({ extensions, initDbStartParams: INITDB }),
		catch: dbError
	}),
	(pg) =>
		Effect.tryPromise({
			// one statement per call: DROP DATABASE refuses a multi-statement batch's implicit transaction
			try: async () => {
				for (const statement of TEMPLATES) await pg.exec(statement);
			},
			catch: dbError
		}).pipe(Effect.andThen(checkpointed(pg))),
	closed
);
/** Keyed by the PGlite and extension builds (entry path, size, mtime) and the initdb shape: another is another dump. */
const pristineFile = async () => {
	const require = createRequire(import.meta.url),
		hash = createHash('sha256');
	for (const name of ['@electric-sql/pglite', '@electric-sql/pglite-pgvector']) {
		const path = require.resolve(name),
			info = await stat(path);
		hash.update(`${path}\0${info.size}\0${info.mtimeMs}\0`);
	}
	hash.update(JSON.stringify([INITDB, TEMPLATES]));
	return join(tmpdir(), 'norbital-pglite', `${hash.digest('hex')}.tar`);
};
// The machine's dump, else initdb once and keep it (written whole, then renamed, so no process reads half of one).
const dump = Effect.gen(function* () {
	const file = yield* Effect.tryPromise({ try: pristineFile, catch: dbError });
	const kept = yield* Effect.tryPromise(() => readFile(file)).pipe(Effect.option);
	if (Option.isSome(kept)) return new Blob([new Uint8Array(kept.value)]);
	const blob = yield* initdb;
	yield* Effect.tryPromise({
		try: async () => {
			const temporary = `${file}.${randomUUID()}`;
			await mkdir(dirname(file), { recursive: true });
			await writeFile(temporary, new Uint8Array(await blob.arrayBuffer()));
			await rename(temporary, file);
		},
		catch: dbError
	});
	return blob;
});
let pristineDump: Effect.Effect<Blob, DbError> | undefined;
const pristine = Effect.suspend(() =>
	pristineDump === undefined
		? Effect.map(Effect.cached(dump), (cached) => (pristineDump ??= cached))
		: Effect.succeed(pristineDump)
);

/** One initdb per machine and PGlite build: an in-memory database starts from this dump (~13× cheaper than initdb). */
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
		return yield* Effect.tryPromise({
			try: async () => {
				const pg = new Pglite({ ...at, extensions, parsers });
				await pg.waitReady;
				return pg;
			},
			catch: dbError
		});
	});

export const PgliteDb = {
	/** The adapter over an open PGlite (its session zone must be UTC; `open` sets it). */
	make: (pg: PgliteClient): TenantDbShape => {
		let named = runners.get(pg.parsers);
		if (named === undefined)
			runners.set(pg.parsers, (named = namedRunner(pg.execProtocol.bind(pg), pg.parsers)));
		const exclusive = (batch: DbBatch): Effect.Effect<readonly Rows[], DbError> =>
			Effect.try({
				try: () => {
					const prepared = copiedBatch(batch);
					return {
						statements: prepared.statements.map(nativeSql),
						// No server-side timeouts: a WASM backend has no timer signal to enforce them and no second session to
						// wait on, so the wall below is the bound. Locks are parameterless: one simple-protocol text, if any.
						setup: lockStatements(prepared.lock).join(';\n'),
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
										if (prepared.setup !== '') await run(tx, { text: prepared.setup, params: [] });
										const results: NativeRows[] = [];
										for (const statement of prepared.statements) {
											check();
											results.push(
												await (statement.params.length > 0 ? named(statement) : run(tx, statement))
											);
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
	/** The open database as a dump to load (`PgliteSource`), checkpointed first so loading it replays no WAL. */
	dump: checkpointed,
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
