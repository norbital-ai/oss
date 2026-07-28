import { createHash, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const localProtocol = /^(?:workspace|catalog|file|link|portal):/;
const sha512Pattern = /^sha512-[A-Za-z0-9+/]{86}==$/;

function fail(message) {
	throw new Error(message);
}

export function sha512Integrity(bytes) {
	return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

export function assertSha512Integrity(bytes, integrity, label = 'package archive') {
	if (!sha512Pattern.test(integrity)) fail(`${label} has invalid sha512 integrity.`);
	const actual = Buffer.from(sha512Integrity(bytes));
	const expected = Buffer.from(integrity);
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
		fail(`${label} does not match its declared sha512 integrity.`);
	}
}

export function validatePublishedManifest(manifest, directory, expected = {}) {
	if (manifest.private) fail(`${manifest.name} is marked private.`);
	if (manifest.name !== (expected.name ?? `@norbital-ai/${directory}`)) {
		fail(`${directory} has unexpected package name ${manifest.name}.`);
	}
	if (!manifest.version) fail(`${manifest.name} has no version.`);
	if (expected.version && manifest.version !== expected.version) {
		fail(`${manifest.name} archive is ${manifest.version}; expected ${expected.version}.`);
	}
	if (manifest.license !== 'SEE LICENSE IN LICENSE') {
		fail(`${manifest.name} must reference the repository license.`);
	}
	if (manifest.repository?.directory !== `packages/${directory}`) {
		fail(`${manifest.name} has an invalid repository directory.`);
	}
	if (manifest.publishConfig?.access !== 'public' || manifest.publishConfig?.provenance !== true) {
		fail(`${manifest.name} must publish publicly with provenance.`);
	}
	for (const section of [
		'dependencies',
		'devDependencies',
		'optionalDependencies',
		'peerDependencies'
	]) {
		for (const [name, version] of Object.entries(manifest[section] ?? {})) {
			if (localProtocol.test(version)) {
				fail(`${manifest.name} publishes ${section}.${name} with local protocol ${version}.`);
			}
		}
	}
}

export function inspectPackageArchive(
	archivePath,
	{ directory, expectedName, expectedVersion, repositoryLicense }
) {
	const manifestText = execFileSync('tar', ['-xOf', archivePath, 'package/package.json'], {
		encoding: 'utf8'
	});
	const packagedLicense = execFileSync('tar', ['-xOf', archivePath, 'package/LICENSE'], {
		encoding: 'utf8'
	});
	if (packagedLicense !== repositoryLicense) {
		fail(`${directory} does not publish the repository license.`);
	}
	const manifest = JSON.parse(manifestText);
	validatePublishedManifest(manifest, directory, {
		name: expectedName,
		version: expectedVersion
	});
	return {
		manifest,
		integrity: sha512Integrity(readFileSync(archivePath))
	};
}
