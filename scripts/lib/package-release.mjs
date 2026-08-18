import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const publicPackageDirectories = ['bolt', 'bolt-protocol', 'bolt-server', 'config', 'std', 'ui'];

export function readPublicPackageEntries(repositoryRoot) {
	return publicPackageDirectories
		.map((directory) => {
			const manifest = JSON.parse(
				readFileSync(path.join(repositoryRoot, 'packages', directory, 'package.json'), 'utf8')
			);
			if (manifest.private) throw new Error(`${manifest.name} is private.`);
			if (!manifest.name?.startsWith('@norbital-ai/')) {
				throw new Error(`Unexpected public package name in packages/${directory}.`);
			}
			if (typeof manifest.version !== 'string' || manifest.version === '') {
				throw new Error(`${manifest.name} has no version.`);
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
