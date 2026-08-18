import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite/vector';
import {
	DatabaseRequest,
	DatabaseResponse,
	FacilityCall,
	failure,
	makeWireError,
	success,
	type FacilityBinding
} from '@norbital-ai/bolt-protocol';
import { Config, Effect, Redacted, Schema } from 'effect';
import { Client } from 'pg';

// stupidity:allow AL10 -- database SPI stays beside its wire adapter in the required 14-file architecture
export interface LocalDatabase {
	readonly binding: FacilityBinding<DatabaseRequest, DatabaseResponse>;
	readonly close: () => Promise<void>;
}

// stupidity:allow AL10 -- local database options stay beside their constructor in the required 14-file architecture
export interface LocalDatabaseOptions {
	/** Use `memory://` only for explicitly non-durable development. */
	readonly dataDirectory: string;
}

// stupidity:allow AL10 -- Postgres options stay beside their constructor in the required 14-file architecture
export interface PostgresDatabaseOptions {
	readonly connectionString: string;
	readonly ssl?: boolean;
}

// stupidity:allow AL10 -- database provider lifecycle stays beside its constructors in the required 14-file architecture
export interface DatabaseProvider {
	readonly binding: FacilityBinding<DatabaseRequest, DatabaseResponse>;
	readonly close: () => Promise<void>;
}

// stupidity:allow AL10 -- private decoded row carrier stays beside the Postgres boundary in the required 14-file architecture
type PostgresRow = Record<string, unknown>;

/** Converts driver-specific row values into Schema.Json-safe data. */
const jsonSafe = (value: unknown): unknown => {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'bigint') return value.toString();
	if (Buffer.isBuffer(value)) return value.toString('base64');
	if (Array.isArray(value)) return value.map(jsonSafe);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)])
		);
	}
	return value;
};

