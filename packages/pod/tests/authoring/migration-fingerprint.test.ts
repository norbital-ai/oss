import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	migrationFingerprint,
	readMigrationFingerprint,
	writeMigrationFingerprint
} from '../../src/lib/vite/migration-fingerprint.js';

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{
	root: string;
	schema: string;
	migrations: string;
	migration: string;
}> {
	const root = await mkdtemp(path.join(tmpdir(), 'pod-migration-fingerprint-'));
	temporaryDirectories.push(root);
	const schema = path.join(root, 'registry.ts');
	const migrations = path.join(root, 'migrations');
	const migration = path.join(migrations, '0001_initial', 'migration.sql');
	await mkdir(path.dirname(migration), { recursive: true });
	await writeFile(schema, 'export const registry = {};\n');
	await writeFile(migration, 'CREATE TABLE example (id uuid PRIMARY KEY);\n');
	return { root, schema, migrations, migration };
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

describe('migration fingerprint', () => {
	it('round-trips without fingerprinting the marker itself', async () => {
		const { schema, migrations } = await fixture();
		const fingerprint = await migrationFingerprint([schema], migrations);
		await writeMigrationFingerprint(migrations, fingerprint);
		expect(await readMigrationFingerprint(migrations)).toEqual(fingerprint);
		expect(await migrationFingerprint([schema], migrations)).toEqual(fingerprint);
	});

	it('invalidates when schema input changes', async () => {
		const { schema, migrations } = await fixture();
		const fingerprint = await migrationFingerprint([schema], migrations);
		await writeFile(schema, 'export const registry = { changed: true };\n');
		expect(await migrationFingerprint([schema], migrations)).not.toEqual(fingerprint);
	});

	it('invalidates when an imported model changes behind a stable generated entry module', async () => {
		const { root, schema, migrations } = await fixture();
		const model = path.join(root, 'model.ts');
		await writeFile(schema, "export { model } from './model.js';\n");
		await writeFile(model, "export const model = { status: 'text' };\n");
		const fingerprint = await migrationFingerprint([schema], migrations);
		await writeFile(model, "export const model = { status: 'text', reference: 'text' };\n");
		expect(await migrationFingerprint([schema], migrations)).not.toEqual(fingerprint);
	});

	it('invalidates when versioned migration history changes', async () => {
		const { schema, migrations, migration } = await fixture();
		const fingerprint = await migrationFingerprint([schema], migrations);
		await writeFile(migration, 'CREATE TABLE edited (id uuid PRIMARY KEY);\n');
		expect(await migrationFingerprint([schema], migrations)).not.toEqual(fingerprint);
	});
});
