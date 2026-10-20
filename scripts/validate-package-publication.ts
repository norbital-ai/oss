import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import { Console, Effect, FileSystem, type PlatformError } from 'effect';
import { assertDeclarationEmit } from './lib/declaration-emit.ts';
import {
	inspectPackageArchive,
	packedArchiveFilename,
	unexportedSpecifiers
} from './lib/package-archive.ts';
import { publicPackageDirectories, readManifest, type Manifest } from './lib/package-release.ts';
import { scratchRoot } from './lib/scratch.ts';
import { capture } from './lib/process.ts';
import { PublicationFailed } from './lib/error.ts';
import { ScriptLive } from './runtime.ts';
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const excluded = new Set([
	'.git',
	'node_modules',
	'build',
	'dist',
	'.turbo',
	'.svelte-kit',
	'.norbital'
]);
export const copyWorkspace = Effect.fn('Publication.copyWorkspace')(function* (
	source: string,
	destination: string
): Effect.fn.Return<void, PlatformError.PlatformError, FileSystem.FileSystem> {
	const fs = yield* FileSystem.FileSystem;
	yield* fs.makeDirectory(destination, { recursive: true });
	for (const name of yield* fs.readDirectory(source)) {
		if (excluded.has(name) || name.startsWith('build.staging') || name === 'build.retired')
			continue;
		const from = path.join(source, name);
		const to = path.join(destination, name);
		// FileSystem.stat follows links; preserve a link rather than copying an external tree.
		const link = yield* fs.readLink(from).pipe(
			Effect.catch((error) => {
				const cause = error.reason.cause;
				return cause instanceof Error && 'code' in cause && cause.code === 'EINVAL'
					? Effect.succeed(null)
					: Effect.fail(error);
			})
		);
		if (link !== null) yield* fs.copy(from, to);
		else if ((yield* fs.stat(from)).type === 'Directory') yield* copyWorkspace(from, to);
		else yield* fs.copy(from, to);
	}
});
const assertArchiveDeclarations = Effect.fn('Publication.archiveDeclarations')(function* (
	archivePath: string,
	directory: string,
	output: string
) {
	const fs = yield* FileSystem.FileSystem;
	const unpacked = path.join(output, `unpacked-${directory}`);
	yield* fs.makeDirectory(unpacked, { recursive: true });
	yield* capture('tar', ['-xzf', archivePath, '-C', unpacked], output);
	const declarationRoot = path.join(unpacked, 'package', 'build');
	if (!(yield* fs.exists(declarationRoot)))
		return yield* new PublicationFailed({
			message: `@norbital-ai/${directory} packs no build/ directory.`
		});
	yield* assertDeclarationEmit({
		declarationRoot,
		packageDirectory: directory,
		label: `${path.basename(archivePath)} (packed archive)`
	});
	yield* fs.remove(unpacked, { recursive: true, force: true });
});
export const assertSpecifiersExported = Effect.fn('Publication.specifiers')(function* (
	root = repositoryRoot
) {
	const fs = yield* FileSystem.FileSystem;
	const manifests = new Map<string, Manifest>();
	const sources: Array<[string, string]> = [];
	for (const directory of publicPackageDirectories) {
		const manifest = yield* readManifest(path.join(root, 'packages', directory, 'package.json'));
		if (manifest.name === undefined)
			return yield* new PublicationFailed({
				message: `Unexpected public package name in packages/${directory}.`
			});
		manifests.set(manifest.name, manifest);
		const source = path.join(root, 'packages', directory, 'src');
		for (const file of yield* fs.readDirectory(source, { recursive: true })) {
			if (/\.(?:[cm]?[jt]s|svelte)$/.test(file))
				sources.push([
					`packages/${directory}/src/${file}`,
					yield* fs.readFileString(path.join(source, file))
				]);
		}
	}
	const offenders = unexportedSpecifiers(sources, manifests);
	if (offenders.length > 0)
		return yield* new PublicationFailed({
			message: `Source names unexported package entries:\n${offenders.join('\n')}`
		});
}, Effect.mapError(PublicationFailed.from));
export const validatePackagePublication = Effect.scoped(
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const license = yield* fs.readFileString(path.join(repositoryRoot, 'LICENSE'));
		yield* assertSpecifiersExported();
		const output = yield* fs.makeTempDirectoryScoped({
			directory: yield* scratchRoot(),
			prefix: 'publication-check-'
		});
		const workspace = path.join(output, 'workspace');
		yield* copyWorkspace(repositoryRoot, workspace);
		// The frozen lockfile pins every resolution; the scratch copy may sit on another filesystem whose
		// pnpm store is empty (a CI runner's tmpdir), so tarballs it lacks are fetched, never re-resolved.
		yield* capture(
			'pnpm',
			['install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts'],
			workspace
		);
		for (const directory of publicPackageDirectories) {
			const packageDirectory = path.join(workspace, 'packages', directory);
			const manifest = yield* readManifest(path.join(packageDirectory, 'package.json'));
			if (manifest.scripts?.build) {
				if (manifest.scripts.prepack !== `pnpm exec turbo run build --filter=${manifest.name}`)
					return yield* new PublicationFailed({
						message: `${manifest.name} must build through turbo during prepack.`
					});
				yield* fs.remove(path.join(packageDirectory, 'build'), { recursive: true, force: true });
			}
			const packOutput = yield* capture(
				'pnpm',
				['pack', '--json', '--pack-destination', output],
				packageDirectory
			);
			const reported = yield* Effect.try({
				try: () => packedArchiveFilename(packOutput, `pnpm pack for packages/${directory}`),
				catch: PublicationFailed.from
			});
			const archive = path.isAbsolute(reported) ? reported : path.resolve(output, reported);
			yield* inspectPackageArchive(archive, { directory, repositoryLicense: license });
			if (manifest.scripts?.build) yield* assertArchiveDeclarations(archive, directory, output);
		}
		yield* Console.log(
			`Validated ${publicPackageDirectories.length} standalone public package archives.`
		);
	})
).pipe(Effect.mapError(PublicationFailed.from));
if (import.meta.main)
	NodeRuntime.runMain(validatePackagePublication.pipe(Effect.provide(ScriptLive)));
