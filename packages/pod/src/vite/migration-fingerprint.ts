import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MIGRATION_SCHEMA_FINGERPRINT = '.schema-fingerprint.json';
const MIGRATION_SCHEMA_FINGERPRINT_VERSION = 2;
const STATIC_MODULE_SPECIFIER = /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;

export interface MigrationFingerprint {
	readonly schemaVersion: 2;
	readonly schemaSha256: string;
	readonly historySha256: string;
}

function resolveLocalModule(importer: string, specifier: string): string | undefined {
	if (!specifier.startsWith('.')) return undefined;
	const exact = path.resolve(path.dirname(importer), specifier);
	const candidates = [exact];
	if (exact.endsWith('.js')) candidates.push(`${exact.slice(0, -3)}.ts`);
	else if (exact.endsWith('.mjs')) candidates.push(`${exact.slice(0, -4)}.mts`);
	else if (exact.endsWith('.cjs')) candidates.push(`${exact.slice(0, -4)}.cts`);
	else if (path.extname(exact) === '') {
		candidates.push(
			`${exact}.ts`,
			`${exact}.js`,
			path.join(exact, 'index.ts'),
			path.join(exact, 'index.js')
		);
	}
	return candidates.find((candidate) => existsSync(candidate));
}

async function schemaDependencyContents(entryFile: string): Promise<Buffer[]> {
	const contents: Buffer[] = [];
	const visited = new Set<string>();
	const visit = async (file: string): Promise<void> => {
		const absolute = path.resolve(file);
		if (visited.has(absolute)) return;
		visited.add(absolute);
		const source = await readFile(absolute);
		contents.push(source);
		const imports = [...source.toString('utf8').matchAll(STATIC_MODULE_SPECIFIER)]
			.map((match) => match[1])
			.filter((specifier): specifier is string => specifier != null)
			.sort();
		for (const specifier of imports) {
			const dependency = resolveLocalModule(absolute, specifier);
			if (dependency) await visit(dependency);
		}
	};
	await visit(entryFile);
	return contents;
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
		for (const [dependencyIndex, contents] of (await schemaDependencyContents(file)).entries()) {
			schemaHash.update(`${dependencyIndex}\0`);
			schemaHash.update(contents);
			schemaHash.update('\0');
		}
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
		// A missing or invalid fingerprint requires regeneration.
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
