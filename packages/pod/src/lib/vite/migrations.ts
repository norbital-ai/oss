import { existsSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
	migrationFingerprint,
	readMigrationFingerprint,
	writeMigrationFingerprint
} from './migration-fingerprint.js';
const platformSystemWorkspaceSchema = fileURLToPath(
	import.meta.resolve('@norbital-ai/platform-utils/system/workspace-schema')
);

export async function generatePodMigrations(input: {
	root: string;
	migrationsRoot: string;
	name?: string;
	custom?: boolean;
}): Promise<void> {
	const sourceMigrations = path.join(input.root, '.norbital/migrations');
	const schemaFiles = [
		path.join(input.root, '.norbital/generated/registry.ts'),
		platformSystemWorkspaceSchema
	];
	if (input.migrationsRoot !== sourceMigrations) {
		await rm(input.migrationsRoot, { recursive: true, force: true });
		await mkdir(input.migrationsRoot, { recursive: true });
		if (existsSync(sourceMigrations)) {
			await cp(sourceMigrations, input.migrationsRoot, { recursive: true });
		}
	} else {
		await mkdir(input.migrationsRoot, { recursive: true });
	}
	const fingerprint = await migrationFingerprint(schemaFiles, input.migrationsRoot);
	if (
		input.name == null &&
		input.custom !== true &&
		JSON.stringify(await readMigrationFingerprint(input.migrationsRoot)) ===
			JSON.stringify(fingerprint)
	) {
		return;
	}

	try {
		const { generateDrizzleMigration } =
			await import('@norbital-ai/platform-utils/tenant_workspace/migrations/generate');
		await generateDrizzleMigration({
			sourceDir: input.root,
			outDir: input.migrationsRoot,
			name: input.name ?? 'auto',
			custom: input.custom,
			schemaFiles
		});
		await writeMigrationFingerprint(
			input.migrationsRoot,
			await migrationFingerprint(schemaFiles, input.migrationsRoot)
		);
	} catch (caught) {
		const commandOutput =
			caught && typeof caught === 'object'
				? `${String(Reflect.get(caught, 'stdout') ?? '')}\n${String(Reflect.get(caught, 'stderr') ?? '')}`
				: '';
		if (
			commandOutput.includes('Interactive prompts require a TTY') ||
			commandOutput.includes('missing_hints')
		) {
			// Loud, not a warning. This branch used to `return`, which reported success: the schema
			// had changed, no migration was written, and everything downstream agreed the build was
			// fine. The compiler emitted the new column, `pod check` passed, the manifest listed it,
			// and the tenant database never got it — so the first query naming that column failed at
			// runtime with a bare "column does not exist", far from the step that skipped.
			//
			// A migration that cannot be generated is a build failure. The workspace author has to
			// resolve it, and the two ways are named here because the error drizzle prints does not
			// say either of them.
			throw new Error(
				'Schema changes need a migration drizzle cannot generate without being asked a question ' +
					'(usually a new NOT NULL column on a table that already has rows, or a rename it cannot ' +
					'tell from a drop-and-add).\n\n' +
					'Resolve it one of two ways:\n' +
					'  • give the column a default, or make it nullable, so the change is unambiguous; or\n' +
					'  • run `pod migrate --custom <name>` and write the migration by hand.\n\n' +
					`drizzle-kit said:\n${commandOutput.trim()}`
			);
		}
		throw caught;
	}
}
