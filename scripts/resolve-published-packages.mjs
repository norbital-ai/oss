import {
	appendFileSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { assertSha512Integrity, inspectPackageArchive } from './lib/package-archive.mjs';
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

async function main() {
	const options = argumentsFrom(process.argv.slice(2));
	const registryUrl = options.registry ?? process.env.PACKAGE_REGISTRY_URL;
	if (!registryUrl) fail('Pass --registry or set PACKAGE_REGISTRY_URL.');
	const registry = normalizedRegistry(registryUrl);
	const output = options.output ?? process.env.PACKAGE_RELEASE_OUTPUT;
	if (!output) fail('Pass --output or set PACKAGE_RELEASE_OUTPUT.');
	const archiveOutput = options['archive-output'] ?? process.env.PACKAGE_ARCHIVE_OUTPUT;
	const release = await resolvePublishedPackages({
		registryUrl: registry.href,
		archiveOutput: archiveOutput ? path.resolve(repositoryRoot, archiveOutput) : undefined,
		token:
			process.env.NPM_REGISTRY_TOKEN ??
			(registry.hostname === 'npm.pkg.github.com'
				? process.env.GITHUB_PACKAGE_TOKEN
				: process.env.NODE_AUTH_TOKEN)
	});
	const outputPath = path.resolve(repositoryRoot, output);
	mkdirSync(path.dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, `${JSON.stringify(release, null, 2)}\n`);
	console.log(
		`Verified ${release.entries.length} published package archives for ${release.packageKey}.`
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
