import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GenerateDrizzleMigrationInput {
	readonly sourceDir: string;
	readonly outDir: string;
	readonly name: string;
	readonly schemaFiles: readonly string[];
	readonly custom?: boolean;
}

/** Generate a Drizzle migration from the supplied workspace and framework schema files. */
export async function generateDrizzleMigration(input: GenerateDrizzleMigrationInput): Promise<void> {
	const drizzlePackageEntry = fileURLToPath(import.meta.resolve('drizzle-kit'));
	const drizzleBin = path.join(drizzlePackageEntry, '..', 'bin.cjs');
	const sourceDir = path.resolve(input.sourceDir);
	const outDir = path.resolve(input.outDir);
	const configFile = path.join(outDir, '.norbital-drizzle.config.mjs');

	await mkdir(outDir, { recursive: true });
	await writeFile(
		configFile,
		`export default ${JSON.stringify({
			schema: input.schemaFiles.map((schemaFile) => path.resolve(schemaFile)),
			out: outDir,
			dialect: 'postgresql',
			dbCredentials: { url: 'postgres://placeholder' }
		})};\n`
	);

	const args = [drizzleBin, 'generate', `--config=${configFile}`, `--name=${input.name}`];
	if (input.custom) args.push('--custom');
	try {
		await execFileAsync(process.execPath, args, {
			cwd: sourceDir,
			env: { ...process.env, NODE_NO_WARNINGS: '1', CI: '1' },
			maxBuffer: 16 * 1024 * 1024
		});
	} finally {
		await rm(configFile, { force: true });
	}
}
