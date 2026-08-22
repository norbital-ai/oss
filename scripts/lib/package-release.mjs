import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { safeParse } from '@norbital-ai/std/json';

/**
 * Shared read-and-guard for package manifests, so every release script parses them one way instead
 * of shipping four copies that could drift on the failure shape.
 */
export function readManifest(filePath) {
	const parsed = safeParse(readFileSync(filePath, 'utf8'));
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(`${filePath} is not a JSON object.`);
	}
	return parsed;
}

export const publicPackageDirectories = [
	'bolt',
	'bolt-protocol',
	'bolt-server',
	'config',
	'std',
	'ui'
];

export function readPublicPackageEntries(repositoryRoot) {
	const releaseVersion = readManifest(path.join(repositoryRoot, 'package.json')).version;
	if (typeof releaseVersion !== 'string' || releaseVersion === '') {
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
			if (typeof manifest.version !== 'string' || manifest.version === '') {
				throw new Error(`${manifest.name} has no version.`);
			}
			if (manifest.version !== releaseVersion) {
				throw new Error(
					`${manifest.name}@${manifest.version} does not match the workspace release ${releaseVersion}.`
				);
			}
			return { name: manifest.name, version: manifest.version };
		})
		.sort((left, right) => left.name.localeCompare(right.name));
}

export function platformPackageKey(entries) {
	const contentIdentity = entries
		.map(({ name, version, integrity }) => {
			if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
				throw new Error(`${name}@${version} has no sha512 integrity.`);
			}
			return { name, version, integrity };
		})
		.sort((left, right) => left.name.localeCompare(right.name));
	return createHash('sha256').update(JSON.stringify(contentIdentity)).digest('hex').slice(0, 16);
}
