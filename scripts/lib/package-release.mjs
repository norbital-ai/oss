import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const publicPackageDirectories = ['config', 'platform-utils', 'pod', 'std', 'ui'];

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
	return createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16);
}
