import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HostFileStorageBinding } from '@norbital-ai/platform-utils/runtime/binding';

export type LocalFileStorageOptions = {
	/** Directory that holds the objects. Relative paths resolve against the workspace root. */
	readonly directory: string;
};

/**
 * Object keys come from the runtime (`document-assets/<uuid><ext>`), not from a user, but they are
 * still concatenated into a filesystem path — so they are validated rather than trusted. A key
 * that escapes the storage directory is a bug in the runtime, and it should fail loudly here
 * rather than write outside it.
 */
function objectPath(root: string, key: string): string {
	const candidate = path.normalize(path.join(root, key));
	if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
		throw new Error(`Workspace file storage key escapes the storage root: ${key}`);
	}
	return candidate;
}

/**
 * File storage backed by the local filesystem.
 *
 * This is the standalone counterpart to Core's object store. It is deliberately the simplest thing
 * that satisfies the contract: one file per key, no metadata sidecar, no lifecycle. Content type
 * is not persisted because the runtime already stores it on the `document_asset` record and never
 * asks storage for it.
 */
export function localFileStorage(options: LocalFileStorageOptions): HostFileStorageBinding {
	const root = path.resolve(options.directory);

	return {
		async put(key, body) {
			const target = objectPath(root, key);
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, body);
		},
		async get(key) {
			try {
				return new Uint8Array(await readFile(objectPath(root, key)));
			} catch (cause) {
				if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return null;
				throw cause;
			}
		},
		async delete(key) {
			await rm(objectPath(root, key), { force: true });
		}
	};
}
