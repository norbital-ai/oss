// Optional trusted TDS transport: no source polling, CDC or business submission behavior.
import { Effect, Exit, FiberSet, RcMap, Result, Scope } from 'effect';
import mssql from 'mssql';
import { compile_sql_server } from '@norbital-ai/store/sqlserver';
import type { Json } from 'effect/Schema';
import {
	DATABASE_MAX_BYTES,
	DATABASE_MAX_ROWS,
	type DatabaseRequest,
	type DatabaseResult,
	FacilityFailure,
	HOST_LIMITS
} from '@norbital-ai/host-api';
import { connect_public } from '@norbital-ai/host-api/node';
import type { Socket } from 'node:net';

/** A trusted host's scoped TCP connector. The SQL transport still verifies TLS against the original hostname. */
export type SqlServerConnector = (
	hostname: string,
	port: number
) => Effect.Effect<Socket, FacilityFailure, Scope.Scope>;

const QUERY_MS = 8_000;
/** Feeds poll every minute: a pooled connection outlives the gap, and an unused pool closes this long after its last request. */
const IDLE_MS = 150_000;
const retryableSql = new Set([1205, 1222]); // Deadlock victim and lock timeout.
const failure = (message: string) => (cause: unknown) => {
	if (cause instanceof FacilityFailure) return cause;
	if (
		cause instanceof mssql.RequestError &&
		cause.code === 'EREQUEST' &&
		typeof cause.number === 'number'
	)
		return new FacilityFailure({
			kind: retryableSql.has(cause.number) ? 'upstream' : 'invalid',
			message
		});
	return new FacilityFailure({ kind: 'upstream', message });
};
function scalar(value: unknown): Json {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'bigint') return value.toString();
	if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
	if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
	throw new FacilityFailure({
		kind: 'upstream',
		message: 'Database returned an unsupported value; cast it explicitly.'
	});
}
/** Public-address policy by default; an operator may supply a more narrowly authorized host route. */
export function sqlServerDatabase(options: { readonly connect?: SqlServerConnector } = {}) {
	const connect = options.connect ?? connect_public;
	/** One TCP connection in its own scope, closed with the socket: a pooled connection outlives the request that opened it. */
	const socket = (hostname: string, port: number) =>
		Effect.gen(function* () {
			const owned = Scope.makeUnsafe();
			const opened = yield* connect(hostname, port).pipe(
				Effect.provideService(Scope.Scope, owned),
				Effect.onError(() => Scope.close(owned, Exit.void))
			);
			opened.once('close', () => Effect.runFork(Scope.close(owned, Exit.void)));
			return opened;
		});
	// One logged-in pool per connection string while it is used, and IDLE_MS after: a request reuses its TLS session
	// instead of paying two logins. A paused, unpaired or re-credentialed instance stops using its key, which then closes.
	const poolScope = Scope.makeUnsafe();
	const pools = Effect.runSync(
		RcMap.make({
			capacity: 32,
			lookup: (credential: string) =>
				Effect.gen(function* () {
					const parsed = yield* Effect.try({
						try: () => mssql.ConnectionPool.parseConnectionString(credential),
						catch: () =>
							new FacilityFailure({ kind: 'invalid', message: 'Database credential is invalid.' })
					});
					if (parsed.options?.instanceName !== undefined)
						return yield* Effect.fail(
							new FacilityFailure({
								kind: 'unsupported',
								message:
									'Named-instance discovery is unavailable; configure an explicit SQL Server TCP port.'
							})
						);
					if (typeof parsed.server !== 'string' || parsed.server.trim() === '')
						return yield* Effect.fail(
							new FacilityFailure({ kind: 'invalid', message: 'Database server is missing.' })
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
							new FacilityFailure({
								kind: 'unsupported',
								message: 'Automatic database credential discovery is unavailable.'
							})
						);
					const hostname = parsed.server;
					const port = parsed.options?.port ?? parsed.port ?? 1433;
					const run = yield* FiberSet.makeRuntimePromise();
					const pool = yield* Effect.try({
						try: () =>
							new mssql.ConnectionPool({
								...parsed,
								connectionTimeout: QUERY_MS,
								requestTimeout: QUERY_MS,
								// a socket check, not a SELECT 1 round trip, before each reuse
								validateConnection: 'socket',
								pool: { max: 4, min: 0, idleTimeoutMillis: IDLE_MS },
								options: {
									...parsed.options,
									encrypt: true,
									trustServerCertificate: false,
									serverName: hostname,
									connector: () => run(socket(hostname, port))
								},
								beforeConnect: (connection) => {
									connection.config.options.connector = () =>
										connection.routingData !== undefined
											? Promise.reject(
													new FacilityFailure({
														kind: 'unsupported',
														message: 'SQL Server rerouting is unavailable.'
													})
												)
											: run(socket(hostname, port));
								}
							}),
						catch: () =>
							new FacilityFailure({ kind: 'invalid', message: 'Database credential is invalid.' })
					});
					pool.on('error', () => {
						/* The active request reports its failure; idle SDK events never escape. */
					});
					yield* Effect.acquireRelease(
						Effect.tryPromise({
							try: () => pool.connect(),
							catch: failure('Database connection failed.')
						}),
						() =>
							Effect.tryPromise({
								try: () => pool.close(),
								catch: failure('Database connection cleanup failed.')
							}).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)
					);
					return pool;
				}),
			idleTimeToLive: IDLE_MS
		}).pipe(Effect.provideService(Scope.Scope, poolScope))
	);
	return {
		close: () => Scope.close(poolScope, Exit.void),
		query: (credential: string, given: DatabaseRequest) =>
			Effect.scoped(
				Effect.gen(function* () {
					if (new TextEncoder().encode(JSON.stringify(given)).byteLength > HOST_LIMITS.argsBytes)
						return yield* Effect.fail(
							FacilityFailure.invalid('Database request exceeds its bounds.')
						);
					const request = yield* Effect.try({
						try: () => compile_sql_server(given),
						catch: () => FacilityFailure.invalid('Database request is invalid.')
					});
					if (!credential.trim())
						return yield* Effect.fail(
							new FacilityFailure({ kind: 'invalid', message: 'Database credential is invalid.' })
						);
					if (Object.keys(request.parameters).length > 2_100)
						return yield* Effect.fail(
							new FacilityFailure({
								kind: 'invalid',
								message: 'Database transport parameter limit exceeded.'
							})
						);
					// a refused or failed login is not kept: the next request tries again
					const pool = yield* RcMap.get(pools, credential).pipe(
						Effect.catchTag('ExceededCapacityError', () =>
							Effect.fail(
								new FacilityFailure({
									kind: 'upstream',
									message: 'Database connection pool capacity reached; retry shortly.'
								})
							)
						),
						Effect.tapError(() => RcMap.invalidate(pools, credential))
					);
					const transaction =
						request.transaction === undefined
							? undefined
							: yield* Effect.try({
									try: () => new mssql.Transaction(pool),
									catch: failure('Database transaction failed.')
								});
					let active = false;
					// a pooled session would keep SERIALIZABLE after a failed transaction: its pool is not reused
					yield* Effect.addFinalizer(() =>
						!active || transaction === undefined
							? Effect.void
							: Effect.tryPromise({
									try: () => transaction.rollback(),
									catch: failure('Database rollback failed.')
								}).pipe(
									Effect.tapCause(Effect.logWarning),
									Effect.ignore,
									Effect.andThen(RcMap.invalidate(pools, credential))
								)
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
					let refusal: FacilityFailure | undefined,
						cancellationFailure: FacilityFailure | undefined,
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
								if (rows.length >= (request.max_rows ?? DATABASE_MAX_ROWS))
									throw new FacilityFailure({
										kind: 'too_large',
										message: 'Database result exceeds its row limit.'
									});
								const value = Object.fromEntries(
									Object.entries(row).map(([name, value]) => [name, scalar(value)])
								);
								size +=
									new TextEncoder().encode(JSON.stringify(value)).byteLength +
									(rows.length === 0 ? 0 : 1);
								if (size > DATABASE_MAX_BYTES)
									throw new FacilityFailure({
										kind: 'too_large',
										message: 'Database result exceeds its byte limit.'
									});
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
						try: () =>
							request.procedure === undefined
								? query.query(request.statement)
								: query.execute(request.procedure),
						catch: (cause) => failure('Database request failed.')(refusal ?? cause)
					}).pipe(Effect.onInterrupt(() => Effect.sync(cancel)));
					if (refusal !== undefined)
						return yield* Effect.fail(failure('Database request failed.')(refusal));
					if (streamFailure !== undefined)
						return yield* Effect.fail(failure('Database request failed.')(streamFailure));
					if (transaction !== undefined) {
						// the session returns to the pool: later requests read at the default level, not SERIALIZABLE
						yield* Effect.tryPromise({
							try: () =>
								transaction.request().batch('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'),
							catch: failure('Database commit failed.')
						});
						yield* Effect.tryPromise({
							try: () => transaction.commit(),
							catch: failure('Database commit failed.')
						});
						active = false;
					}
					return { rows };
				})
			).pipe(
				Effect.timeoutOrElse({
					duration: QUERY_MS,
					orElse: () =>
						Effect.fail(
							new FacilityFailure({
								kind: 'timeout',
								message: 'Database request exceeded its wall.'
							})
						)
				})
			)
	};
}
