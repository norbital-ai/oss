import { Pool, type CustomTypesConfig, type PoolClient, type QueryResult, types } from 'pg';
import type {
	DbQueryConfig,
	DbQueryInput,
	DbQueryResult,
	HostDbBinding
} from '@norbital-ai/platform-utils/runtime/binding';

/**
 * A live database connection plus the two things a host needs beyond querying: a way to prove the
 * server is usable before anything is served, and a way to let go of it on shutdown.
 */
export type HostDbConnection = HostDbBinding & {
	/** Reject an unusable server at startup rather than on the first request. */
	validate(): Promise<void>;
	close(): Promise<void>;
	/**
	 * The connection string, for the tools that take one rather than a binding — migrations and
	 * seeding both open their own single-connection client so they can own a transaction.
	 */
	readonly connectionString: string;
};

/** Names a database and knows how to open it. Adapters are values, so a config file stays data. */
export type HostDbAdapter = {
	readonly name: string;
	readonly connectionString: string;
	connect(): HostDbConnection;
};

/**
 * A `date` column is a calendar day. The stock `pg` parser builds `new Date(y, m-1, d)` at
 * **local** midnight, which is a different civil day after JSON or a timezone shift. Drizzle's
 * `PgDateString` already wants `YYYY-MM-DD`. This override is scoped to this adapter's queries,
 * not the process-wide `pg` type registry.
 */
const DATE_AS_DAY: CustomTypesConfig = {
	getTypeParser: (oid, format) =>
		oid === types.builtins.DATE && format !== 'binary'
			? (day: string) => day
			: types.getTypeParser(oid, format)
};

function queryResult(result: QueryResult): DbQueryResult {
	return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
}

async function runQuery(
	client: Pool | PoolClient,
	input: DbQueryInput,
	params?: readonly unknown[]
): Promise<DbQueryResult> {
	if (typeof input === 'string') {
		return queryResult(
			await client.query({
				text: input,
				types: DATE_AS_DAY,
				...(params ? { values: [...params] } : {})
			})
		);
	}
	const config: DbQueryConfig = input;
	return queryResult(
		await client.query({
			text: config.text,
			types: DATE_AS_DAY,
			...(config.values ? { values: [...config.values] } : {}),
			...(config.rowMode ? { rowMode: config.rowMode } : {})
		})
	);
}

/**
 * A `pg` pool behind the host db binding.
 *
 * Transactions are the reason this is not a bare pool. `begin` checks out a connection and keeps
 * it until `commit` or `rollback`, because Postgres transaction state lives on the connection —
 * running the statements of one transaction across pooled connections would interleave them with
 * other work and silently break atomicity.
 */
export class PostgresHostDbBinding implements HostDbConnection {
	readonly #pool: Pool;
	readonly #ownsPool: boolean;
	readonly #transactions = new Map<string, PoolClient>();
	readonly connectionString: string;

	constructor(
		connectionString: string,
		options: { readonly maxConnections?: number; readonly pool?: Pool } = {}
	) {
		this.connectionString = connectionString;
		this.#ownsPool = options.pool == null;
		this.#pool =
			options.pool ??
			new Pool({
				connectionString,
				...(options.maxConnections ? { max: options.maxConnections } : {})
			});
	}

	async validate(): Promise<void> {
		const result = await this.#pool.query<{ server_version_num: string }>(
			`SELECT current_setting('server_version_num') AS server_version_num`
		);
		const version = Number(result.rows[0]?.server_version_num);
		if (!Number.isInteger(version) || version < 180_000) {
			throw new Error(`Standalone Pod requires PostgreSQL 18 or newer; server reported ${version}`);
		}
	}

	query(sql: DbQueryInput, params?: readonly unknown[]): Promise<DbQueryResult> {
		return runQuery(this.#pool, sql, params);
	}

	async begin(): Promise<string> {
		const transactionId = crypto.randomUUID();
		const client = await this.#pool.connect();
		try {
			await client.query('BEGIN');
			await client.query(`SELECT set_config('norbital.via_ops', 'on', true)`);
			this.#transactions.set(transactionId, client);
			return transactionId;
		} catch (cause) {
			client.release();
			throw cause;
		}
	}

	txQuery(
		transactionId: string,
		sql: DbQueryInput,
		params?: readonly unknown[]
	): Promise<DbQueryResult> {
		return runQuery(this.#transaction(transactionId), sql, params);
	}

	async batch(statements: readonly DbQueryConfig[]): Promise<readonly DbQueryResult[]> {
		const client = await this.#pool.connect();
		try {
			await client.query('BEGIN');
			await client.query(`SELECT set_config('norbital.via_ops', 'on', true)`);
			const results: DbQueryResult[] = [];
			for (const statement of statements) {
				results.push(await runQuery(client, statement));
			}
			await client.query('COMMIT');
			return results;
		} catch (cause) {
			try {
				await client.query('ROLLBACK');
			} catch {
				// connection may already be dead
			}
			throw cause;
		} finally {
			client.release();
		}
	}

	async txBatch(
		transactionId: string,
		statements: readonly DbQueryConfig[]
	): Promise<readonly DbQueryResult[]> {
		const client = this.#transaction(transactionId);
		const results: DbQueryResult[] = [];
		for (const statement of statements) {
			results.push(await runQuery(client, statement));
		}
		return results;
	}

	async commit(transactionId: string): Promise<void> {
		const client = this.#transaction(transactionId);
		try {
			await client.query('COMMIT');
		} finally {
			this.#transactions.delete(transactionId);
			client.release();
		}
	}

	async rollback(transactionId: string): Promise<void> {
		const client = this.#transaction(transactionId);
		try {
			await client.query('ROLLBACK');
		} finally {
			this.#transactions.delete(transactionId);
			client.release();
		}
	}

	async close(): Promise<void> {
		// stupidity:allow A6 -- each checked-out transaction must roll back before its client is released.
		for (const [transactionId, client] of this.#transactions) {
			try {
				await client.query('ROLLBACK');
			} catch (cause) {
				console.error(`[pod] failed to roll back transaction ${transactionId}`, cause);
			} finally {
				client.release();
			}
		}
		this.#transactions.clear();
		if (this.#ownsPool) await this.#pool.end();
	}

	#transaction(transactionId: string): PoolClient {
		const client = this.#transactions.get(transactionId);
		if (!client) throw new Error(`Unknown or completed database transaction: ${transactionId}`);
		return client;
	}
}

export type PostgresDbOptions = {
	/** Any libpq connection URL — local, Docker, RDS, Neon, Supabase. */
	readonly url: string;
	/** Pool ceiling. Defaults to the `pg` default. */
	readonly maxConnections?: number;
};

/**
 * Postgres, wherever it lives.
 *
 * There is no separate adapter for a managed provider: a hosted Postgres is reached with the same
 * URL and speaks the same protocol, so `postgresDb({ url: env('DATABASE_URL') })` is as true of a
 * container on localhost as of a remote cluster. Only the string changes.
 */
export function postgresDb(options: PostgresDbOptions): HostDbAdapter {
	const url = options.url?.trim();
	if (!url) {
		throw new Error('postgresDb requires a connection URL. Set DATABASE_URL or pass `url`.');
	}
	return {
		name: 'postgres',
		connectionString: url,
		connect: () =>
			new PostgresHostDbBinding(url, {
				...(options.maxConnections ? { maxConnections: options.maxConnections } : {})
			})
	};
}
