import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import {
	DatabaseRequest,
	DatabaseResponse,
	EffectId,
	InvocationId,
	type FacilityBinding,
	type FacilityBindings
} from '@norbital-ai/bolt-protocol';
import { getErrorMessage } from '@norbital-ai/std';
import { Config, Effect, Redacted } from 'effect';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, type QueryResultRow } from 'pg';
import { makeWireBinding } from '../config.js';

/** The database SPI stays beside its wire adapter. */
export interface LocalDatabase {
	readonly binding: FacilityBinding<DatabaseRequest, DatabaseResponse>;
	// repository-health:allow EFF2 -- Public host finalizers preserve the established Promise lifecycle contract.
	readonly close: () => Promise<void>;
}

/** The local database options stay beside their constructor. */
export interface LocalDatabaseOptions {
	/** Use `memory://` only for explicitly non-durable development. */
	readonly dataDirectory: string;
}

/** The Postgres options stay beside their constructor. */
export interface PostgresDatabaseOptions {
	readonly connectionString: string;
	readonly ssl?: boolean;
}

/** The database provider lifecycle stays beside its constructors. */
export interface DatabaseProvider {
	readonly binding: FacilityBinding<DatabaseRequest, DatabaseResponse>;
	// repository-health:allow EFF2 -- Public host finalizers preserve the established Promise lifecycle contract.
	readonly close: () => Promise<void>;
}

/** Converts driver-specific row values into Schema.Json-safe data. */
const jsonSafe = (value: unknown): unknown => {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'bigint') return value.toString();
	if (Buffer.isBuffer(value)) return value.toString('base64');
	if (Array.isArray(value)) return value.map(jsonSafe);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]));
	}
	return value;
};

/** Finds the SQLSTATE through the small wrapper shapes used by Effect and both Postgres drivers. */
export const databaseSqlState = (cause: unknown, depth = 0): string | undefined => {
	if (depth > 6 || cause === null || typeof cause !== 'object') return undefined;
	const code = Reflect.get(cause, 'code');
	if (typeof code === 'string' && /^\d{5}$/.test(code)) return code;
	for (const key of ['cause', 'error', 'reason', 'originalError']) {
		const nested = databaseSqlState(Reflect.get(cause, key), depth + 1);
		if (nested !== undefined) return nested;
	}
	return undefined;
};

/** Serialization conflicts are safe to retry because their transaction committed nothing. */
export const databaseFailureRetryable = (cause: unknown): boolean | undefined =>
	databaseSqlState(cause) === '40001' ? true : undefined;

/** Creates the durable PostgreSQL provider used by production self-host deployments. */
export const makePostgresDatabase = ({
	connectionString,
	ssl = true
}: PostgresDatabaseOptions): DatabaseProvider => {
	const clientOptions = {
		connectionString,
		...(ssl ? { ssl: { rejectUnauthorized: true } } : {})
	};

	const runQuery = (input: Extract<DatabaseRequest, { _tag: 'Query' }>) =>
		Effect.gen(function* () {
			const client = new Client(clientOptions);
			yield* Effect.acquireRelease(
				Effect.tryPromise(() => client.connect()),
				() => Effect.tryPromise(() => client.end()).pipe(Effect.ignore)
			);
			const result = yield* Effect.tryPromise(() =>
				client.query<QueryResultRow>(input.sql, Array.from(input.parameters))
			);
			return {
				rows: result.rows.map(jsonSafe),
				affectedRows: result.rowCount ?? 0
			};
		});

	const runTransaction = (
		signal: AbortSignal,
		input: Extract<DatabaseRequest, { _tag: 'Transaction' }>
	) =>
		Effect.gen(function* () {
			const client = new Client(clientOptions);
			yield* Effect.acquireRelease(
				Effect.tryPromise(() => client.connect()),
				() => Effect.tryPromise(() => client.end()).pipe(Effect.ignore)
			);
			const completed = yield* Effect.gen(function* () {
				yield* Effect.tryPromise(() => client.query('begin'));
				const initial: {
					readonly rows: ReadonlyArray<QueryResultRow>;
					readonly affectedRows: number;
				} = { rows: [], affectedRows: 0 };
				const settled = yield* Effect.forEach(input.statements, (statement) =>
					Effect.gen(function* () {
						if (signal.aborted) return yield* Effect.fail(signal.reason);
						const result = yield* Effect.tryPromise(() =>
							client.query<QueryResultRow>(statement.sql, Array.from(statement.parameters))
						);
						return { rows: result.rows, affectedRows: result.rowCount ?? 0 };
					})
				);
				yield* Effect.tryPromise(() => client.query('commit'));
				return {
					rows: settled.at(-1)?.rows ?? initial.rows,
					affectedRows: settled.reduce(
						(total, entry) => total + entry.affectedRows,
						initial.affectedRows
					)
				};
			}).pipe(
				Effect.catch((cause) =>
					Effect.tryPromise(() => client.query('rollback'))
						.pipe(Effect.ignore)
						.pipe(Effect.andThen(() => Effect.fail(cause)))
				)
			);
			return {
				rows: completed.rows.map(jsonSafe),
				affectedRows: completed.affectedRows
			};
		});

	const binding: FacilityBinding<DatabaseRequest, DatabaseResponse> = makeWireBinding({
		request: DatabaseRequest,
		response: DatabaseResponse,
		cancelled: { code: 'database.cancelled', message: 'Database call was cancelled' },
		failed: {
			code: 'database.failed',
			retryable: databaseFailureRetryable,
			// A managed database fails for driver reasons only the driver knows. Keep that diagnostic so
			// an unreachable host and a wrong password do not collapse into the same sentence.
			message: (cause) =>
				`PostgreSQL operation failed: ${getErrorMessage(cause)}`
		},
		checkCancellationAfterInvoke: true,
		invoke: (_metadata, input, signal) =>
			Effect.runPromise(
				Effect.scoped(input._tag === 'Query' ? runQuery(input) : runTransaction(signal, input))
			)
	});

	return { binding, close: () => Effect.runPromise(Effect.void) };
};

