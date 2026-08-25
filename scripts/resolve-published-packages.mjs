import {
	appendFileSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Cause, Effect } from 'effect';
import {
	assertSha512Integrity,
	inspectPackageArchive,
	packedArchiveFilename
} from './lib/package-archive.mjs';
import {
	platformPackageKey,
	publicPackageDirectories,
	readManifest,
	readPublicPackageEntries
} from './lib/package-release.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha512Pattern = /^sha512-[A-Za-z0-9+/]{86}==$/;
const publicPackageDirectoryByName = new Map(
	publicPackageDirectories.map((candidate) => [`@norbital-ai/${candidate}`, candidate])
);

function fail(message) {
	throw new Error(message);
}

function normalizedRegistry(value) {
	const registry = new URL(value);
	if (!['http:', 'https:'].includes(registry.protocol)) {
		fail('Package registry must use HTTP or HTTPS.');
	}
	if (registry.username || registry.password)
		fail('Package registry URL must not contain credentials.');
	registry.hash = '';
	registry.search = '';
	if (!registry.pathname.endsWith('/')) registry.pathname += '/';
	return registry;
}

function authHeaders(token) {
	return token ? { authorization: `Bearer ${token}` } : {};
}

function responseBytes(response, label) {
	if (!response.ok) return Effect.fail(new Error(`${label} returned HTTP ${response.status}.`));
	return Effect.tryPromise({
		try: () => response.arrayBuffer(),
		catch: (cause) => new Error(`${label} body could not be read.`, { cause })
	}).pipe(Effect.map((bytes) => Buffer.from(bytes)));
}

function resolvePublishedPackagesEffect({
	registryUrl,
	token,
	archiveOutput,
	fetchImplementation = fetch
}) {
	return Effect.gen(function* () {
		const registry = yield* Effect.try({
			try: () => normalizedRegistry(registryUrl),
			catch: (cause) => cause
		});
		const localEntries = readPublicPackageEntries(repositoryRoot);
		const repositoryLicense = readFileSync(path.join(repositoryRoot, 'LICENSE'), 'utf8');
		return yield* Effect.acquireUseRelease(
			Effect.sync(() => mkdtempSync(path.join(tmpdir(), 'norbital-registry-packages-'))),
			(temporaryDirectory) =>
				Effect.gen(function* () {
					// The packages are independent of one another, so the registry work is batched; each entry
					// keeps its own archive path and the results are collected in declaration order.
					const entries = yield* Effect.forEach(
						localEntries,
						(local) =>
							Effect.gen(function* () {
								const directory = publicPackageDirectoryByName.get(local.name);
								if (!directory) {
									return yield* Effect.fail(
										new Error(`No package directory mapping for ${local.name}.`)
									);
								}
								const packumentUrl = new URL(encodeURIComponent(local.name), registry);
								const packumentResponse = yield* Effect.tryPromise({
									try: () =>
										fetchImplementation(packumentUrl, {
											headers: {
												accept: 'application/vnd.npm.install-v1+json',
												...authHeaders(token)
											}
										}),
									catch: (cause) => new Error(`${local.name} packument request failed.`, { cause })
								});
								if (!packumentResponse.ok) {
									return yield* Effect.fail(
										new Error(`${local.name} packument returned HTTP ${packumentResponse.status}.`)
									);
								}
								const packument = yield* Effect.tryPromise({
									try: () => packumentResponse.json(),
									catch: (cause) =>
										new Error(`${local.name} packument is not valid JSON.`, { cause })
								});
								const published = packument.versions?.[local.version];
								if (!published) {
									return yield* Effect.fail(
										new Error(
											`${local.name}@${local.version} is not published by ${registry.origin}.`
										)
									);
								}
								if (typeof published.dist?.tarball !== 'string' || published.dist.tarball === '') {
									return yield* Effect.fail(
										new Error(`${local.name}@${local.version} has no dist.tarball.`)
									);
								}
								const tarball = new URL(published.dist.tarball, registry);
								if (
									!['http:', 'https:'].includes(tarball.protocol) ||
									tarball.username ||
									tarball.password
								) {
									return yield* Effect.fail(
										new Error(`${local.name}@${local.version} has an invalid tarball URL.`)
									);
								}
								const integrity = published.dist?.integrity;
								if (!sha512Pattern.test(integrity ?? '')) {
									return yield* Effect.fail(
										new Error(`${local.name}@${local.version} has no sha512 dist.integrity.`)
									);
								}
								const tarballResponse = yield* Effect.tryPromise({
									try: () =>
										fetchImplementation(tarball, {
											headers: tarball.origin === registry.origin ? authHeaders(token) : {}
										}),
									catch: (cause) =>
										new Error(`${local.name}@${local.version} tarball request failed.`, {
											cause
										})
								});
								const bytes = yield* responseBytes(
									tarballResponse,
									`${local.name}@${local.version} tarball`
								);
								return yield* Effect.try({
									try: () => {
										assertSha512Integrity(bytes, integrity, `${local.name}@${local.version}`);
										const archivePath = path.join(temporaryDirectory, `${directory}.tgz`);
										writeFileSync(archivePath, bytes);
										const inspected = inspectPackageArchive(archivePath, {
											directory,
											expectedName: local.name,
											expectedVersion: local.version,
											repositoryLicense
										});
										if (inspected.integrity !== integrity) {
											fail(
												`${local.name}@${local.version} archive inspection changed its integrity.`
											);
										}
										return {
											name: local.name,
											version: local.version,
											tarball: tarball.href,
											integrity
										};
									},
									catch: (cause) => cause
								});
							}),
						{ concurrency: 'unbounded' }
					);
					if (archiveOutput) {
						yield* Effect.sync(() => {
							mkdirSync(archiveOutput, { recursive: true });
							for (const directory of publicPackageDirectories) {
								copyFileSync(
									path.join(temporaryDirectory, `${directory}.tgz`),
									path.join(archiveOutput, `${directory}.tgz`)
								);
							}
						});
					}
					entries.sort((left, right) => left.name.localeCompare(right.name));
					return {
						schemaVersion: 1,
						registry: registry.href.replace(/\/$/, ''),
						packageKey: platformPackageKey(entries),
						entries
					};
				}),
			(temporaryDirectory) =>
				Effect.sync(() => rmSync(temporaryDirectory, { recursive: true, force: true }))
		);
	});
}

