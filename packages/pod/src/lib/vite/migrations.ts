import { existsSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateDrizzleMigration } from '@norbital-ai/platform-utils/tenant_workspace/migrations/generate';

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
	if (input.migrationsRoot !== sourceMigrations) {
		await rm(input.migrationsRoot, { recursive: true, force: true });
		await mkdir(input.migrationsRoot, { recursive: true });
		if (existsSync(sourceMigrations)) {
			await cp(sourceMigrations, input.migrationsRoot, { recursive: true });
		}
	} else {
		await mkdir(input.migrationsRoot, { recursive: true });
	}

	try {
		await generateDrizzleMigration({
			sourceDir: input.root,
			outDir: input.migrationsRoot,
			name: input.name ?? 'auto',
			custom: input.custom,
			schemaFiles: [
				path.join(input.root, '.norbital/generated/registry.ts'),
				platformSystemWorkspaceSchema
			]
		});
	} catch (caught) {
		const commandOutput =
			caught && typeof caught === 'object'
				? `${String(Reflect.get(caught, 'stdout') ?? '')}\n${String(Reflect.get(caught, 'stderr') ?? '')}`
				: '';
		if (
			commandOutput.includes('Interactive prompts require a TTY') ||
			commandOutput.includes('missing_hints')
		) {
			console.warn(
				'[pod] drizzle generation skipped: schema changes require manual migration resolution'
			);
			return;
		}
		throw caught;
	}
}
