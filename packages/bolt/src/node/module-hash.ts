// A content key for what is built or run through some modules: their source and every module they reach by relative
// import, transitively (source `.ts` or a build's `.js` alike). Bare package imports are keyed by their caller.
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect, FileSystem, Option } from 'effect';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

/** A relative `import … from`, `export … from`, `import '…'` or `import('…')`; type-only imports carry no code. */
const RELATIVE =
	/\b(?:import|export)(\s+type\b)?[^;'"`]*?\bfrom\s*['"](\.\.?\/[^'"]+)['"]|\bimport\s*\(?\s*['"](\.\.?\/[^'"]+)['"]/g;

const closure = (entries: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const hash = createHash('sha256');
		const queue = entries.map((entry) => resolve(entry));
		const seen = new Set<string>();
		for (const file of queue) {
			if (seen.has(file)) continue;
			seen.add(file);
			// TypeScript source may import its `.ts` modules by their emitted `.js` name
			const text = yield* fs.readFileString(file).pipe(
				Effect.catch(() => fs.readFileString(file.replace(/\.js$/, '.ts'))),
				Effect.option
			);
			if (Option.isNone(text)) continue;
			hash.update(`${file}\0${text.value}\0`);
			for (const [, type, from, bare] of text.value.matchAll(RELATIVE)) {
				const specifier = type === undefined ? (from ?? bare) : undefined;
				if (specifier !== undefined)
					queue.push(resolve(dirname(file), specifier.replace(/\?.*$/, '')));
			}
		}
		return hash.digest('hex');
	}).pipe(Effect.provide(NodeFileSystem.layer));

const hashes = new Map<string, Effect.Effect<string>>();
/** The modules' content key (absolute paths), computed once per process. */
export const moduleHash = (...entries: ReadonlyArray<string>): Effect.Effect<string> => {
	const key = entries.join('\0');
	let cached = hashes.get(key);
	if (cached === undefined) {
		cached = Effect.runSync(Effect.cached(closure(entries)));
		hashes.set(key, cached);
	}
	return cached;
};
