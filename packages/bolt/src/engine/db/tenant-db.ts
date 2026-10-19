// The tenant database (C11, per activation; W2.E1): a service whose every call is one round trip, failing with the
// driver's `DbError` (the SQLSTATE the write compiler maps to a refusal, rule 20) and, for a typed read, `BoltError`
// naming the table of a row that does not decode. No connection is held while guest code runs (rule 20): the engine
// never keeps a transaction open across a crossing. Adapters: `postgres.ts` (native Postgres hosts), `pglite.ts` (bolt
// dev, the test kit).
import { Context, Effect, Exit, FiberSet, type Option, type Schema } from 'effect';
import type { Lock, Rows, Sql } from '../contracts.ts';
import type { DbError } from '../errors.ts';
import type { BoltError } from '../../protocol/errors.ts';
import { decodeOne, decodeRows, decodeValue } from './rows.ts';
import { dbError } from './wire.ts';

/** The connection a transaction's body runs on, provided by `TenantDb.transaction` alone. */
export class TenantTx extends Context.Service<
	TenantTx,
	{ readonly query: (statement: Sql) => Effect.Effect<Rows, DbError> }
>()('bolt/TenantTx') {}

/** What an adapter implements; `TenantDb.typed` adds the decoding reads over it. */
export type RawDb = {
	/** Reads, pipelined in one round trip; answers in order (rule 12). Rows relayed as JSON (D5). */
	readonly read: (statements: readonly Sql[]) => Effect.Effect<readonly Rows[], DbError>;
	/** An act's one write statement: `BEGIN; LOCK …; <statement>; COMMIT` in one round trip (rules 20, 26). */
	readonly write: (statement: Sql, lock?: Lock) => Effect.Effect<Rows, DbError>;
	/**
	 * Several statements atomically (schema apply, seed restore, transactional host operations): `body` runs with
	 * `TenantTx`; a failure rolls back, and so does an interruption.
	 */
	readonly transaction: <A, E, R>(
		body: Effect.Effect<A, E, R>,
		lock?: Lock
	) => Effect.Effect<A, E | DbError, Exclude<R, TenantTx>>;
};
export type TenantDbShape = RawDb & {
	/** One read's rows, each decoded by `schema`. */
	readonly rows: <A>(
		schema: Schema.Decoder<A>,
		statement: Sql
	) => Effect.Effect<readonly A[], DbError | BoltError>;
	/** The row of a read that answers at most one. */
	readonly one: <A>(
		schema: Schema.Decoder<A>,
		statement: Sql
	) => Effect.Effect<Option.Option<A>, DbError | BoltError>;
	/** The one column of the one row a read answers. */
	readonly value: <A>(
		schema: Schema.Decoder<A>,
		statement: Sql
	) => Effect.Effect<A, DbError | BoltError>;
	/** A write's `RETURNING` rows, each decoded by `schema`. */
	readonly returning: <A>(
		schema: Schema.Decoder<A>,
		statement: Sql,
		lock?: Lock
	) => Effect.Effect<readonly A[], DbError | BoltError>;
};

const NONE: Rows = { rows: [], affected: 0 };
/** A callback transaction's body failed: thrown so the driver rolls back, carrying the body's exit out. */
class RolledBack<A, E> {
	readonly exit: Exit.Failure<A, E>;
	constructor(exit: Exit.Failure<A, E>) {
		this.exit = exit;
	}
}
/**
 * `body` inside a driver's Promise transaction callback (PGlite's API): the callback throws to roll the driver back when
 * the body fails, and the body's exit comes back out; interrupting the call interrupts the body, then waits for the
 * driver's rollback before its scope can release the database.
 */
export function callbackTransaction<T, A, E, R>(
	begin: (callback: (t: T) => Promise<Exit.Success<A, E>>) => Promise<Exit.Success<A, E>>,
	txOf: (t: T) => TenantTx['Service'],
	body: Effect.Effect<A, E, R>
): Effect.Effect<A, E | DbError, Exclude<R, TenantTx>> {
	return Effect.scoped(
		Effect.gen(function* () {
			const fibers = yield* FiberSet.make<Exit.Exit<A, E>, never>();
			const run = yield* FiberSet.runtimePromise(fibers)<Exclude<R, TenantTx>>();
			const failure = (e: unknown): RolledBack<A, E> | DbError =>
				e instanceof RolledBack ? e : dbError(e);
			let interrupted = false;
			const exit = yield* Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const pending = yield* Effect.try({
						try: () =>
							begin(async (t) => {
								const done = await run(
									Effect.exit(
										interrupted
											? Effect.interrupt
											: body.pipe(Effect.provideService(TenantTx, txOf(t)))
									)
								);
								if (Exit.isFailure(done)) throw new RolledBack(done);
								return done;
							}),
						catch: failure
					});
					return yield* restore(
						Effect.tryPromise({ try: () => pending, catch: failure }).pipe(
							Effect.onInterrupt(() =>
								Effect.sync(() => {
									// BEGIN may still be queued; no body may start after cancellation.
									interrupted = true;
								}).pipe(Effect.andThen(FiberSet.clear(fibers)))
							),
							// Interrupt the Effect body first; then await the driver's actual rollback.
							Effect.ensuring(
								// repository-health:allow EFF13 -- Both native-driver settlement handlers fulfill with undefined, including rollback rejection.
								Effect.promise(() =>
									pending.then(
										() => undefined,
										() => undefined
									)
								)
							)
						)
					);
				})
			).pipe(
				Effect.catch((e) => (e instanceof RolledBack ? Effect.succeed(e.exit) : Effect.fail(e)))
			);
			return yield* exit;
		})
	);
}

export class TenantDb extends Context.Service<TenantDb, TenantDbShape>()('bolt/TenantDb') {
	/** An adapter's calls with the decoding reads over them. */
	static readonly typed = (raw: RawDb): TenantDbShape => ({
		...raw,
		rows: (schema, statement) =>
			Effect.flatMap(raw.read([statement]), ([r]) => decodeRows(schema, r ?? NONE)),
		one: (schema, statement) =>
			Effect.flatMap(raw.read([statement]), ([r]) => decodeOne(schema, r ?? NONE)),
		value: (schema, statement) =>
			Effect.flatMap(raw.read([statement]), ([r]) => decodeValue(schema, r ?? NONE)),
		returning: (schema, statement, lock) =>
			Effect.flatMap(raw.write(statement, lock), (r) => decodeRows(schema, r))
	});
}
