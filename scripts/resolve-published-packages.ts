import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import { Config, Console, Effect, FileSystem, Option, Redacted, Schema } from 'effect';
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';
import {
	assertSha512Integrity,
	inspectPackageArchive,
	packedArchiveFilename,
	sha512Pattern
} from './lib/package-archive.ts';
import {
	platformPackageKey,
	publicPackageDirectories,
	readManifest,
	readPublicPackageEntries
} from './lib/package-release.ts';
import { PublicationFailed } from './lib/error.ts';
import { capture } from './lib/process.ts';
import { scratchRoot } from './lib/scratch.ts';
import { ScriptLive } from './runtime.ts';
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicPackageDirectoryByName = new Map(
	publicPackageDirectories.map((directory) => [`@norbital-ai/${directory}`, directory] as const)
);

/** Only the selected release's version is decoded; unrelated historical versions cannot invalidate it. */
export const Packument = Schema.Struct({ versions: Schema.Record(Schema.String, Schema.Unknown) });
export const PublishedVersion = Schema.Struct({
	dist: Schema.Struct({
		tarball: Schema.NonEmptyString,
		integrity: Schema.String.check(Schema.isPattern(sha512Pattern))
	})
});
export function normalizedRegistry(value: string): URL {
	const registry = new URL(value);
	if (!['http:', 'https:'].includes(registry.protocol))
		throw new PublicationFailed({ message: 'Package registry must use HTTP or HTTPS.' });
	if (registry.username || registry.password)
		throw new PublicationFailed({ message: 'Package registry URL must not contain credentials.' });
	registry.hash = '';
	registry.search = '';
	if (!registry.pathname.endsWith('/')) registry.pathname += '/';
	return registry;
}
type PublishedOptions = {
	readonly registryUrl: string;
	readonly token?: Redacted.Redacted<string> | undefined;
	readonly archiveOutput?: string | undefined;
};
export const resolvePublishedPackages = Effect.fn('Publication.resolvePublished')(
	(options: PublishedOptions) =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const registry = yield* Effect.try({
					try: () => normalizedRegistry(options.registryUrl),
					catch: PublicationFailed.from
				});
				const localEntries = yield* readPublicPackageEntries(repositoryRoot);
				const repositoryLicense = yield* fs.readFileString(path.join(repositoryRoot, 'LICENSE'));
				const temporary = yield* fs.makeTempDirectoryScoped({
					directory: yield* scratchRoot(),
					prefix: 'registry-packages-'
				});
				const entries = yield* Effect.forEach(
					localEntries,
					(local) =>
						Effect.gen(function* () {
							const directory = publicPackageDirectoryByName.get(local.name);
							if (directory === undefined)
								return yield* new PublicationFailed({
									message: `No package directory mapping for ${local.name}.`
								});
							const authenticated = (request: HttpClientRequest.HttpClientRequest) =>
								options.token === undefined
									? request
									: HttpClientRequest.bearerToken(request, options.token);
							const response = yield* HttpClient.execute(
								authenticated(
									HttpClientRequest.get(new URL(encodeURIComponent(local.name), registry).href, {
										accept: 'application/vnd.npm.install-v1+json'
									})
								)
							);
							if (response.status < 200 || response.status >= 300)
								return yield* new PublicationFailed({
									message: `${local.name} packument returned HTTP ${response.status}.`
								});
							const packument = yield* HttpClientResponse.schemaBodyJson(Packument)(response).pipe(
								Effect.mapError(
									() =>
										new PublicationFailed({ message: `${local.name} packument is not valid JSON.` })
								)
							);
							const candidate = packument.versions[local.version];
							if (candidate === undefined)
								return yield* new PublicationFailed({
									message: `${local.name}@${local.version} is not published by ${registry.origin}.`
								});
							const published = yield* Schema.decodeUnknownEffect(PublishedVersion)(candidate).pipe(
								Effect.mapError(
									(cause) =>
										new PublicationFailed({
											message: `${local.name}@${local.version} has invalid dist.tarball or sha512 dist.integrity: ${cause.message}`
										})
								)
							);
							const tarball = yield* Effect.try({
								try: () => new URL(published.dist.tarball, registry),
								catch: PublicationFailed.from
							});
							if (
								!['http:', 'https:'].includes(tarball.protocol) ||
								tarball.username ||
								tarball.password
							)
								return yield* new PublicationFailed({
									message: `${local.name}@${local.version} has an invalid tarball URL.`
								});
							const request = HttpClientRequest.get(tarball.href);
							const archive = yield* HttpClient.execute(
								tarball.origin === registry.origin ? authenticated(request) : request
							);
							if (archive.status < 200 || archive.status >= 300)
								return yield* new PublicationFailed({
									message: `${local.name}@${local.version} tarball returned HTTP ${archive.status}.`
								});
							const bytes = new Uint8Array(yield* archive.arrayBuffer);
							yield* Effect.try({
								try: () =>
									assertSha512Integrity(
										bytes,
										published.dist.integrity,
										`${local.name}@${local.version}`
									),
								catch: PublicationFailed.from
							});
							const archivePath = path.join(temporary, `${directory}.tgz`);
							yield* fs.writeFile(archivePath, bytes);
							const inspected = yield* inspectPackageArchive(archivePath, {
								directory,
								expectedName: local.name,
								expectedVersion: local.version,
								repositoryLicense
							});
							if (inspected.integrity !== published.dist.integrity)
								return yield* new PublicationFailed({
									message: `${local.name}@${local.version} archive inspection changed its integrity.`
								});
							return {
								name: local.name,
								version: local.version,
								tarball: tarball.href,
								integrity: published.dist.integrity
							};
						}),
					{ concurrency: 'unbounded' }
				);
				if (options.archiveOutput !== undefined && options.archiveOutput !== '') {
					yield* fs.makeDirectory(options.archiveOutput, { recursive: true });
					for (const directory of publicPackageDirectories)
						yield* fs.copyFile(
							path.join(temporary, `${directory}.tgz`),
							path.join(options.archiveOutput, `${directory}.tgz`)
						);
				}
				entries.sort((left, right) => left.name.localeCompare(right.name));
				return {
					schemaVersion: 1,
					registry: registry.href.replace(/\/$/, ''),
					packageKey: platformPackageKey(entries),
					entries
				};
			})
		).pipe(Effect.mapError(PublicationFailed.from))
);

