// The kit's checkpoints, shared by every test process and run on this machine: compiled workspaces and guests by source,
// databases by schema. Each kind is keyed by the Bolt modules it is built through, so an unrelated Bolt edit keeps it.
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect, FileSystem, Option } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleHash } from '../node/module-hash.ts';

export const CHECKPOINTS = join(tmpdir(), 'norbital-bolt-test');

/** Directories no workspace source lives in. */
const UNSOURCED = new Set([
	'node_modules',
	'.norbital',
	'.git',
	'.svelte-kit',
	'build',
	'dist',
	'tests'
]);
/** A tree's files by relative path and content. */
export const treeHash = (dir: string): Effect.Effect<string, PlatformError> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const hash = createHash('sha256');
		const walk = (at: string): Effect.Effect<void, PlatformError> =>
			Effect.gen(function* () {
				for (const name of (yield* fs.readDirectory(at)).toSorted()) {
					if (UNSOURCED.has(name)) continue;
					const path = join(at, name),
						info = yield* fs.stat(path);
					if (info.type === 'Directory') yield* walk(path);
					else if (info.type === 'File')
						hash.update(`${relative(dir, path)}\0`).update(yield* fs.readFile(path));
				}
			});
		yield* walk(dir);
		return hash.digest('hex');
	}).pipe(Effect.provide(NodeFileSystem.layer));

/** Bolt's own tree (its source here, its build in an install). */
const BOLT = join(dirname(fileURLToPath(import.meta.url)), '..'),
	EXT = extname(fileURLToPath(import.meta.url));
const bolt = (...modules: ReadonlyArray<string>) =>
	moduleHash(...modules.map((module) => join(BOLT, `${module}${EXT}`)));
/** The Bolt modules each kind of checkpoint is built through (paths under Bolt's tree, without extension). */
export const inputs = {
	/** A schema's planned DDL in PGlite, and the shape the kit reads of it. */
	image: bolt('test/database'),
	/** A guest bundled through the attachment edge, with whatever of Bolt it imports. */
	guest: bolt('test/guest', 'index', 'decl/runtime/guest', 'decl/body', 'decl/errors'),
	/** A workspace's check: its manifest and guest. */
	check: bolt('compiler/check/index', 'index'),
	/** A workspace's test pack, from its checked manifest. */
	seed: bolt('compiler/check/index', 'compiler/artifact/seed', 'index'),
	/** A workspace's whole `bolt build`. */
	release: bolt('cli/build', 'index')
};

/** Written whole, then renamed: a parallel test process never reads half a checkpoint. */
export const keep = (file: string, data: string | Uint8Array): Effect.Effect<void, PlatformError> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* fs.makeDirectory(dirname(file), { recursive: true });
		const temporary = `${file}.${randomUUID()}`;
		yield* typeof data === 'string'
			? fs.writeFileString(temporary, data)
			: fs.writeFile(temporary, data);
		yield* fs.rename(temporary, file);
	}).pipe(Effect.provide(NodeFileSystem.layer));

const pruned = new Set<string>();
const stem = (name: string) => name.split('.', 1)[0] ?? name;
/**
 * Keeps a checkpoint directory's newest `count` entries (an entry, its companions and its in-flight writes share the
 * name before the first dot); once per directory and process, after its first write. Another process may prune the
 * same directory: an entry gone meanwhile is skipped.
 */
export const prune = (dir: string, count: number): Effect.Effect<void> =>
	Effect.suspend(() => {
		if (pruned.has(dir)) return Effect.void;
		pruned.add(dir);
		return Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const names = yield* fs.readDirectory(dir);
			const latest = new Map<string, number>();
			for (const name of names) {
				const info = yield* fs.stat(join(dir, name)).pipe(Effect.option);
				if (Option.isNone(info)) continue;
				const at = Option.getOrElse(info.value.mtime, () => new Date(0)).getTime();
				latest.set(stem(name), Math.max(latest.get(stem(name)) ?? 0, at));
			}
			const old = new Set(
				[...latest]
					.toSorted((a, b) => b[1] - a[1])
					.slice(count)
					.map(([name]) => name)
			);
			for (const name of names)
				if (old.has(stem(name)))
					yield* fs.remove(join(dir, name), { recursive: true, force: true });
		}).pipe(Effect.ignore, Effect.provide(NodeFileSystem.layer));
	});
