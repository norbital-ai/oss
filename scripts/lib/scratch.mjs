import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checkoutRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const isRealmRoot = (directory) =>
	existsSync(path.join(directory, 'AGENTS.md')) &&
	existsSync(path.join(directory, 'env-cli')) &&
	existsSync(path.join(directory, 'norbital')) &&
	existsSync(path.join(directory, 'templates'));

export const realmRootFrom = (start = checkoutRoot) => {
	let directory = path.resolve(start);
	while (true) {
		if (isRealmRoot(directory)) return directory;
		const parent = path.dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
};

export const scratchRoot = (start = checkoutRoot) => {
	const realm = realmRootFrom(start);
	const root =
		realm === undefined ? path.join(tmpdir(), 'norbital-scratch') : path.join(realm, '.tmp');
	mkdirSync(root, { recursive: true });
	return root;
};

export const scratchPath = (...segments) => {
	const destination = path.join(scratchRoot(), ...segments);
	mkdirSync(path.dirname(destination), { recursive: true });
	return destination;
};
