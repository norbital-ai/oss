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
import {
	assertSha512Integrity,
	inspectPackageArchive,
	packedArchiveFilename
} from './lib/package-archive.mjs';
import {
	platformPackageKey,
	publicPackageDirectories,
	readPublicPackageEntries
} from './lib/package-release.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha512Pattern = /^sha512-[A-Za-z0-9+/]{86}==$/;

function fail(message) {
	throw new Error(message);
}

function argumentsFrom(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (!argument.startsWith('--')) fail(`Unknown argument: ${argument}`);
		const key = argument.slice(2);
		const value = argv[++index];
		if (!value || value.startsWith('--')) fail(`${argument} requires a value.`);
		options[key] = value;
	}
	return options;
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

async function responseBytes(response, label) {
	if (!response.ok) fail(`${label} returned HTTP ${response.status}.`);
	return Buffer.from(await response.arrayBuffer());
}

export async function resolvePublishedPackages({
	registryUrl,
	token,
	archiveOutput,
	fetchImplementation = fetch
}) {
	const registry = normalizedRegistry(registryUrl);
	const localEntries = readPublicPackageEntries(repositoryRoot);
	const repositoryLicense = readFileSync(path.join(repositoryRoot, 'LICENSE'), 'utf8');
	const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'norbital-registry-packages-'));
	const entries = [];

	try {
		for (const local of localEntries) {
			const directory = publicPackageDirectories.find(
				(candidate) => local.name === `@norbital-ai/${candidate}`
			);
			if (!directory) fail(`No package directory mapping for ${local.name}.`);
			const packumentUrl = new URL(encodeURIComponent(local.name), registry);
			const packumentResponse = await fetchImplementation(packumentUrl, {
				headers: {
					accept: 'application/vnd.npm.install-v1+json',
					...authHeaders(token)
				}
			});
			if (!packumentResponse.ok) {
				fail(`${local.name} packument returned HTTP ${packumentResponse.status}.`);
			}
			const packument = await packumentResponse.json();
			const published = packument.versions?.[local.version];
			if (!published) {
				fail(`${local.name}@${local.version} is not published by ${registry.origin}.`);
			}
			if (typeof published.dist?.tarball !== 'string' || published.dist.tarball === '') {
				fail(`${local.name}@${local.version} has no dist.tarball.`);
			}
			const tarball = new URL(published.dist.tarball, registry);
			if (!['http:', 'https:'].includes(tarball.protocol) || tarball.username || tarball.password) {
				fail(`${local.name}@${local.version} has an invalid tarball URL.`);
			}
			const integrity = published.dist?.integrity;
			if (!sha512Pattern.test(integrity ?? '')) {
				fail(`${local.name}@${local.version} has no sha512 dist.integrity.`);
			}
			const tarballResponse = await fetchImplementation(tarball, {
				headers: tarball.origin === registry.origin ? authHeaders(token) : {}
			});
			const bytes = await responseBytes(tarballResponse, `${local.name}@${local.version} tarball`);
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
				fail(`${local.name}@${local.version} archive inspection changed its integrity.`);
			}
			entries.push({
				name: local.name,
				version: local.version,
				tarball: tarball.href,
				integrity
			});
		}
		if (archiveOutput) {
			mkdirSync(archiveOutput, { recursive: true });
			for (const directory of publicPackageDirectories) {
				copyFileSync(
					path.join(temporaryDirectory, `${directory}.tgz`),
					path.join(archiveOutput, `${directory}.tgz`)
				);
			}
		}
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}

	entries.sort((left, right) => left.name.localeCompare(right.name));
	return {
		schemaVersion: 1,
		registry: registry.href.replace(/\/$/, ''),
		packageKey: platformPackageKey(entries),
		entries
	};
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
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
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
	const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'norbital-workspace-packages-'));
	const entries = [];

	try {
		for (const local of localEntries) {
			const directory = publicPackageDirectories.find(
				(candidate) => local.name === `@norbital-ai/${candidate}`
			);
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
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}

	entries.sort((left, right) => left.name.localeCompare(right.name));
	return {
		schemaVersion: 1,
		registry: archiveBase.href.replace(/\/$/, ''),
		packageKey: platformPackageKey(entries),
		entries
	};
}

async function main() {
	const options = argumentsFrom(process.argv.slice(2));
	const source = options.source ?? process.env.PLATFORM_PACKAGE_SOURCE ?? 'registry';
	if (!['registry', 'workspace'].includes(source)) {
		fail('Package source must be registry or workspace.');
	}
	const registryUrl = options.registry ?? process.env.PACKAGE_REGISTRY_URL;
	const archiveBaseUrl =
		options['archive-base-url'] ?? process.env.PLATFORM_ARCHIVE_BASE_URL ?? registryUrl;
	if (source === 'registry' && !registryUrl) {
		fail('Registry package source requires --registry or PACKAGE_REGISTRY_URL.');
	}
	if (source === 'workspace' && !archiveBaseUrl) {
		fail('Workspace package source requires --archive-base-url or PLATFORM_ARCHIVE_BASE_URL.');
	}
	const output = options.output ?? process.env.PACKAGE_RELEASE_OUTPUT;
	if (!output) fail('Pass --output or set PACKAGE_RELEASE_OUTPUT.');
	const archiveOutput = options['archive-output'] ?? process.env.PACKAGE_ARCHIVE_OUTPUT;
	const resolvedArchiveOutput = archiveOutput
		? path.resolve(repositoryRoot, archiveOutput)
		: undefined;
	const release =
		source === 'workspace'
			? resolveWorkspacePackages({
					archiveBaseUrl,
					archiveOutput: resolvedArchiveOutput
				})
			: await resolvePublishedPackages({
					registryUrl,
					archiveOutput: resolvedArchiveOutput,
					token:
						process.env.NPM_REGISTRY_TOKEN ||
						(normalizedRegistry(registryUrl).hostname === 'npm.pkg.github.com'
							? process.env.GITHUB_PACKAGE_TOKEN
							: process.env.NODE_AUTH_TOKEN)
				});
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
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
