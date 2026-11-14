// A release's digest recipe: what `bolt build` records and a host checks before it serves an uploaded release.
import { sha256_hex } from '@norbital-ai/store';
import { Effect, FileSystem, Path } from 'effect';

/** sha256 hex of a tree's sorted `<path>\0<sha256 hex>` lines, `\n`-joined: a folder's `tree_hash`, a skill's digest. */
export const tree_digest = (files: Iterable<readonly [path: string, bytes: Uint8Array]>): string =>
	sha256_hex(
		Array.from(files, ([file, bytes]) => `${file}\0${sha256_hex(bytes)}`)
			.sort()
			.join('\n')
	);
/** A tree's digest; `*.map` files are left out: the bundler writes random names into them, so they are not byte-stable. */
export const tree_hash = Effect.fn('HostApi.treeHash')(function* (dir: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	if (!(yield* fs.exists(dir))) return tree_digest([]);
	const files: (readonly [string, Uint8Array])[] = [];
	for (const name of yield* fs.readDirectory(dir, { recursive: true })) {
		const file = path.join(dir, name);
		if (!name.endsWith('.map') && (yield* fs.stat(file)).type === 'File')
			files.push([name.split(path.sep).join('/'), yield* fs.readFile(file)]);
	}
	return tree_digest(files);
});