const normalizePackedManifest = Effect.fn('Publication.normalizeManifest')(function* (
	packageRoot: string
) {
	const fs = yield* FileSystem.FileSystem;
	const file = path.join(packageRoot, 'package.json');
	const manifest = yield* readManifest(file);
	const sorted = <T>(
		value: Readonly<Record<string, T>> | undefined
	): Record<string, T> | undefined =>
		value === undefined
			? undefined
			: Object.fromEntries(
					Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
				);
	const normalized = {
		...manifest,
		dependencies: sorted(manifest.dependencies),
		devDependencies: sorted(manifest.devDependencies),
		optionalDependencies: sorted(manifest.optionalDependencies),
		peerDependencies: sorted(manifest.peerDependencies),
		peerDependenciesMeta: sorted(manifest.peerDependenciesMeta)
	};
	yield* fs.writeFileString(file, `${JSON.stringify(normalized, null, 2)}\n`);
}, Effect.mapError(PublicationFailed.from));
const resolveReportedArchive = (filename: string, destination: string) =>
	path.isAbsolute(filename) ? filename : path.resolve(destination, filename);
const packWorkspacePackage = Effect.fn('Publication.packWorkspace')(function* (
	directory: string,
	temporary: string
) {
	const fs = yield* FileSystem.FileSystem;
	const initial = path.join(temporary, 'initial');
	const unpacked = path.join(temporary, `unpacked-${directory}`);
	const normalized = path.join(temporary, 'normalized');
	for (const folder of [initial, unpacked, normalized])
		yield* fs.makeDirectory(folder, { recursive: true });
	const initialOutput = yield* capture(
		'pnpm',
		['pack', '--json', '--pack-destination', initial],
		path.join(repositoryRoot, 'packages', directory)
	);
	const initialFilename = yield* Effect.try({
		try: () => packedArchiveFilename(initialOutput, `pnpm pack for packages/${directory}`),
		catch: PublicationFailed.from
	});
	yield* capture(
		'tar',
		['-xzf', resolveReportedArchive(initialFilename, initial), '-C', unpacked],
		temporary
	);
	const packageRoot = path.join(unpacked, 'package');
	yield* normalizePackedManifest(packageRoot);
	const normalizedOutput = yield* capture(
		'npm',
		['pack', '--json', '--ignore-scripts', '--pack-destination', normalized],
		packageRoot
	);
	const normalizedFilename = yield* Effect.try({
		try: () => packedArchiveFilename(normalizedOutput, `npm pack for packages/${directory}`),
		catch: PublicationFailed.from
	});
	return resolveReportedArchive(normalizedFilename, normalized);
}, Effect.mapError(PublicationFailed.from));
export const resolveWorkspacePackages = Effect.fn('Publication.resolveWorkspace')(
	(options: { readonly archiveBaseUrl: string; readonly archiveOutput?: string | undefined }) =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const archiveBase = yield* Effect.try({
					try: () => normalizedRegistry(options.archiveBaseUrl),
					catch: PublicationFailed.from
				});
				const localEntries = yield* readPublicPackageEntries(repositoryRoot);
				const repositoryLicense = yield* fs.readFileString(path.join(repositoryRoot, 'LICENSE'));
				const temporary = yield* fs.makeTempDirectoryScoped({
					directory: yield* scratchRoot(),
					prefix: 'workspace-packages-'
				});
				const entries: Array<{
					name: string;
					version: string;
					tarball: string;
					integrity: string;
				}> = [];
				for (const local of localEntries) {
					const directory = publicPackageDirectoryByName.get(local.name);
					if (directory === undefined)
						return yield* new PublicationFailed({
							message: `No package directory mapping for ${local.name}.`
						});
					const archivePath = yield* packWorkspacePackage(directory, temporary);
					const inspected = yield* inspectPackageArchive(archivePath, {
						directory,
						expectedName: local.name,
						expectedVersion: local.version,
						repositoryLicense
					});
					entries.push({
						name: local.name,
						version: local.version,
						tarball: new URL(`${directory}.tgz`, archiveBase).href,
						integrity: inspected.integrity
					});
					if (options.archiveOutput !== undefined && options.archiveOutput !== '') {
						yield* fs.makeDirectory(options.archiveOutput, { recursive: true });
						yield* fs.copyFile(archivePath, path.join(options.archiveOutput, `${directory}.tgz`));
					}
				}
				entries.sort((left, right) => left.name.localeCompare(right.name));
				return {
					schemaVersion: 1,
					registry: archiveBase.href.replace(/\/$/, ''),
					packageKey: platformPackageKey(entries),
					entries
				};
			})
		).pipe(Effect.mapError(PublicationFailed.from))
);

