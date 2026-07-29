import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MIGRATION_SCHEMA_FINGERPRINT = '.schema-fingerprint.json';
const MIGRATION_SCHEMA_FINGERPRINT_VERSION = 1;

export interface MigrationFingerprint {
	readonly schemaVersion: 1;
	readonly schemaSha256: string;
	readonly historySha256: string;
}

async function migrationHistoryFiles(
	root: string,
	current = root
): Promise<Array<{ relativePath: string; contents: Buffer }>> {
	const files: Array<{ relativePath: string; contents: Buffer }> = [];
	for (const entry of await readdir(current, { withFileTypes: true })) {
		const absolutePath = path.join(current, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await migrationHistoryFiles(root, absolutePath)));
		} else if (entry.isFile() && entry.name !== MIGRATION_SCHEMA_FINGERPRINT) {
			files.push({
				relativePath: path.relative(root, absolutePath).split(path.sep).join('/'),
				contents: await readFile(absolutePath)
			});
		}
	}
	return files;
}

export async function migrationFingerprint(
	schemaFiles: readonly string[],
	migrationsRoot: string
): Promise<MigrationFingerprint> {
	const schemaHash = createHash('sha256');
	schemaHash.update(`norbital-pod-migrations-v${MIGRATION_SCHEMA_FINGERPRINT_VERSION}\0`);
	for (const [index, file] of schemaFiles.entries()) {
		schemaHash.update(`${index}\0`);
		schemaHash.update(await readFile(file));
		schemaHash.update('\0');
	}
	const historyHash = createHash('sha256');
	for (const file of (await migrationHistoryFiles(migrationsRoot)).sort((a, b) =>
		a.relativePath.localeCompare(b.relativePath)
	)) {
		historyHash.update(file.relativePath);
		historyHash.update('\0');
		historyHash.update(file.contents);
		historyHash.update('\0');
	}
	return {
		schemaVersion: MIGRATION_SCHEMA_FINGERPRINT_VERSION,
		schemaSha256: schemaHash.digest('hex'),
		historySha256: historyHash.digest('hex')
	};
}

export async function readMigrationFingerprint(
	migrationsRoot: string
): Promise<MigrationFingerprint | undefined> {
	try {
		const parsed: unknown = JSON.parse(
			await readFile(path.join(migrationsRoot, MIGRATION_SCHEMA_FINGERPRINT), 'utf8')
		);
		if (
			typeof parsed === 'object' &&
			parsed != null &&
			Reflect.get(parsed, 'schemaVersion') === MIGRATION_SCHEMA_FINGERPRINT_VERSION &&
			typeof Reflect.get(parsed, 'schemaSha256') === 'string' &&
			typeof Reflect.get(parsed, 'historySha256') === 'string'
		) {
			return parsed as MigrationFingerprint;
		}
	} catch {
		// Missing and legacy migration directories are regenerated once.
	}
	return undefined;
}

export async function writeMigrationFingerprint(
	migrationsRoot: string,
	fingerprint: MigrationFingerprint
): Promise<void> {
	await writeFile(
		path.join(migrationsRoot, MIGRATION_SCHEMA_FINGERPRINT),
		`${JSON.stringify(fingerprint, null, 2)}\n`
	);
}
