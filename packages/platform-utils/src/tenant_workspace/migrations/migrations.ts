import type { Client } from '@neondatabase/serverless';
import { createHash } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';

export type OrderedMigration = {
	tag: string;
	sql: string;
};

const MIGRATIONS_TABLE = '"__drizzle_migrations"';
const journalSchema = z.object({
	entries: z.array(z.object({ tag: z.string().optional() })).optional()
});

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function resolveMigrationSqlPath(drizzleDir: string, tag: string): Promise<string | null> {
	const candidates = [join(drizzleDir, tag, 'migration.sql'), join(drizzleDir, `${tag}.sql`)];
	// stupidity:allow A6 -- candidate priority is part of the migration format contract
	for (const candidate of candidates) {
		if (await pathExists(candidate)) return candidate;
	}
	return null;
}

export async function loadOrderedMigrations(drizzleDir: string): Promise<OrderedMigration[]> {
	const journalPath = join(drizzleDir, 'meta', '_journal.json');
	if (await pathExists(journalPath)) {
		const journal = journalSchema.parse(JSON.parse(await readFile(journalPath, 'utf8')));
		const steps: OrderedMigration[] = [];
		// stupidity:allow A6 -- journal order is the migration execution order
		for (const entry of journal.entries ?? []) {
			const tag = entry.tag?.trim();
			if (!tag) continue;
			const sqlPath = await resolveMigrationSqlPath(drizzleDir, tag);
			if (!sqlPath) {
				throw new Error(`Missing migration SQL for journal tag "${tag}" under ${drizzleDir}`);
			}
			steps.push({ tag, sql: await readFile(sqlPath, 'utf8') });
		}
		if (steps.length > 0) return steps;
	}

	const paths: string[] = [];
	await collectSqlFiles(drizzleDir, paths);
	paths.sort();
	return Promise.all(
		paths.map(async (sqlPath) => ({
			tag: migrationTagForPath(sqlPath),
			sql: await readFile(sqlPath, 'utf8')
		}))
	);
}

/**
 * drizzle-kit v1 emits `<timestamp>_<name>/migration.sql` with no journal —
 * the folder name is the migration's identity. An index-based tag would give
 * every bundle's first migration the same index-based tag, so
 * a newly generated migration collides with the bootstrap baseline's tag and
 * is silently skipped by applyPendingMigrations.
 */
function migrationTagForPath(sqlPath: string): string {
	if (basename(sqlPath) === 'migration.sql') return basename(dirname(sqlPath));
	return basename(sqlPath, '.sql');
}

async function collectSqlFiles(dir: string, paths: string[]): Promise<void> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	// stupidity:allow A6 -- recursive traversal is serialized for deterministic path ordering
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			await collectSqlFiles(fullPath, paths);
		} else if (entry.isFile() && entry.name.endsWith('.sql')) {
			paths.push(fullPath);
		}
	}
}

async function ensureMigrationsTable(client: Client): Promise<void> {
	await client.query(`
		CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
			id serial PRIMARY KEY,
			tag text NOT NULL UNIQUE,
			created_at timestamptz NOT NULL DEFAULT now()
		)
	`);
	await client.query(`ALTER TABLE ${MIGRATIONS_TABLE} ADD COLUMN IF NOT EXISTS sql_hash text`);
}

function sqlHash(sql: string): string {
	return createHash('sha256').update(sql).digest('hex');
}

async function readAppliedMigrations(
	client: Client
): Promise<{ tags: Set<string>; hashes: Set<string> }> {
	await ensureMigrationsTable(client);
	const result = await client.query<{ tag: string; sql_hash: string | null }>(
		`SELECT tag, sql_hash FROM ${MIGRATIONS_TABLE}`
	);
	return {
		tags: new Set(result.rows.map((row) => row.tag)),
		hashes: new Set(result.rows.map((row) => row.sql_hash).filter((h): h is string => !!h))
	};
}

export async function applyPendingMigrations(
	client: Client,
	migrations: readonly OrderedMigration[]
): Promise<void> {
	const applied = await readAppliedMigrations(client);

	// stupidity:allow A6 -- migrations must execute and be recorded in order
	for (const migration of migrations) {
		if (applied.tags.has(migration.tag)) continue;
		const hash = sqlHash(migration.sql);
		// Hash-skip only baseline-shaped migrations (they CREATE tables): an
		// intentional add→drop→re-add column cycle emits byte-identical ALTERs
		// that must re-run, but a re-created table never legitimately repeats.
		if (applied.hashes.has(hash) && /\bCREATE TABLE\b/i.test(migration.sql)) {
			// Same SQL was already applied under a different tag. drizzle-kit v1
			// names migration folders randomly, so a bundle built from a source
			// tree with no committed journal regenerates the baseline under a new
			// name; re-executing it would fail on existing relations. Record the
			// tag as applied instead.
			await client.query(
				`INSERT INTO ${MIGRATIONS_TABLE} (tag, sql_hash) VALUES ($1, $2) ON CONFLICT (tag) DO NOTHING`,
				[migration.tag, hash]
			);
			continue;
		}
		await client.query(migration.sql);
		await client.query(
			`INSERT INTO ${MIGRATIONS_TABLE} (tag, sql_hash) VALUES ($1, $2) ON CONFLICT (tag) DO NOTHING`,
			[migration.tag, hash]
		);
		applied.hashes.add(hash);
	}
}