export const main = Effect.fn('Publication.resolve.main')(function* (
	argv: ReadonlyArray<string> = process.argv.slice(2)
) {
	const fs = yield* FileSystem.FileSystem;
	const options = yield* Effect.try({
		try: () =>
			parseArgs({
				args: [...argv],
				options: {
					source: { type: 'string' },
					registry: { type: 'string' },
					'archive-base-url': { type: 'string' },
					output: { type: 'string' },
					'archive-output': { type: 'string' },
					'github-output': { type: 'string' }
				},
				strict: true,
				allowPositionals: false
			}).values,
		catch: PublicationFailed.from
	});
	const optional = (name: string) =>
		Config.option(Config.String(name)).pipe(Effect.map(Option.getOrUndefined));
	const source = options.source ?? (yield* optional('NORBITAL_PACKAGE_SOURCE')) ?? 'registry';
	if (source !== 'registry' && source !== 'workspace')
		return yield* new PublicationFailed({
			message: 'Package source must be registry or workspace.'
		});
	const registryUrl = options.registry ?? (yield* optional('PACKAGE_REGISTRY_URL'));
	const archiveBaseUrl =
		options['archive-base-url'] ?? (yield* optional('PLATFORM_ARCHIVE_BASE_URL')) ?? registryUrl;
	const sourceInput = source === 'workspace' ? archiveBaseUrl : registryUrl;
	if (sourceInput === undefined || sourceInput === '')
		return yield* new PublicationFailed({
			message:
				source === 'workspace'
					? 'Workspace package source requires --archive-base-url or PLATFORM_ARCHIVE_BASE_URL.'
					: 'Registry package source requires --registry or PACKAGE_REGISTRY_URL.'
		});
	const output = options.output ?? (yield* optional('PACKAGE_RELEASE_OUTPUT'));
	if (output === undefined || output === '')
		return yield* new PublicationFailed({
			message: 'Pass --output or set PACKAGE_RELEASE_OUTPUT.'
		});
	const archiveOutput = options['archive-output'] ?? (yield* optional('PACKAGE_ARCHIVE_OUTPUT'));
	const resolvedArchiveOutput = archiveOutput
		? path.resolve(repositoryRoot, archiveOutput)
		: undefined;
	let release: Effect.Success<ReturnType<typeof resolveWorkspacePackages>>;
	if (source === 'workspace') {
		release = yield* resolveWorkspacePackages({
			archiveBaseUrl: sourceInput,
			archiveOutput: resolvedArchiveOutput
		});
	} else {
		const registry = yield* Effect.try({
			try: () => normalizedRegistry(sourceInput),
			catch: PublicationFailed.from
		});
		const configured = yield* Config.option(Config.Redacted('NPM_REGISTRY_TOKEN'));
		const token =
			Option.getOrUndefined(configured) ??
			Option.getOrUndefined(
				yield* Config.option(
					Config.Redacted(
						registry.hostname === 'npm.pkg.github.com' ? 'GITHUB_PACKAGE_TOKEN' : 'NODE_AUTH_TOKEN'
					)
				)
			);
		release = yield* resolvePublishedPackages({
			registryUrl: sourceInput,
			archiveOutput: resolvedArchiveOutput,
			token
		});
	}
	const outputPath = path.resolve(repositoryRoot, output);
	yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true });
	yield* fs.writeFileString(outputPath, `${JSON.stringify(release, null, 2)}\n`);
	yield* Console.log(
		`Verified ${release.entries.length} ${source} package archives for ${release.packageKey}.`
	);
	if (options['github-output'])
		yield* fs.writeFileString(options['github-output'], `package_key=${release.packageKey}\n`, {
			flag: 'a'
		});
}, Effect.mapError(PublicationFailed.from));

if (import.meta.main) NodeRuntime.runMain(main().pipe(Effect.provide(ScriptLive)));