/** Loads production PostgreSQL settings without exposing the connection URL in config errors. */
export const makePostgresDatabaseFromConfig = Effect.fn(
	'BoltServer.Database.makePostgresDatabaseFromConfig'
)(function* () {
	const configuration = yield* Effect.all({
		connectionString: Config.redacted('BOLT_SERVER_DATABASE_URL'),
		ssl: Config.boolean('BOLT_SERVER_DATABASE_SSL').pipe(Config.withDefault(true))
	});
	return makePostgresDatabase({
		connectionString: Redacted.value(configuration.connectionString),
		ssl: configuration.ssl
	});
});

/** Selects the concrete self-host database implementation through Effect Config. */
export const makeDatabaseFromConfig = Effect.fn('BoltServer.Database.makeDatabaseFromConfig')(
	function* () {
		const provider = yield* Config.literals(
			['postgres', 'pglite'],
			'BOLT_SERVER_DATABASE_PROVIDER'
		).pipe(Config.withDefault('postgres'));
		if (provider === 'postgres') return yield* makePostgresDatabaseFromConfig();
		const dataDirectory = yield* Config.nonEmptyString('BOLT_SERVER_DATABASE_DATA_DIRECTORY');
		return yield* Effect.tryPromise(() => makeLocalDatabase({ dataDirectory }));
	}
);