/** Promise boundary retained for callers that import this release helper directly. */
export function resolvePublishedPackages(options) {
	return Effect.runPromise(resolvePublishedPackagesEffect(options));
}

const dependencyMapFields = [
	'dependencies',
	'devDependencies',
	'optionalDependencies',
	'peerDependencies',
	'peerDependenciesMeta'
];

function normalizePackedManifest(packageRoot) {
	const manifestPath = path.join(packageRoot, 'package.json');
	const manifest = readManifest(manifestPath);
	for (const field of dependencyMapFields) {
		if (manifest[field] == null) continue;
		manifest[field] = Object.fromEntries(
			Object.entries(manifest[field]).sort(([left], [right]) => left.localeCompare(right))
		);
	}
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function resolveReportedArchive(filename, destination) {
	return path.isAbsolute(filename) ? filename : path.resolve(destination, filename);
}

function packWorkspacePackage({ directory, temporaryDirectory }) {
	const initialArchiveDirectory = path.join(temporaryDirectory, 'initial');
	const unpackedDirectory = path.join(temporaryDirectory, `unpacked-${directory}`);
	const normalizedArchiveDirectory = path.join(temporaryDirectory, 'normalized');
	mkdirSync(initialArchiveDirectory, { recursive: true });
	mkdirSync(unpackedDirectory, { recursive: true });
	mkdirSync(normalizedArchiveDirectory, { recursive: true });
	const initialOutput = execFileSync(
		'pnpm',
		['pack', '--json', '--pack-destination', initialArchiveDirectory],
		{
			cwd: path.join(repositoryRoot, 'packages', directory),
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'inherit']
		}
	);
	const initialFilename = packedArchiveFilename(
		initialOutput,
		`pnpm pack for packages/${directory}`
	);
	execFileSync(
		'tar',
		[
			'-xzf',
			resolveReportedArchive(initialFilename, initialArchiveDirectory),
			'-C',
			unpackedDirectory
		],
		{ stdio: 'inherit' }
	);
	const packageRoot = path.join(unpackedDirectory, 'package');
	normalizePackedManifest(packageRoot);
	const normalizedOutput = execFileSync(
		'npm',
		['pack', '--json', '--ignore-scripts', '--pack-destination', normalizedArchiveDirectory],
		{
			cwd: packageRoot,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'inherit']
		}
	);
	const normalizedFilename = packedArchiveFilename(
		normalizedOutput,
		`npm pack for packages/${directory}`
	);
	return resolveReportedArchive(normalizedFilename, normalizedArchiveDirectory);
}

