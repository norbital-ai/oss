/// <reference types="node" />
// `@norbital-ai/bolt/docs` (§3.3.10, §7.3): the API reference and the authoring skills as data. `src/cli/docs.ts` writes
// it at build time from every public entry's declarations and `oss/skills/` (one JSON document per
// namespace and per skill, plus `index.json`); the website renders it and
// the agent's `docs` tool searches it (through its host's `Docs` port). Read lazily from `build/docs/`, next to this
// module in the published package.
import { readFileSync } from 'node:fs';
import { corpus } from '../engine/docs-corpus.ts';
export * from '../engine/docs-corpus.ts';

// `src/docs` and `build/docs` are both two levels under the package root, so this resolves from either
export const DOCS_DIR = new URL('../../build/docs/', import.meta.url);
const cache = new Map<string, unknown>();
/**
 * The docs corpus: `index()`, `namespace(ns)`, `symbol(ns, name)`, `search(text)` and `skill(name)`.
 * @example
 * docs.symbol('bolt', 'model')?.signature
 */
export const docs = corpus(<T>(file: string): T => {
	if (!cache.has(file)) cache.set(file, JSON.parse(readFileSync(new URL(file, DOCS_DIR), 'utf8')));
	return cache.get(file) as T;
});
