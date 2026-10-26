// Native Postgres executes completed SQL batches or a fixed five-second SERIALIZABLE lease. Batches copy inputs
// before acquisition; leases pin one client across completed SQL requests, with independent server and host bounds.
// Authored callbacks never enter the adapter. Interruption or uncertain cleanup destroys the connection.
// Setup and settlement add control round trips; every supplied Sql keeps its own prepared execution and result.
import { createHash } from 'node:crypto';
import { Duration, Effect, Exit, Layer, type Scope } from 'effect';
import { LIMITS, type Rows } from '../../engine/contracts.ts';
import type { Json } from '../../decl/values.ts';
import { DbError } from '../../engine/errors.ts';
import {
	TenantDb,
	type DbBatch,
	type DbSession,
	type RawDb,
	type TenantDbShape
} from '../../engine/db/tenant-db.ts';
import {
	cancelled,
	copiedBatch,
	DATABASE_SETTINGS,
	dbError,
	lockStatements,
	param,
	parse
} from '../../engine/db/wire.ts';

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
	end?(): Promise<void>;
	connection?: { readonly stream: { destroy(): void } };
	on?(event: 'error' | 'end', listener: (error?: unknown) => void): unknown;
	removeListener?(event: 'error' | 'end', listener: (error?: unknown) => void): unknown;
};
export type PgPool = { connect(): Promise<PgClient> };

