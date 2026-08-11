import { access, mkdir, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';

async function linkMissingEntries(source: string, target: string): Promise<void> {
	for (const entry of await readdir(source, { withFileTypes: true })) {
		if (entry.name === '@norbital-ai') continue;
		const destination = path.join(target, entry.name);
		try {
			await access(destination);
		} catch {
			await symlink(path.join(source, entry.name), destination);
		}
	}
}

/**
 * Link a generated workspace to the package graph under test, not the stale template fixture's
 * published beta dependencies. The fixture is source only; package conformance must exercise the
 * checkout that owns the test.
 */
export async function linkCurrentPodWorkspaceDependencies(
	repositoryRoot: string,
	workspaceRoot: string,
	templateNodeModules?: string
): Promise<void> {
	const source = path.join(repositoryRoot, 'packages/pod/node_modules');
	const target = path.join(workspaceRoot, 'node_modules');
	await mkdir(target, { recursive: true });
	if (templateNodeModules) await linkMissingEntries(templateNodeModules, target);
	await linkMissingEntries(source, target);
	const targetScope = path.join(target, '@norbital-ai');
	await mkdir(targetScope, { recursive: true });
	for (const packageName of ['config', 'platform-utils', 'std', 'ui']) {
		await symlink(
			path.join(repositoryRoot, 'packages', packageName),
			path.join(targetScope, packageName)
		);
	}
	await symlink(path.join(repositoryRoot, 'packages/pod'), path.join(targetScope, 'pod'));
}
