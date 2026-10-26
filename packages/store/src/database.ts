import { q } from './catalog.ts';
import type { Sql } from './read/sql.ts';

/** Fixed PostgreSQL catalog/administration programs. Identifiers are quoted; values stay parameters. */
export const postgresMaintenance = {
	identity: { text: 'SELECT current_database() AS name', params: [] } satisfies Sql,
	wal: { text: 'SELECT pg_current_wal_lsn()::text AS lsn', params: [] } satisfies Sql,
	checkpoint: { text: 'CHECKPOINT', params: [] } satisfies Sql,
	preferClone: { text: 'SET file_copy_method = clone', params: [] } satisfies Sql,
	create: (name: string, template?: string): Sql => ({
		text: `CREATE DATABASE ${q(name)}${template === undefined ? '' : ` TEMPLATE ${q(template)} STRATEGY FILE_COPY`}`,
		params: []
	}),
	drop: (name: string): Sql => ({
		text: `DROP DATABASE IF EXISTS ${q(name)} WITH (FORCE)`,
		params: []
	}),
	terminate: (name: string): Sql => ({
		text: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
		params: [name]
	}),
	list: (prefix: string, excluding: string): Sql => ({
		text: 'SELECT datname FROM pg_database WHERE starts_with(datname,$1) AND NOT starts_with(datname,$2) ORDER BY datname',
		params: [prefix, excluding]
	}),
	size: (name?: string): Sql => ({
		text: `SELECT pg_database_size(${name === undefined ? 'current_database()' : '$1'})::text AS n`,
		params: name === undefined ? [] : [name]
	}),
	lock: (key: string, mode: 'shared' | 'exclusive', release = false): Sql => ({
		text: `SELECT pg_advisory_${release ? 'unlock' : 'lock'}${mode === 'shared' ? '_shared' : ''}(hashtext($1))`,
		params: [key]
	})
};

/** Native SQLite file ownership: the connection retains exclusion until it closes. */
export const sqliteOwnership = { text: 'BEGIN EXCLUSIVE', params: [] } satisfies Sql;
