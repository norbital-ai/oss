/// <reference types="node" />
// The `DocsPort` over a release's `build/docs/` (this process's own Bolt by default); a file name never leaves it.
import { readFile } from 'node:fs/promises';
import type { DocsPort } from '../engine/contracts.ts';

// `src/node` and `build/node` are both two levels under the package root, so this resolves from either
export const DOCS_DIR = new URL('../../build/docs/', import.meta.url);

export const docs_port = (dir: URL = DOCS_DIR): DocsPort => ({
	read: (file, signal) => {
		if (!/^[a-z0-9.-]+\.json$/i.test(file))
			return Promise.reject(new Error(`no docs file ${file}`));
		return readFile(new URL(file, dir), { encoding: 'utf8', signal });
	}
});
