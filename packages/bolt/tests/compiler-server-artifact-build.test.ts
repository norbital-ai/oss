import {
	cp,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	symlink,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Effect, Schema } from 'effect';
import {
	ARTIFACT_BUNDLE_FILE,
	ARTIFACT_RELEASE_FILE,
	artifactCodeGraphRefusals,
	TenantRelease
} from '@norbital-ai/bolt-protocol';
import { generateWorkspaceMigration } from '../src/compiler/schema-migrations.js';
import { syncWorkspace } from '../src/compiler/workspace-build.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesRoot = dirname(packageRoot);

const materializeInstalledDependencies = async (source: string, target: string): Promise<void> => {
	await mkdir(target, { recursive: true });
	for (const entry of await readdir(source, { withFileTypes: true })) {
		if (entry.name === '@norbital-ai') continue;
		const sourceEntry = join(source, entry.name);
		const targetEntry = join(target, entry.name);
		if (!entry.name.startsWith('@')) {
			await symlink(await realpath(sourceEntry), targetEntry, 'dir');
			continue;
		}
		await mkdir(targetEntry, { recursive: true });
		for (const child of await readdir(sourceEntry)) {
			await symlink(await realpath(join(sourceEntry, child)), join(targetEntry, child), 'dir');
		}
	}
};

const materializeBuiltPackage = async (scope: string, name: string): Promise<void> => {
	const source = join(packagesRoot, name);
	const target = join(scope, name);
	await mkdir(target, { recursive: true });
	await Promise.all([
		cp(join(source, 'build'), join(target, 'build'), { recursive: true }),
		copyFile(join(source, 'package.json'), join(target, 'package.json'))
	]);
	await materializeInstalledDependencies(
		join(source, 'node_modules'),
		join(target, 'node_modules')
	);
};

/**
 * Whether one named ESM export remains on the emitted entry facade.
 *
 * This reads syntax only. Compiler tests must never import or otherwise evaluate a tenant artifact:
 * the isolate boundary, rather than the compiler process, owns guest execution.
 */
const hasNamedExport = (source: string, name: string): boolean => {
	if (new RegExp(`\\bexport\\s+(?:const|let|var|function|class)\\s+${name}\\b`).test(source))
		return true;
	return [...source.matchAll(/\bexport\s*\{([\s\S]*?)\}/g)].some(([, members = '']) =>
		members.split(',').some((member) => {
			const normalized = member.trim().replaceAll(/\s+/g, ' ');
			return normalized === name || normalized.endsWith(` as ${name}`);
		})
	);
};

describe('server artifact build', () => {
	it('executes both Vite builds and retains a closed static server facade', async () => {
		const root = await mkdtemp(join(tmpdir(), 'bolt-server-artifact-build-'));
		try {
			const collectionDirectory = join(root, 'src', 'collections', 'tickets');
			const packageScope = join(root, 'node_modules', '@norbital-ai');
			await Promise.all([
				mkdir(collectionDirectory, { recursive: true }),
				mkdir(packageScope, { recursive: true })
			]);
			// Materialize the package under test as a consumer sees it. A symlink resolves back to the
			// source tree and makes package Svelte files look authored to the workspace audit; preserving
			// that symlink instead breaks pnpm's peer layout. The published surface is the build plus its
			// manifest, and third-party dependencies still resolve from the ancestor package install.
			await Promise.all(
				['bolt', 'bolt-protocol', 'std', 'ui'].map((name) =>
					materializeBuiltPackage(packageScope, name)
				)
			);
			// The workspace's own `vite.config.ts` imports `vite`, and Vite evaluates that config from
			// `<root>/node_modules/.vite-temp/`, so `vite` has to resolve from the root itself — a temp
			// directory has no ancestor install to fall back on.
			await materializeInstalledDependencies(
				join(packagesRoot, 'bolt', 'node_modules'),
				join(root, 'node_modules')
			);
			await Promise.all([
				mkdir(join(packageScope, 'ui', 'src'), { recursive: true }),
				cp(join(packagesRoot, 'ui', 'assets'), join(packageScope, 'ui', 'assets'), {
					recursive: true
				})
			]);
			await copyFile(
				join(packagesRoot, 'ui', 'src', 'base.css'),
				join(packageScope, 'ui', 'src', 'base.css')
			);
			await Promise.all([
				writeFile(
					join(root, 'package.json'),
					`${JSON.stringify(
						{
							name: '@template/server-artifact-build',
							version: '0.0.1',
							private: true,
							type: 'module'
						},
						null,
						'\t'
					)}\n`,
					'utf8'
				),
				writeFile(
					join(root, 'vite.config.ts'),
					[
						"import { defineConfig } from 'vite';",
						"import { bolt } from '@norbital-ai/bolt/vite';",
						'',
						'export default defineConfig({ plugins: [bolt()] });',
						''
					].join('\n'),
					'utf8'
				),
				writeFile(
					join(collectionDirectory, '+model.ts'),
					[
						"import { defineModel, text } from '@norbital-ai/bolt/authoring';",
						'',
						"export default defineModel({ subject: text().notNull() }, { recordLabel: 'subject' });",
						''
					].join('\n'),
					'utf8'
				),
				writeFile(
					join(root, 'src', '+agents.md'),
					'# Fixture desk\n\nAnswer questions about the ticket collection.\n',
					'utf8'
				)
			]);

			await Effect.runPromise(generateWorkspaceMigration(root, 'baseline'));
			const result = await Effect.runPromise(syncWorkspace(root));
			const artifactDirectory = dirname(result.artifactPath);
			const [entrySource, releaseSource] = await Promise.all([
				readFile(join(artifactDirectory, ARTIFACT_BUNDLE_FILE), 'utf8'),
				readFile(join(artifactDirectory, ARTIFACT_RELEASE_FILE), 'utf8')
			]);
			const release = Schema.decodeUnknownSync(Schema.fromJsonString(TenantRelease))(releaseSource);

			expect(result.artifactPath).toBe(join(artifactDirectory, ARTIFACT_BUNDLE_FILE));
			expect(result.releasePath).toBe(join(artifactDirectory, ARTIFACT_RELEASE_FILE));
			expect(entrySource.length).toBeGreaterThan(0);
			expect(release.code.entrypoint).toBe(ARTIFACT_BUNDLE_FILE);
			expect(release.code.chunks.map(({ path }) => path)).toContain(ARTIFACT_BUNDLE_FILE);
			expect(release.code.chunks.some(({ path }) => path.startsWith('code/'))).toBe(true);
			expect(release.code.chunks.every(({ dynamicImports }) => dynamicImports.length === 0)).toBe(
				true
			);
			expect(artifactCodeGraphRefusals(release.code)).toEqual([]);
			await Promise.all(
				release.code.chunks.map(({ path }) => readFile(join(artifactDirectory, path)))
			);

			for (const name of ['protocolVersion', 'manifest', 'dispatch', 'activate'])
				expect(hasNamedExport(entrySource, name), `missing server facade export ${name}`).toBe(
					true
				);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 120_000);
});
