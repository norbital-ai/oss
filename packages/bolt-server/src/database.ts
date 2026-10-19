// Optional trusted TDS transport: no source polling, CDC or business submission behavior.
import { Effect, FiberSet, Result, Scope } from 'effect';
import mssql from 'mssql';
import {
	BoltError,
	DATABASE_MAX_BYTES,
	DATABASE_MAX_ROWS,
	connectPublic,
	validateDatabaseRequest,
	type DatabaseDriver,
	type DatabaseResult,
	type Json
} from '@norbital-ai/bolt/engine';

const QUERY_MS = 8_000;
const failure = (message: string) => (cause: unknown) =>
	cause instanceof BoltError ? cause : BoltError.make('upstream', 'facility', message, cause);
function scalar(value: unknown): Json {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'bigint') return value.toString();
	if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
	if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
	throw BoltError.make(
		'upstream',
		'facility',
		'Database returned an unsupported value; cast it explicitly.'
	);
}
export function sqlServerDatabase() {
	return {
		query: (credential: string, given: Parameters<DatabaseDriver['query']>[1]) =>
			Effect.scoped(
				Effect.gen(function* () {
					const request = yield* Effect.try({
						try: () => validateDatabaseRequest(given),
						catch: (cause) =>
							cause instanceof BoltError
								? cause
								: BoltError.make('invalidInput', 'admission', 'Database request is invalid.', cause)
					});
					if (!credential.trim())
						return yield* Effect.fail(
							BoltError.make('invalidInput', 'admission', 'Database credential is invalid.')
						);
					if (Object.keys(request.parameters).length > 2_100)
						return yield* Effect.fail(
							BoltError.make(
								'invalidInput',
								'admission',
								'Database transport parameter limit exceeded.'
							)
						);
					const parsed = yield* Effect.try({
						try: () => mssql.ConnectionPool.parseConnectionString(credential),
						catch: () =>
							BoltError.make('invalidInput', 'admission', 'Database credential is invalid.')
					});
					if (parsed.options?.instanceName !== undefined)
						return yield* Effect.fail(
							BoltError.make(
								'unsupported',
								'facility',
								'Named-instance discovery is unavailable; configure an explicit SQL Server TCP port.'
							)
						);
					if (typeof parsed.server !== 'string' || parsed.server.trim() === '')
						return yield* Effect.fail(
							BoltError.make('invalidInput', 'admission', 'Database server is missing.')
						);
					if (
						parsed.authentication !== undefined &&
						![
							'default',
							'ntlm',
							'azure-active-directory-access-token',
							'azure-active-directory-password',
							'azure-active-directory-service-principal-secret'
						].includes(parsed.authentication.type)
					)
						return yield* Effect.fail(
							BoltError.make(
								'unsupported',
								'facility',
								'Automatic database credential discovery is unavailable.'
							)
						);
					const hostname = parsed.server;
					const port = parsed.options?.port ?? parsed.port ?? 1433;
					const scope = yield* Scope.Scope;
					const run = yield* FiberSet.makeRuntimePromise();
					const pool = yield* Effect.try({
						try: () =>
							new mssql.ConnectionPool({
								...parsed,
								connectionTimeout: QUERY_MS,
								requestTimeout: QUERY_MS,
								options: {
									...parsed.options,
									encrypt: true,
									trustServerCertificate: false,
									serverName: hostname,
									connector: () =>
										run(
											connectPublic(hostname, port).pipe(Effect.provideService(Scope.Scope, scope))
										)
								},
								beforeConnect: (connection) => {
									connection.config.options.connector = () =>
										connection.routingData !== undefined
											? Promise.reject(
													BoltError.make(
														'unsupported',
														'facility',
														'SQL Server rerouting is unavailable.'
													)
												)
											: run(
													connectPublic(hostname, port).pipe(
														Effect.provideService(Scope.Scope, scope)
													)
												);
								}
							}),
						catch: () =>
							BoltError.make('invalidInput', 'admission', 'Database credential is invalid.')
					});
					let closed = false;
					const close = Effect.tryPromise({
						try: () => pool.close(),
						catch: failure('Database connection cleanup failed.')
					}).pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								closed = true;
							})
						)
					);
					yield* Effect.addFinalizer(() =>
						closed ? Effect.void : close.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)
					);
					pool.on('error', () => {
						/* The active request reports its failure; idle SDK events never escape. */
					});
					yield* Effect.tryPromise({
						try: () => pool.connect(),
						catch: failure('Database connection failed.')
					});
					const transaction =
						request.transaction === undefined
							? undefined
							: yield* Effect.try({
									try: () => new mssql.Transaction(pool),
									catch: failure('Database transaction failed.')
								});
					let active = false;
					yield* Effect.addFinalizer(() =>
						!active || transaction === undefined
							? Effect.void
							: Effect.tryPromise({
									try: () => transaction.rollback(),
									catch: failure('Database rollback failed.')
								}).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)
					);
					if (transaction !== undefined) {
						yield* Effect.tryPromise({
							try: () => transaction.begin(mssql.ISOLATION_LEVEL.SERIALIZABLE),
							catch: failure('Database transaction failed.')
						});
						active = true;
					}
					const query = yield* Effect.try({
						try: () => {
							const query = transaction?.request() ?? pool.request();
							for (const [name, value] of Object.entries(request.parameters))
								query.input(
									name,
									typeof value === 'number'
										? mssql.Float
										: typeof value === 'boolean'
											? mssql.Bit
											: mssql.NVarChar(mssql.MAX),
									value
								);
							return query;
						},
						catch: failure('Database parameters are invalid.')
					});
					const rows: DatabaseResult['rows'][number][] = [];
					let size = new TextEncoder().encode('{"rows":[]}').byteLength;
					let refusal: BoltError | undefined,
						cancellationFailure: BoltError | undefined,
						streamFailure: unknown;
					yield* Effect.addFinalizer(() =>
						cancellationFailure === undefined ? Effect.void : Effect.logWarning(cancellationFailure)
					);
					// This is the native driver's event boundary; cancellation errors are delivered by its query promise.
					const cancel = () => {
						const cancelled = Result.try({
							try: () => query.cancel(),
							catch: failure('Database cancellation failed.')
						});
						// A completed request can race cancellation; preserve the primary failure and report cleanup.
						if (Result.isFailure(cancelled)) cancellationFailure ??= cancelled.failure;
					};
					query.stream = true;
					query.on('error', (error: unknown) => {
						streamFailure ??= error;
					});
					query.on('row', (row: Record<string, unknown>) => {
						if (refusal !== undefined) return;
						const accepted = Result.try({
							try: () => {
								if (rows.length >= (request.maxRows ?? DATABASE_MAX_ROWS))
									throw BoltError.make(
										'overflow',
										'facility',
										'Database result exceeds its row limit.'
									);
								const value = Object.fromEntries(
									Object.entries(row).map(([name, value]) => [name, scalar(value)])
								);
								size +=
									new TextEncoder().encode(JSON.stringify(value)).byteLength +
									(rows.length === 0 ? 0 : 1);
								if (size > DATABASE_MAX_BYTES)
									throw BoltError.make(
										'overflow',
										'facility',
										'Database result exceeds its byte limit.'
									);
								rows.push(value);
							},
							catch: failure('Database request failed.')
						});
						if (Result.isFailure(accepted)) {
							refusal = accepted.failure;
							cancel();
						}
					});
					yield* Effect.tryPromise({
						try: () => query.query(request.statement),
						catch: (cause) => failure('Database request failed.')(refusal ?? cause)
					}).pipe(Effect.onInterrupt(() => Effect.sync(cancel)));
					if (refusal !== undefined)
						return yield* Effect.fail(failure('Database request failed.')(refusal));
					if (streamFailure !== undefined)
						return yield* Effect.fail(failure('Database request failed.')(streamFailure));
					if (transaction !== undefined) {
						yield* Effect.tryPromise({
							try: () => transaction.commit(),
							catch: failure('Database commit failed.')
						});
						active = false;
					}
					yield* close;
					return { rows };
				})
			).pipe(
				Effect.timeoutOrElse({
					duration: QUERY_MS,
					orElse: () =>
						Effect.fail(
							BoltError.make('timeout', 'facility', 'Database request exceeded its wall.')
						)
				})
			)
	};
}
