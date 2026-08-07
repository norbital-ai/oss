import { Client } from '@neondatabase/serverless';
import { protectedSchemaBootstrapSql, PROTECTED_AUTH_SCHEMA } from './schema.js';

export const REQUIRED_POSTGRES_MAJOR = 18;

type QueryableClient = {
	query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

type VersionRow = {
	server_version_num: string;
};

function parsePostgresMajor(serverVersionNum: string): number {
	const version = Number.parseInt(serverVersionNum, 10);
	if (!Number.isFinite(version)) {
		throw new Error(`Unable to parse PostgreSQL version: ${serverVersionNum}`);
	}
	return Math.floor(version / 10000);
}

export async function assertPostgresMajorVersion(
	client: QueryableClient,
	minMajor = REQUIRED_POSTGRES_MAJOR
): Promise<void> {
	const result = await client.query<VersionRow>(
		`SELECT current_setting('server_version_num') AS server_version_num`
	);
	const major = parsePostgresMajor(result.rows[0]?.server_version_num ?? '');
	if (major < minMajor) {
		throw new Error(
			`PostgreSQL ${minMajor}+ is required; connected database is PostgreSQL ${major}`
		);
	}
}

export async function assertUuidV7Available(client: QueryableClient): Promise<void> {
	await client.query<{ uuidv7: string }>(`SELECT uuidv7()`);
}

export async function resetTenantDatabase(connectionString: string): Promise<void> {
	const client = new Client({ connectionString });
	client.on('error', (error) => {
		console.warn('[tenant-db] reset connection dropped', error);
	});
	await client.connect();
	try {
		await client.query('DROP SCHEMA IF EXISTS public CASCADE');
		await client.query(`DROP SCHEMA IF EXISTS "${PROTECTED_AUTH_SCHEMA}" CASCADE`);
		await client.query('CREATE SCHEMA public');
		await client.query(protectedSchemaBootstrapSql());
	} finally {
		await client.end();
	}
}

export async function ensureDatabaseBootstrap(connectionString: string): Promise<void> {
	const client = new Client({ connectionString });
	client.on('error', (error) => {
		console.warn('[tenant-db] bootstrap connection dropped', error);
	});
	await client.connect();
	try {
		await assertPostgresMajorVersion(client);
		await assertUuidV7Available(client);
	} finally {
		await client.end();
	}
}