export function resolveWorkspacePackages({ archiveBaseUrl, archiveOutput }) {
	const archiveBase = normalizedRegistry(archiveBaseUrl);
	const localEntries = readPublicPackageEntries(repositoryRoot);
	const repositoryLicense = readFileSync(path.join(repositoryRoot, 'LICENSE'), 'utf8');
	return Effect.runSync(
		Effect.acquireUseRelease(
			Effect.sync(() => mkdtempSync(path.join(tmpdir(), 'norbital-workspace-packages-'))),
			(temporaryDirectory) =>
				Effect.sync(() => {
					const entries = [];
					for (const local of localEntries) {
						const directory = publicPackageDirectoryByName.get(local.name);
						if (!directory) fail(`No package directory mapping for ${local.name}.`);
						const archivePath = packWorkspacePackage({ directory, temporaryDirectory });
						const inspected = inspectPackageArchive(archivePath, {
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
						if (archiveOutput) {
							mkdirSync(archiveOutput, { recursive: true });
							copyFileSync(archivePath, path.join(archiveOutput, `${directory}.tgz`));
						}
					}
					entries.sort((left, right) => left.name.localeCompare(right.name));
					return {
						schemaVersion: 1,
						registry: archiveBase.href.replace(/\/$/, ''),
						packageKey: platformPackageKey(entries),
						entries
					};
				}),
			(temporaryDirectory) =>
				Effect.sync(() => rmSync(temporaryDirectory, { recursive: true, force: true }))
		)
	);
}

function main() {
	return Effect.gen(function* () {
		const options = yield* Effect.try({
			try: () =>
				parseArgs({
					args: process.argv.slice(2),
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
			catch: (cause) => cause
		});
		const source = options.source ?? process.env.NORBITAL_PACKAGE_SOURCE ?? 'registry';
		if (!['registry', 'workspace'].includes(source)) {
			return yield* Effect.fail(new Error('Package source must be registry or workspace.'));
		}
		const registryUrl = options.registry ?? process.env.PACKAGE_REGISTRY_URL;
		const archiveBaseUrl =
			options['archive-base-url'] ?? process.env.PLATFORM_ARCHIVE_BASE_URL ?? registryUrl;
		if (source === 'registry' && !registryUrl) {
			return yield* Effect.fail(
				new Error('Registry package source requires --registry or PACKAGE_REGISTRY_URL.')
			);
		}
		if (source === 'workspace' && !archiveBaseUrl) {
			return yield* Effect.fail(
				new Error(
					'Workspace package source requires --archive-base-url or PLATFORM_ARCHIVE_BASE_URL.'
				)
			);
		}
		const output = options.output ?? process.env.PACKAGE_RELEASE_OUTPUT;
		if (!output)
			return yield* Effect.fail(new Error('Pass --output or set PACKAGE_RELEASE_OUTPUT.'));
		const archiveOutput = options['archive-output'] ?? process.env.PACKAGE_ARCHIVE_OUTPUT;
		const resolvedArchiveOutput = archiveOutput
			? path.resolve(repositoryRoot, archiveOutput)
			: undefined;
		const release = yield* source === 'workspace'
			? Effect.try({
					try: () =>
						resolveWorkspacePackages({
							archiveBaseUrl,
							archiveOutput: resolvedArchiveOutput
						}),
					catch: (cause) => cause
				})
			: Effect.gen(function* () {
					const registry = yield* Effect.try({
						try: () => normalizedRegistry(registryUrl),
						catch: (cause) => cause
					});
					return yield* resolvePublishedPackagesEffect({
						registryUrl,
						archiveOutput: resolvedArchiveOutput,
						token:
							process.env.NPM_REGISTRY_TOKEN ||
							(registry.hostname === 'npm.pkg.github.com'
								? process.env.GITHUB_PACKAGE_TOKEN
								: process.env.NODE_AUTH_TOKEN)
					});
				});
		yield* Effect.sync(() => {
			const outputPath = path.resolve(repositoryRoot, output);
			mkdirSync(path.dirname(outputPath), { recursive: true });
			writeFileSync(outputPath, `${JSON.stringify(release, null, 2)}\n`);
			console.log(
				`Verified ${release.entries.length} ${source} package archives for ${release.packageKey}.`
			);

			const githubOutput = options['github-output'];
			if (githubOutput) {
				appendFileSync(githubOutput, `package_key=${release.packageKey}\n`);
			}
		});
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	Effect.runFork(
		main().pipe(
			Effect.catchCause((cause) =>
				Effect.sync(() => {
					const error = Cause.squash(cause);
					console.error(error instanceof Error ? error.message : error);
					process.exitCode = 1;
				})
			)
		)
	);
}
