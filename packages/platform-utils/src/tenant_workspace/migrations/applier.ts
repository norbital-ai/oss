import { Client } from '@neondatabase/serverless';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyPendingMigrations, loadOrderedMigrations } from './migrations.js';
import { DdlApplyError, DdlGenerateError } from './errors.js';

const MIGRATIONS_DIR_REL = join('.norbital', 'migrations');

export type ApplyMigrationsInput = {
	readonly connStr: string;
	readonly bundleDir: string;
	/**
	 * Optional pre-connected client. When provided, the caller owns the
	 * transaction lifecycle (BEGIN/COMMIT/ROLLBACK) — `applyMigrations` runs the
	 * DDL inside the caller's current transaction without issuing BEGIN/COMMIT.
	 * When omitted, `applyMigrations` connects with `connStr` and wraps the
	 * work in its own transaction.
	 */
	readonly client?: Client;
};

async function readBundleArtifacts(bundleDir: string): Promise<{
	schemaFunctionsSql: string;
	schemaPostDdlSql: string;
	migrations: Awaited<ReturnType<typeof loadOrderedMigrations>>;
}> {
	const schemaFunctionsPath = join(bundleDir, 'schema-functions.sql');
	const schemaPostDdlPath = join(bundleDir, 'schema-post-ddl.sql');
	const migrationsDir = join(bundleDir, MIGRATIONS_DIR_REL);
	const schemaFunctionsSql = await readFile(schemaFunctionsPath, 'utf8');
	const schemaPostDdlSql = await readFile(schemaPostDdlPath, 'utf8');
	const migrations = await loadOrderedMigrations(migrationsDir);
	return { schemaFunctionsSql, schemaPostDdlSql, migrations };
}

async function runDdl(
	client: Client,
	artifacts: {
		schemaFunctionsSql: string;
		schemaPostDdlSql: string;
		migrations: Awaited<ReturnType<typeof loadOrderedMigrations>>;
	}
): Promise<void> {
	await client.query(artifacts.schemaFunctionsSql);
	await applyPendingMigrations(client, artifacts.migrations);
	await client.query(artifacts.schemaPostDdlSql);
}

export async function applyMigrations(input: ApplyMigrationsInput): Promise<void> {
	const { connStr, bundleDir, client: suppliedClient } = input;
	let artifacts;
	try {
		artifacts = await readBundleArtifacts(bundleDir);
	} catch (cause) {
		throw new DdlGenerateError(`Failed to read DDL artifacts from bundle: ${bundleDir}`, {
			bundleDir,
			cause
		});
	}

	if (suppliedClient) {
		try {
			await runDdl(suppliedClient, artifacts);
		} catch (cause) {
			throw new DdlApplyError(
				`DDL apply failed: ${cause instanceof Error ? cause.message : String(cause)}`,
				{ dbUrl: connStr, cause }
			);
		}
		return;
	}

	const client = new Client({ connectionString: connStr });
	await client.connect();
	try {
		await client.query('BEGIN');
		try {
			await runDdl(client, artifacts);
			await client.query('COMMIT');
		} catch (cause) {
			await client.query('ROLLBACK').catch(() => {});
			throw new DdlApplyError(
				`DDL apply failed: ${cause instanceof Error ? cause.message : String(cause)}`,
				{ dbUrl: connStr, cause }
			);
		}
	} finally {
		await client.end().catch(() => {});
	}
}