/** Creates the explicitly local PGlite adapter used by deterministic development and tests. */
export const makeLocalDatabase = ({ dataDirectory }: LocalDatabaseOptions) =>
	Effect.runPromise(
		Effect.gen(function* () {
			// PGlite ships these but registers none by default, so `create extension` answered "not
			// available" and the schema plan could install nothing. That silently cost two features:
			// free-text search fell back to a sequential `ilike` because no trigram index could exist,
			// and the effective-dating EXCLUDE constraints could not be created at all — leaving the
			// local database willing to hold overlapping temporal rows the application assumes are
			// impossible.
			//
			// Registering them here rather than per-caller keeps local development honest about what
			// the deployed database can do; a test that cannot express a constraint cannot prove one.
			const database = yield* Effect.tryPromise(() =>
				PGlite.create(dataDirectory, {
					extensions: { pg_trgm, btree_gist, vector }
				})
			);

			const binding: FacilityBinding<DatabaseRequest, DatabaseResponse> = makeWireBinding({
				request: DatabaseRequest,
				response: DatabaseResponse,
				cancelled: { code: 'database.cancelled', message: 'Database call was cancelled' },
				failed: {
					code: 'database.failed',
					retryable: databaseFailureRetryable,
					message: (cause) =>
						`Local database operation failed: ${getErrorMessage(cause)}`
				},
				checkCancellationAfterInvoke: true,
				invoke: (_metadata, input, signal) =>
					Effect.runPromise(
						Effect.gen(function* () {
							if (input._tag === 'Query') {
								const result = yield* Effect.tryPromise(() =>
									database.query<Record<string, unknown>>(input.sql, Array.from(input.parameters))
								);
								return {
									rows: result.rows.map(jsonSafe),
									affectedRows: result.affectedRows ?? 0
								};
							}

							// PGlite's transaction API is callback-shaped; the driver callback is the
							// one physical boundary this binding cannot flatten.
							const response = yield* Effect.tryPromise(() =>
								database.transaction((transaction) => {
									const initial: {
										readonly rows: ReadonlyArray<Record<string, unknown>>;
										readonly affectedRows: number;
									} = { rows: [], affectedRows: 0 };
									return Effect.runPromise(
										Effect.forEach(input.statements, (statement) =>
											Effect.gen(function* () {
												if (signal.aborted) return yield* Effect.fail(signal.reason);
												const result = yield* Effect.tryPromise(() =>
													transaction.query<Record<string, unknown>>(
														statement.sql,
														Array.from(statement.parameters)
													)
												);
												return {
													rows: result.rows,
													affectedRows: result.affectedRows ?? 0
												};
											})
										).pipe(
											Effect.map((completed) => ({
												rows: completed.at(-1)?.rows.map(jsonSafe) ?? initial.rows,
												affectedRows: completed.reduce(
													(total, entry) => total + entry.affectedRows,
													initial.affectedRows
												)
											}))
										)
									);
								})
							);

							return response;
						})
					)
			});

			return { binding, close: () => database.close() };
		})
	);

const LOCAL_EXTENSIONS = ['pg_trgm', 'btree_gist', 'vector'] as const;

export type LocalDatabaseQuery = (
	statement: string,
	parameters?: readonly unknown[]
) => Promise<unknown>;

/** Ephemeral PGlite: tmpdir, registered extensions, query helper, close + `rm`. */
export type StartedLocalDatabase = {
	readonly binding: NonNullable<FacilityBindings['database']>;
	readonly query: LocalDatabaseQuery;
	readonly dataDirectory: string;
	readonly close: () => Promise<void>;
};

const localDatabaseCall = (idempotencyKey: string) => ({
	invocationId: InvocationId.make(`local-database-${idempotencyKey}`),
	effectId: EffectId.make(`local-database-effect-${idempotencyKey}`),
	deadlineEpochMs: Number.MAX_SAFE_INTEGER,
	idempotencyKey
});

const queryThroughBinding =
	(binding: LocalDatabase['binding']): LocalDatabaseQuery =>
	async (statement, parameters) => {
		const result = await binding.call(
			localDatabaseCall(randomUUID()),
			DatabaseRequest.cases.Query.make({
				sql: statement,
				parameters: [...(parameters ?? [])]
			}),
			new AbortController().signal
		);
		if (result._tag === 'Failure') {
			throw new Error(result.error.message);
		}
		return result.value.rows;
	};

/**
 * Temporary PGlite selected the same way a self-host embedder selects it: `makeLocalDatabase`,
 * then `pg_trgm` / `btree_gist` / `vector`. No process env. Close removes the directory.
 */
export const startLocalDatabase = async (): Promise<StartedLocalDatabase> => {
	const dataDirectory = await mkdtemp(join(tmpdir(), 'bolt-server-pglite-'));
	let database: LocalDatabase | undefined;
	try {
		database = await makeLocalDatabase({ dataDirectory });
		const installed = await database.binding.call(
			localDatabaseCall('extensions'),
			DatabaseRequest.cases.Transaction.make({
				statements: LOCAL_EXTENSIONS.map((name) => ({
					sql: `create extension if not exists ${name}`,
					parameters: []
				}))
			}),
			new AbortController().signal
		);
		if (installed._tag === 'Failure') {
			throw new Error(installed.error.message);
		}
		const handle = database;
		return {
			binding: handle.binding,
			query: queryThroughBinding(handle.binding),
			dataDirectory,
			close: async () => {
				try {
					await handle.close();
				} finally {
					await rm(dataDirectory, { recursive: true, force: true });
				}
			}
		};
	} catch (error) {
		if (database !== undefined) await database.close().catch(() => undefined);
		await rm(dataDirectory, { recursive: true, force: true });
		throw error;
	}
};
