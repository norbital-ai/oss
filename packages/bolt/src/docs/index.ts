/// <reference types="node" />
// `@norbital-ai/bolt/docs`: the API reference and authoring skills as data. `scripts/docs.ts` writes
// it at build time from every public entry's declarations and `oss/skills/` (one JSON document per
// namespace and per skill, plus `index.json`); the website renders it and
// the agent's `docs` tool searches it (through its host's `Docs` port). Read lazily from `build/docs/`, next to this
// module in the published package.
import { readFileSync } from 'node:fs';
import { Effect } from 'effect';
import { FacilityFailure } from '../decl/errors.ts';
import { corpus } from '../engine/docs-corpus.ts';
import { DOCS_DIR } from '../node/docs.ts';
/**
 * The docs corpus, read on first run and kept: `index()`, `namespace(ns)`, `symbol(ns, name)`, `search(text)` and
 * `skill(name)`.
 * @example
 * (yield* docs).symbol('bolt', 'ModelDeclaration')?.signature
 */
export const docs = Effect.runSync(
	Effect.cached(
		corpus((file) =>
			Effect.try({
				try: (): unknown => JSON.parse(readFileSync(new URL(file, DOCS_DIR), 'utf8')),
				catch: (error) => new FacilityFailure({ kind: 'invalid', message: `docs ${file}: ${String(error)}` })
			})
		)
	)
);
