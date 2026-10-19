import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect, FileSystem } from 'effect';
import { PublicationFailed } from './error.ts';
const checkoutRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const realmRootFrom = Effect.fn('Publication.realmRoot')((start: string = checkoutRoot) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		let directory = path.resolve(start);
		for (;;) {
			const present = yield* Effect.forEach(
				['AGENTS.md', 'env-cli', 'norbital', 'templates'],
				(entry) => fs.exists(path.join(directory, entry)),
				{ concurrency: 'unbounded' }
			);
			if (present.every(Boolean)) return directory;
			const parent = path.dirname(directory);
			if (parent === directory) return undefined;
			directory = parent;
		}
	}).pipe(Effect.mapError(PublicationFailed.from))
);
export const scratchRoot = Effect.fn('Publication.scratchRoot')((start: string = checkoutRoot) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const realm = yield* realmRootFrom(start);
		const root =
			realm === undefined ? path.join(tmpdir(), 'norbital-scratch') : path.join(realm, '.tmp');
		yield* fs.makeDirectory(root, { recursive: true });
		return root;
	}).pipe(Effect.mapError(PublicationFailed.from))
);
export const scratchPath = Effect.fn('Publication.scratchPath')((...segments: readonly string[]) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const destination = path.join(yield* scratchRoot(), ...segments);
		yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
		return destination;
	}).pipe(Effect.mapError(PublicationFailed.from))
);