/** Creates the durable PostgreSQL provider used by production self-host deployments. */
export const makePostgresDatabase = ({
	connectionString,
	ssl = true
}: PostgresDatabaseOptions): DatabaseProvider => {
	const clientOptions = {
		connectionString,
		...(ssl ? { ssl: { rejectUnauthorized: true } } : {})
	};

	const runQuery = (signal: AbortSignal, input: Extract<DatabaseRequest, { _tag: 'Query' }>) =>
		Effect.gen(function* () {
			const client = new Client(clientOptions);
			yield* Effect.acquireRelease(
				Effect.tryPromise(() => client.connect()),
				() => Effect.tryPromise(() => client.end()).pipe(Effect.catch(() => Effect.succeed(undefined)))
			);
			const result = yield* Effect.tryPromise(() =>
				client.query<PostgresRow>(input.sql, Array.from(input.parameters))
			);
			if (signal.aborted) {
				return yield* Effect.fail(
					makeWireError('database.cancelled', 'Database result is unknown after cancellation', {
						outcome: 'unknown'
					})
				);
			}
			return success(
				yield* Schema.decodeUnknownEffect(DatabaseResponse)({
					rows: result.rows.map(jsonSafe),
					affectedRows: result.rowCount ?? 0
				})
			);
		});

	const runTransaction = (
		signal: AbortSignal,
		input: Extract<DatabaseRequest, { _tag: 'Transaction' }>
	) =>
		Effect.gen(function* () {
			const client = new Client(clientOptions);
			yield* Effect.acquireRelease(
				Effect.tryPromise(() => client.connect()),
				() => Effect.tryPromise(() => client.end()).pipe(Effect.catch(() => Effect.succeed(undefined)))
			);
			const completed = yield* Effect.gen(function* () {
				yield* Effect.tryPromise(() => client.query('begin'));
				const initial: {
					readonly rows: ReadonlyArray<PostgresRow>;
					readonly affectedRows: number;
				} = { rows: [], affectedRows: 0 };
				const settled = yield* Effect.forEach(input.statements, (statement) =>
					Effect.gen(function* () {
						if (signal.aborted) return yield* Effect.fail(signal.reason);
						const result = yield* Effect.tryPromise(() =>
							client.query<PostgresRow>(statement.sql, Array.from(statement.parameters))
						);
						return { rows: result.rows, affectedRows: result.rowCount ?? 0 };
					})
				);
				yield* Effect.tryPromise(() => client.query('commit'));
				return {
					rows: settled.at(-1)?.rows ?? initial.rows,
					affectedRows: settled.reduce((total, entry) => total + entry.affectedRows, initial.affectedRows)
				};
			}).pipe(
				Effect.catch((cause) =>
					Effect.tryPromise(() => client.query('rollback'))
						.pipe(Effect.catch(() => Effect.succeed(undefined)))
						.pipe(Effect.andThen(() => Effect.fail(cause)))
				)
			);
			return success(
				yield* Schema.decodeUnknownEffect(DatabaseResponse)({
					rows: completed.rows.map(jsonSafe),
					affectedRows: completed.affectedRows
				})
			);
		});

	const binding: FacilityBinding<DatabaseRequest, DatabaseResponse> = {
		call: (unsafeMetadata, unsafeInput, signal) =>
			Effect.runPromise(
				Effect.gen(function* () {
					yield* Schema.decodeUnknownEffect(FacilityCall)(unsafeMetadata);
					const input = yield* Schema.decodeUnknownEffect(DatabaseRequest)(unsafeInput);
					if (signal.aborted) {
						return failure(makeWireError('database.cancelled', 'Database call was cancelled'));
					}
					if (input._tag === 'Query') return yield* Effect.scoped(runQuery(signal, input));
					return yield* Effect.scoped(runTransaction(signal, input));
				}).pipe(
					Effect.catch((cause) => {
						// The PGlite adapter reported its cause and this one did not, which is backwards: PGlite
						// fails for reasons the calling code chose, while a managed database fails for reasons only
						// the driver knows. Without the detail an unreachable host and a wrong password are the
						// same sentence, so a misconfigured connection reads as a broken query.
						const detail = cause instanceof Error ? cause.message : String(cause);
						return Effect.succeed(
							failure(
								makeWireError('database.failed', `PostgreSQL operation failed: ${detail}`, {
									retryable: !signal.aborted,
									outcome: signal.aborted ? 'unknown' : 'known'
								})
							)
						);
					})
				)
			)
	};

	return { binding, close: async () => undefined };
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
export const makeLocalDatabase = async ({
	dataDirectory
}: LocalDatabaseOptions): Promise<LocalDatabase> => {
	// PGlite ships these but registers none by default, so `create extension` answered "not
	// available" and the schema plan could install nothing. That silently cost two features: free-text
	// search fell back to a sequential `ilike` because no trigram index could exist, and the
	// effective-dating EXCLUDE constraints could not be created at all — leaving the local database
	// willing to hold overlapping temporal rows the application assumes are impossible.
	//
	// Registering them here rather than per-caller keeps local development honest about what the
	// deployed database can do; a test that cannot express a constraint cannot prove one.
	const database = await PGlite.create(dataDirectory, {
		extensions: { pg_trgm, btree_gist, vector }
	});

	const binding: FacilityBinding<DatabaseRequest, DatabaseResponse> = {
		call: (unsafeMetadata, unsafeInput, signal) =>
			Effect.runPromise(
				Effect.gen(function* () {
					yield* Schema.decodeUnknownEffect(FacilityCall)(unsafeMetadata);
					const input = yield* Schema.decodeUnknownEffect(DatabaseRequest)(unsafeInput);
					if (signal.aborted) {
						return failure(makeWireError('database.cancelled', 'Database call was cancelled'));
					}

					if (input._tag === 'Query') {
						const result = yield* Effect.tryPromise(() =>
							database.query<Record<string, unknown>>(input.sql, Array.from(input.parameters))
						);
						if (signal.aborted) {
							return failure(
								makeWireError('database.cancelled', 'Database result is unknown after cancellation', {
									outcome: 'unknown'
								})
							);
						}
						return success(
							yield* Schema.decodeUnknownEffect(DatabaseResponse)({
								rows: result.rows.map(jsonSafe),
								affectedRows: result.affectedRows ?? 0
							})
						);
					}

					const response = yield* Effect.tryPromise(() =>
						database.transaction(async (transaction) => {
							const initial: {
								readonly rows: ReadonlyArray<Record<string, unknown>>;
								readonly affectedRows: number;
							} = { rows: [], affectedRows: 0 };
							const completed = await Effect.runPromise(
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
								)
							);
							return Schema.decodeUnknownSync(DatabaseResponse)({
								rows: completed.at(-1)?.rows.map(jsonSafe) ?? initial.rows,
								affectedRows: completed.reduce(
									(total, entry) => total + entry.affectedRows,
									initial.affectedRows
								)
							});
						})
					);

					return success(response);
				}).pipe(
					Effect.catch((cause) => {
						const detail = cause instanceof Error ? cause.message : String(cause);
						return Effect.succeed(
							failure(
								makeWireError('database.failed', `Local database operation failed: ${detail}`, {
									retryable: !signal.aborted,
									outcome: signal.aborted ? 'unknown' : 'known'
								})
							)
						);
					})
				)
			)
	};

	return { binding, close: () => database.close() };
};

/** Exposes local, production, and Config-selected database construction. */
export const DatabaseFacilities = {
	local: makeLocalDatabase,
	postgres: makePostgresDatabase,
	fromConfig: makeDatabaseFromConfig
};
