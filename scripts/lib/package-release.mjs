import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Result, Schema } from 'effect';

const isString = Schema.is(Schema.String);

const jsonObject = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.JsonObject));

/**
 * Shared read-and-guard for package manifests, so every release script parses them one way instead
 * of shipping four copies that could drift on the failure shape.
 */
export function readManifest(filePath) {
	const parsed = jsonObject(readFileSync(filePath, 'utf8'));
	if (Result.isFailure(parsed)) {
		throw new Error(`${filePath} is not a JSON object.`);
	}
	return parsed.success;
}

export const publicPackageDirectories = [
	'bolt',
	'bolt-protocol',
	'bolt-server',
	'config',
	'doctor',
	'std',
	'test-utilities',
	'ui'
];

export function readPublicPackageEntries(repositoryRoot) {
	const releaseVersion = readManifest(path.join(repositoryRoot, 'package.json')).version;
	if (!isString(releaseVersion) || releaseVersion === '') {
		throw new Error('The workspace package.json has no release version.');
	}
	return publicPackageDirectories
		.map((directory) => {
			const manifest = readManifest(
				path.join(repositoryRoot, 'packages', directory, 'package.json')
			);
			if (manifest.private) throw new Error(`${manifest.name} is private.`);
			if (!manifest.name?.startsWith('@norbital-ai/')) {
				throw new Error(`Unexpected public package name in packages/${directory}.`);
			}
			if (!isString(manifest.version) || manifest.version === '') {
				throw new Error(`${manifest.name} has no version.`);
			}
			if (manifest.version !== releaseVersion) {
				throw new Error(
					`${manifest.name}@${manifest.version} does not match the workspace release ${releaseVersion}.`
				);
			}
			// A literal first-party version in a published manifest (a peer range cannot say
			// `workspace:*`) is part of the set too: one left behind makes every consumer install
			// the previous release beside this one.
			for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
				for (const [name, range] of Object.entries(manifest[section] ?? {})) {
					if (!name.startsWith('@norbital-ai/') || range.startsWith('workspace:')) continue;
					if (range !== releaseVersion) {
						throw new Error(
							`${manifest.name} ${section}.${name} is ${range}; the release is ${releaseVersion}.`
						);
					}
				}
			}
			return { name: manifest.name, version: manifest.version };
		})
		.sort((left, right) => left.name.localeCompare(right.name));
}

export function platformPackageKey(entries) {
	const contentIdentity = entries
		.map(({ name, version, integrity }) => {
			if (!isString(integrity) || !integrity.startsWith('sha512-')) {
				throw new Error(`${name}@${version} has no sha512 integrity.`);
			}
			return { name, version, integrity };
		})
		.sort((left, right) => left.name.localeCompare(right.name));
	return createHash('sha256').update(JSON.stringify(contentIdentity)).digest('hex').slice(0, 16);
}