const types = { getTypeParser: (oid: number) => (s: string) => parse(oid, s) };
const NONE: PgResult = { rows: [], rowCount: 0 };
const SESSION_MS = 5_000;
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
	const query = (client: PgClient, q: PgQuery) =>
		Effect.tryPromise({ try: () => client.query(q), catch: dbError });
	const send = (client: PgClient, text: string) => query(client, { text, types });
	const single = (client: PgClient, statement: PgQuery) =>
		Effect.map(query(client, statement), (result) => rowsOf(last(result)));
	/** Interruptible pool acquisition disposes a connection even if the pool answers after cancellation. */
	const acquire = Effect.tryPromise({
		try: async (signal) => {
			const client = await pool.connect();
			if (signal.aborted) {
				client.release(true);
				throw cancelled();
			}
			return client;
		},
		catch: dbError
	});
	const run = (
		batch: DbBatch,
		readOnly: boolean = false
	): Effect.Effect<readonly Rows[], DbError> =>
		Effect.try({
			try: () => {
				const prepared = copiedBatch(batch);
				const statements: PgQuery[] = prepared.statements.map((statement) => ({
					text: statement.text,
					...(statement.params.length === 0
						? {}
						: { name: named(statement.text), values: statement.params.map(param) }),
					types
				}));
				const begin = [
					readOnly ? 'begin isolation level repeatable read read only' : 'begin',
					...DATABASE_SETTINGS,
					...lockStatements(prepared.lock)
				].join(';\n');
				return { statements, begin, end: prepared.rollback === true ? 'rollback' : 'commit' };
			},
			catch: dbError
		}).pipe(
			Effect.flatMap((prepared) =>
				Effect.scoped(
					Effect.gen(function* () {
						let uncertain = false;
						const client = yield* Effect.acquireRelease(
							acquire,
							(client, exit) =>
								Effect.sync(() => client.release(uncertain || Exit.hasInterrupts(exit))),
							{ interruptible: true }
						);
						const rollback = send(client, 'rollback').pipe(
							Effect.tap(() =>
								Effect.sync(() => {
									uncertain = false;
								})
							),
							Effect.tapCause(Effect.logWarning),
							Effect.ignore
						);
						return yield* Effect.gen(function* () {
							uncertain = true;
							yield* send(client, prepared.begin);
							const results = yield* Effect.forEach(prepared.statements, (statement) =>
								single(client, statement)
							);
							yield* send(client, prepared.end);
							uncertain = false;
							return results;
						}).pipe(Effect.tapError(() => rollback));
					})
				).pipe(
					Effect.timeoutOrElse({
						duration: Duration.millis(LIMITS.callMs.database),
						orElse: () => Effect.fail(cancelled())
					})
				)
			)
		);
	const session = (): Effect.Effect<DbSession, DbError, Scope.Scope> =>
		Effect.acquireRelease(
			Effect.tryPromise({
				try: async (signal): Promise<DbSession> => {
					const deadline = performance.now() + SESSION_MS;
					const client = await pool.connect();
					if (signal.aborted || performance.now() >= deadline) {
						client.release(true);
						throw cancelled();
					}
					const end = client.end?.bind(client);
					const socket = client.connection?.stream;
					if (
						client.on === undefined ||
						client.removeListener === undefined ||
						end === undefined ||
						socket === undefined
					) {
						client.release(true);
						throw DbError.make(
							'0A000',
							'interactive transactions require native connection lifecycle notifications'
						);
					}
					let closed = false;
					let settling = false;
					let committing = false;
					let finished: 'commit' | 'rollback' | undefined;
					let failure: DbError | undefined;
					let pending = 0;
					let nextSavepoint = 0;
					let queue = Promise.resolve();
					const closure = Promise.withResolvers<DbError>();
					const released = Promise.withResolvers<void>();
					let timer: ReturnType<typeof setTimeout> | undefined;
					const expired = () =>
						DbError.make('57014', 'the interactive transaction exceeded its 5 second lifetime');
					const settled = () =>
						failure ?? DbError.make('25000', 'the interactive transaction is closed');
					const stop = (destroy: boolean, error?: DbError) => {
						if (closed) return;
						closed = true;
						failure =
							committing &&
							error !== undefined &&
							(error.sqlstate.startsWith('08') || error.sqlstate === '57014')
								? DbError.make('08007', 'the transaction commit could not be confirmed')
								: error;
						clearTimeout(timer);
						signal.removeEventListener('abort', abort);
						const release = () => {
							client.removeListener?.('error', onError);
							client.removeListener?.('end', onEnd);
							client.release(destroy);
							released.resolve();
						};
						// Releasing first installs pg-pool's idle listener, which misreports a final timeout as an idle fault.
						if (destroy) {
							const closing = end();
							socket.destroy();
							closing.then(release, (error: unknown) => {
								failure ??= dbError(error);
								release();
							});
						} else release();
						closure.resolve(settled());
					};
					const abort = () => stop(true, cancelled());
					const onError = (error?: unknown) => {
						const native = dbError(error);
						stop(
							true,
							committing
								? DbError.make('08007', 'the transaction commit could not be confirmed')
								: native.sqlstate === '25P04'
									? expired()
									: native
						);
					};
					const onEnd = () =>
						stop(true, DbError.make('08006', 'the interactive transaction connection ended'));
					const check = (terminal = false) => {
						if (!closed && performance.now() >= deadline) stop(true, expired());
						if (closed) throw settled();
						if (settling && !terminal)
							throw DbError.make('25000', 'the interactive transaction is settling');
					};
					const execute = async (
						text: string,
						params?: readonly Json[],
						terminal = false
					): Promise<Rows> => {
						check(terminal);
						try {
							const result = await Promise.race([
								client.query({
									text,
									...(params === undefined || params.length === 0
										? {}
										: { name: named(text), values: params.map(param) }),
									types
								}),
								closure.promise.then((error) => {
									throw error;
								})
							]);
							check(terminal);
							return rowsOf(last(result));
						} catch (error) {
							const native = dbError(error);
							if (native.sqlstate === '25P04') stop(true, expired());
							throw closed ? settled() : native;
						}
					};
					client.on('error', onError);
					client.on('end', onEnd);
					signal.addEventListener('abort', abort, { once: true });
					timer = setTimeout(
						() => stop(true, expired()),
						Math.max(0, deadline - performance.now())
					);
					try {
						const version = (
							await execute("select current_setting('server_version_num')::int as version")
						).rows[0]?.version;
						if (typeof version !== 'number' || version < 170_000)
							throw DbError.make(
								'0A000',
								'interactive transactions require PostgreSQL 17 or newer with transaction_timeout'
							);
						const remaining = Math.max(1, Math.floor(deadline - performance.now()));
						await execute(
							`begin isolation level serializable;\nset local transaction_timeout = '${remaining}ms';\nset local lock_timeout = '1s';\nset local statement_timeout = '${remaining}ms';\nset local idle_in_transaction_session_timeout = '${remaining}ms'`
						);
						check();
					} catch (error) {
						const native = dbError(error);
						stop(true, native);
						throw failure ?? native;
					} finally {
						signal.removeEventListener('abort', abort);
					}
					const batch = (input: DbBatch): Effect.Effect<readonly Rows[], DbError> =>
						Effect.try({ try: () => copiedBatch(input), catch: dbError }).pipe(
							Effect.flatMap((prepared) =>
								Effect.tryPromise({
									try: async (operationSignal) => {
										check();
										pending++;
										const cancelledOperation = () => stop(true, cancelled());
										operationSignal.addEventListener('abort', cancelledOperation, { once: true });
										const result = queue.then(async () => {
											check();
											const name = `bolt_session_${nextSavepoint++}`;
											try {
												await execute(`savepoint ${name}`);
											} catch (error) {
												const native = dbError(error);
												stop(true, native);
												throw native;
											}
											try {
												for (const text of lockStatements(prepared.lock)) await execute(text);
												const results: Rows[] = [];
												for (const statement of prepared.statements)
													results.push(await execute(statement.text, statement.params));
												if (prepared.rollback === true)
													await execute(`rollback to savepoint ${name}`);
												await execute(`release savepoint ${name}`);
												return results;
											} catch (error) {
												const native = dbError(error);
												if (!closed) {
													try {
														await execute(`rollback to savepoint ${name}`);
														await execute(`release savepoint ${name}`);
													} catch {
														stop(true, native);
													}
												}
												throw native;
											}
										});
										queue = result.then(
											() => undefined,
											() => undefined
										);
										try {
											return await result;
										} finally {
											pending--;
											operationSignal.removeEventListener('abort', cancelledOperation);
										}
									},
									catch: dbError
								})
							)
						);
					const finish = (commit: boolean): Effect.Effect<void, DbError> =>
						Effect.tryPromise({
							try: async (finishSignal) => {
								if (commit && finished === 'commit') return;
								if (closed && !commit) return await released.promise;
								if (settling && !commit) {
									stop(
										true,
										DbError.make('08007', 'the transaction settlement could not be confirmed')
									);
									return;
								}
								check();
								if (pending > 0) {
									if (commit)
										throw DbError.make(
											'55000',
											'the interactive transaction still has pending SQL requests'
										);
									stop(true, cancelled());
									return;
								}
								settling = true;
								committing = commit;
								const interrupted = () =>
									stop(
										true,
										commit
											? DbError.make('08007', 'the transaction commit could not be confirmed')
											: cancelled()
									);
								finishSignal.addEventListener('abort', interrupted, { once: true });
								try {
									await execute(commit ? 'commit' : 'rollback', undefined, true);
									finished = commit ? 'commit' : 'rollback';
									stop(false);
								} catch (error) {
									const native = dbError(error);
									const outcome =
										commit && (native.sqlstate.startsWith('08') || native.sqlstate === '57014')
											? DbError.make('08007', 'the transaction commit could not be confirmed')
											: native;
									stop(true, outcome);
									if (outcome.sqlstate === '08007') failure = outcome;
									throw outcome;
								} finally {
									finishSignal.removeEventListener('abort', interrupted);
								}
							},
							catch: dbError
						});
					return {
						db: {
							read: (statements) => batch({ statements }),
							write: (statement, lock) =>
								batch({ statements: [statement], ...(lock === undefined ? {} : { lock }) }).pipe(
									Effect.map((rows) => rows[0] ?? { rows: [], affected: 0 })
								),
							transaction: batch
						},
						commit: finish(true),
						rollback: finish(false)
					};
				},
				catch: dbError
			}),
			(lease) => lease.rollback.pipe(Effect.ignore),
			{ interruptible: true }
		).pipe(
			Effect.timeoutOrElse({
				duration: Duration.millis(SESSION_MS),
				orElse: () => Effect.fail(cancelled())
			})
		);
	return {
		read: (statements) => run({ statements }, true),
		write: (statement, lock) =>
			run({ statements: [statement], ...(lock === undefined ? {} : { lock }) }).pipe(
				Effect.map((rows) => rows[0] ?? { rows: [], affected: 0 })
			),
		transaction: (batch) => run(batch),
		session
	};
}

export const PostgresDb = {
	/** The adapter over a pool the host keeps (a multi-workspace host shares its pool across a cell's work). */
	make: (pool: PgPool): TenantDbShape => TenantDb.typed(raw(pool)),
	/** The host owns the pool; batches own a connection, interactive leases pin one for at most five seconds. */
	layer: (pool: PgPool): Layer.Layer<TenantDb> =>
		Layer.sync(TenantDb, () => TenantDb.typed(raw(pool)))
};
