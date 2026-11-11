/// <reference types="node" />
// `@norbital-ai/bolt/docs` (§3.3.10, §7.3): the API reference, mechanism handbook and authoring skills as data. `scripts/docs.ts` writes
// it at build time from every public entry's declarations and `oss/skills/` (one JSON document per
// namespace and per skill, plus `index.json`); the website renders it and
// the agent's `docs` tool searches it (through its host's `Docs` port). Read lazily from `build/docs/`, next to this
// module in the published package.
import { readFileSync } from 'node:fs';
import { corpus } from '../engine/docs-corpus.ts';
export * from '../engine/docs-corpus.ts';

// `src/docs` and `build/docs` are both two levels under the package root, so this resolves from either
export const DOCS_DIR = new URL('../../build/docs/', import.meta.url);
/**
 * The docs corpus: `index()`, `namespace(ns)`, `symbol(ns, name)`, `search(text)`, `guide(slug)` and `skill(name)`.
 * @example
 * docs.symbol('bolt', 'ModelDeclaration')?.signature
 */
export const docs = corpus((file): unknown =>
	JSON.parse(readFileSync(new URL(file, DOCS_DIR), 'utf8'))
);
