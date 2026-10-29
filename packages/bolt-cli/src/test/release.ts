// A workspace's whole `bolt build` as a checkpoint, for a host's tests: built once per source and the Bolt modules
// it builds through on this machine, never committed.
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, FileSystem } from 'effect';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { CHECKPOINTS, inputs, prune, treeHash } from './checkpoint.ts';
import { KitInvalid } from './effect.ts';

/** Releases kept on this machine: each a whole build, so only a few. */
const KEPT_RELEASES = 16;
/** The nearest `node_modules` the workspace resolves its packages from in place. */
const modulesOf = (root: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		for (let at = root; ; at = dirname(at)) {
			if (yield* fs.exists(join(at, 'node_modules'))) return join(at, 'node_modules');
			if (dirname(at) === at)
				return yield* new KitInvalid({ message: `release: no node_modules above ${root}` });
		}
	});

/**
 * `root`'s release as `bolt build` lays it out (`bundle/`, `source/`, `seed/<pack>/`, `release.json`): answers
 * its directory. Built in a private copy resolving the workspace's own packages, then renamed into place whole.
 */
export const release = (root: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const key = createHash('sha256')
			.update([yield* inputs.release, yield* treeHash(root)].join('\0'))
			.digest('hex');
		const kept = join(CHECKPOINTS, 'releases', key);
		if (yield* fs.exists(join(kept, 'release.json'))) return kept;
		yield* Effect.scoped(
			Effect.gen(function* () {
				const work = `${kept}.${randomUUID()}`;
				yield* Effect.addFinalizer(() =>
					fs.remove(work, { recursive: true, force: true }).pipe(Effect.ignore)
				);
				yield* fs.makeDirectory(work, { recursive: true });
				for (const entry of yield* fs.readDirectory(root))
					if (entry !== 'node_modules' && entry !== '.norbital')
						yield* fs.copy(join(root, entry), join(work, entry));
				yield* fs.symlink(yield* modulesOf(root), join(work, 'node_modules'));
				const { buildWorkspace } = yield* Effect.promise(() => import('../cli/build.ts'));
				yield* buildWorkspace(work);
				yield* fs.remove(join(work, '.norbital', 'cache'), { recursive: true, force: true });
				// the first rename wins; a parallel process's finished build is as good
				yield* fs
					.rename(join(work, '.norbital'), kept)
					.pipe(
						Effect.catch((error) =>
							fs
								.exists(join(kept, 'release.json'))
								.pipe(Effect.flatMap((raced) => (raced ? Effect.void : Effect.fail(error))))
						)
					);
			})
		);
		yield* prune(dirname(kept), KEPT_RELEASES);
		return kept;
	}).pipe(
		Effect.provide(NodeServices.layer),
		Effect.mapError((cause) =>
			cause instanceof KitInvalid
				? cause
				: new KitInvalid({
						message: `release ${root}: ${
							cause._tag === 'AuthorErrors'
								? cause.errors.map((d) => `${d.code} ${d.path} ${d.message}`).join('\n')
								: cause.message
						}`
					})
		)
	);
