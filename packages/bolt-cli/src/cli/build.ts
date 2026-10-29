/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { Effect, FileSystem, Path, Queue, Schema, Stream } from 'effect';
import { watch } from 'node:fs';
import { createHash } from 'node:crypto';
import {
	cloneTree,
	memoTreeHash,
	ReleaseJson,
	writeArtifact,
	writeSource
} from '../compiler/artifact/index.ts';
import { buildPacks } from '../compiler/artifact/seed.ts';
import { CONTRACT, readArtifact, type Artifact } from '@norbital-ai/bolt/artifact';
import { readPackSource, type PackJson } from '@norbital-ai/bolt/engine';
import type {
	BoltError,
	EngineManifest,
	GuestProgram,
	ManifestInvalid
} from '@norbital-ai/bolt/engine';
import type { PlatformError } from 'effect/PlatformError';
import { BundleError, compile, EvalError } from '../compiler/check/index.ts';
import { BuildError } from '../compiler/artifact/client.ts';
import { Diagnostic, type CheckDiagnostic } from '@norbital-ai/bolt/tooling';
import { discover, type Discovered } from '../compiler/discover.ts';

export type Log = (line: string) => void;
export class AuthorErrors extends Schema.TaggedError<AuthorErrors>()('AuthorErrors', {
	message: Schema.String,
	errors: Schema.Array(Diagnostic)
}) {}
export class ToolFailure extends Schema.TaggedError<ToolFailure>()('ToolFailure', {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Defect())
}) {}
/**
 * Everything the base pack is built from: the seed tree, the schema it is written against, the locked toolchain and
 * the pack code itself (a local Bolt build changes it under an unchanged lockfile).
 */
const seedInputs = Effect.fn('bolt.seedInputs')(function* (root: string, schema: string) {
	const fs = yield* FileSystem.FileSystem,
		path = yield* Path.Path,
		hash = createHash('sha256').update(schema),
		seed = path.join(root, 'seed'),
		lock = path.join(root, 'bun.lock');
	if (yield* fs.exists(lock)) hash.update(yield* fs.readFile(lock));
	for (const module of ['../compiler/seed', '../compiler/artifact/seed'])
		hash.update(
			yield* fs.readFile(
				fileURLToPath(new URL(`${module}${path.extname(import.meta.url)}`, import.meta.url))
			)
		);
	if (yield* fs.exists(seed))
		for (const file of (yield* fs.readDirectory(seed, { recursive: true })).toSorted()) {
			const at = path.join(seed, file);
			if ((yield* fs.stat(at)).type !== 'File') continue;
			hash.update(`\0${file}\0`).update(yield* fs.readFile(at));
		}
	return hash.digest('hex');
});
/**
 * Every build is a full build (a Studio preview's is the one its merge reuses) through declaration compilation; the
 * authoring diagnostics and type check are `bolt check`, and the audit is doctor's. Any build reuses an unchanged
 * base pack, and an unchanged migration history skips its replay. A watch's rebuild (`changed`) skips the guest's
 * terser pass and takes from its last good build what its edits leave unchanged: the compiled declarations, the
 * platform layer, the seed packs and every unrewritten file's digest.
 *
 * A build is published atomically: each part (`bundle`, `source`, `seed`) is assembled under `.norbital/.next/` (a
 * watch's rebuild starts from clones of the live parts) and renamed into place, then `release.json` names their digests,
 * replaced whole and written last. A reader that resolves `release.json` and then reads its parts either sees that
 * build or finds a part whose digest no longer matches (a later build swapped it in), and reads again.
 */
/** Whether `pid` names a running process. */
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
/**
 * One build of a workspace at a time: `.norbital/.building` holds the building process's pid, created exclusively. A
 * second build (another watcher, a manual `bolt build`) waits for it, so two never swap `.norbital/` over each other; a
 * dead holder's marker is taken over.
 */
const holdingBuild = <A, E, R>(dir: string, build: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem,
			path = yield* Path.Path,
			marker = path.join(dir, '.norbital', '.building');
		yield* fs.makeDirectory(path.dirname(marker), { recursive: true });
		const hold: Effect.Effect<void> = fs
			.writeFileString(marker, String(process.pid), { flag: 'wx' })
			.pipe(
				Effect.catch(() =>
					fs.readFileString(marker).pipe(
						Effect.orElseSucceed(() => ''),
						Effect.flatMap((holder) =>
							alive(Number(holder))
								? Effect.sleep('250 millis')
								: fs.remove(marker, { force: true }).pipe(Effect.ignore)
						),
						Effect.andThen(Effect.suspend(() => hold))
					)
				),
				Effect.orDie
			);
		return yield* Effect.acquireUseRelease(
			hold,
			() => build,
			() => fs.remove(marker, { force: true }).pipe(Effect.ignore)
		);
	});
export type BuildOptions = {
	log?: Log;
	squash?: string;
	changed?: readonly string[];
	/** A watch's last good build, before the edits in `changed`. */
	previous?: Built;
	/** `bolt dev` serves the internal SPA from source: an edit in its graph alone keeps the browser build. */
	spaServed?: boolean;
};
export type BuildFailure =
	| AuthorErrors
	| BoltError
	| BuildError
	| BundleError
	| EvalError
	| ManifestInvalid
	| PlatformError
	| Schema.SchemaError;
const buildOnce = Effect.fn('bolt.buildWorkspace')(function* (
	dir: string,
	options: BuildOptions = {}
) {
	const fs = yield* FileSystem.FileSystem,
		path = yield* Path.Path,
		root = yield* fs.realPath(dir);
	const { files } = yield* discover(root),
		norbital = path.join(root, '.norbital'),
		next = path.join(norbital, '.next'),
		out = path.join(next, 'bundle'),
		{ previous, changed } = options,
		edited = (test: (file: string) => boolean) =>
			previous === undefined || changed === undefined || changed.some(test);
	// a `.svelte` file reaches the manifest by its path alone and never the guest, and compilation reads no seed
	const compiled =
		previous !== undefined &&
		!edited((file) => !file.endsWith('.svelte') && !file.startsWith('seed/')) &&
		JSON.stringify(files) === JSON.stringify(previous.files)
			? previous.compiled
			: yield* compile(root, {
					migrations: 'generate',
					compress: changed === undefined,
					...(options.squash === undefined ? {} : { squash: options.squash })
				}).pipe(
					Effect.flatMap(({ errors, manifest, guest }) =>
						errors.length > 0 || manifest === undefined || guest === undefined
							? Effect.fail(new AuthorErrors({ errors, message: `${errors.length} errors` }))
							: Effect.succeed({ manifest, guest })
					)
				);
	yield* fs.remove(next, { recursive: true, force: true });
	if (changed !== undefined) yield* cloneTree(path.join(norbital, 'bundle'), out);
	const artifact = yield* writeArtifact(root, compiled, files, out, {
		...(changed === undefined ? {} : { changed }),
		...(options.spaServed === undefined ? {} : { spaServed: options.spaServed })
	});
	const seedOut = path.join(next, 'seed');
	// the packs are a function of the seed tree, the schema and the lockfile (which a watch does not see change)
	const seeded =
		previous !== undefined &&
		previous.artifact.artifact.schema === artifact.schema &&
		!edited((file) => file.startsWith('seed/'))
			? previous
			: yield* cloneTree(path.join(norbital, 'seed'), seedOut).pipe(
					Effect.andThen(seedWorkspace(root, compiled.manifest, artifact.schema, seedOut))
				);
	const release: ReleaseJson = {
		format: 1,
		handle: artifact.handle,
		bundle: yield* memoTreeHash(out),
		source: yield* writeSource(root, path.join(next, 'source')),
		seed:
			seeded === previous
				? previous.release.seed
				: Object.fromEntries(
						yield* Effect.forEach(
							(yield* fs.readDirectory(seedOut))
								.filter((name) => name !== 'inputs.sha256')
								.toSorted(),
							(name) =>
								fs
									.exists(path.join(seedOut, name, 'pack.json'))
									.pipe(
										Effect.flatMap((pack) =>
											pack
												? memoTreeHash(path.join(seedOut, name)).pipe(
														Effect.map((digest) => [[name, digest] as const])
													)
												: Effect.succeed([])
										)
									)
						).pipe(Effect.map((entries) => entries.flat()))
					)
	};
	// each part swapped in whole, never rewritten in place; the old one is removed once nothing names it
	const old = path.join(norbital, '.old');
	yield* fs.remove(old, { recursive: true, force: true });
	yield* fs.makeDirectory(old);
	for (const part of seeded === previous ? ['bundle', 'source'] : ['bundle', 'source', 'seed']) {
		const live = path.join(norbital, part);
		if (yield* fs.exists(live)) yield* fs.rename(live, path.join(old, part));
		yield* fs.rename(path.join(next, part), live);
	}
	// replaced whole, last: a reader that finds it finds every part it names
	const record = path.join(norbital, 'release.json');
	yield* fs.writeFileString(
		`${record}.next`,
		`${JSON.stringify(Schema.encodeSync(ReleaseJson)(release), null, '\t')}\n`
	);
	yield* fs.rename(`${record}.next`, record);
	yield* fs.remove(old, { recursive: true });
	yield* fs.remove(next, { recursive: true });
	const bundle = path.join(norbital, 'bundle');
	options.log?.(
		`built ${artifact.handle} ${artifact.hash.slice(0, 12)} (schema ${artifact.schema.slice(0, 12)}) → ${bundle}`
	);
	if (seeded !== previous)
		for (const [name, pack] of Object.entries(seeded.packs))
			options.log?.(
				`  seed pack ${name} ${pack.hash.slice(0, 12)}: ${
					Object.entries(pack.rows)
						.map(([model, count]) => `${model}=${count}`)
						.join(' ') || 'empty'
				}${pack.start.length > 0 ? `; start ${pack.start.join(', ')}` : ''}`
			);
	return {
		// its trees were hashed as they were written
		artifact: yield* readArtifact(bundle, [CONTRACT], 'executed'),
		files,
		packs: seeded.packs,
		release,
		compiled
	};
});
/** `bolt build`: one at a time per workspace (`holdingBuild`). */
export const buildWorkspace = (
	dir: string,
	options?: BuildOptions
): Effect.Effect<Built, BuildFailure, FileSystem.FileSystem | Path.Path> =>
	holdingBuild(dir, buildOnce(dir, options));
/** The seed packs under `seedOut`: an unchanged base pack is reused. */
const seedWorkspace = Effect.fn('bolt.seedWorkspace')(function* (
	root: string,
	manifest: EngineManifest,
	schema: string,
	seedOut: string
) {
	const fs = yield* FileSystem.FileSystem,
		path = yield* Path.Path,
		stampFile = path.join(seedOut, 'inputs.sha256'),
		stamp = yield* seedInputs(root, schema);
	if (
		(yield* fs.exists(path.join(seedOut, 'base', 'pack.json'))) &&
		(yield* fs.readFileString(stampFile).pipe(Effect.catch(() => Effect.succeed('')))) === stamp
	)
		return { packs: { base: (yield* readPackSource(path.join(seedOut, 'base'))).meta } };
	yield* fs.remove(stampFile, { force: true });
	const packErrors: CheckDiagnostic[] = [];
	const packs = yield* buildPacks(root, manifest, seedOut, packErrors);
	if (packErrors.length > 0)
		return yield* Effect.fail(
			new AuthorErrors({ errors: packErrors, message: `${packErrors.length} seed errors` })
		);
	yield* fs.makeDirectory(seedOut, { recursive: true });
	yield* fs.writeFileString(stampFile, stamp);
	return { packs };
});

export type Built = {
	readonly artifact: Artifact;
	readonly files: readonly Discovered[];
	readonly packs: { readonly [pack: string]: PackJson };
	readonly release: ReleaseJson;
	readonly compiled: { readonly manifest: EngineManifest; readonly guest: GuestProgram };
};
/**
 * `bolt dev` (tethered and untethered): one rebuild per settled burst of edits under `src/`, `seed/` and the editable
 * `migrations/*.sql`, handed to `built`. A rebuild skips the type check, an unchanged migration replay and the guest's
 * terser pass (`bolt check`, `bolt build` and CI own those), and the browser and SSR builds are kept while no edited file is in their module graphs. Each
 * rebuild starts from the last good one (`first`, the build before the watch, if it succeeded). A failed rebuild is
 * logged; the loop goes on, and the next rebuild starts from nothing.
 */
export const watchWorkspace = Effect.fn('bolt.watchWorkspace')(function* (
	root: string,
	options: { log: Log; spaServed?: boolean },
	built: (result: Built) => Effect.Effect<void>,
	first?: Built
) {
	let previous = first;
	const fs = yield* FileSystem.FileSystem,
		path = yield* Path.Path;
	const dirs = yield* Effect.filter(
		['src', 'seed', 'migrations'].map((name) => ({ name, directory: path.join(root, name) })),
		({ directory }) => fs.exists(directory)
	);
	// the watcher's callbacks run outside the fiber: the burst's paths gather here until the debounce settles
	const pending = new Set<string>();
	const changes = Stream.callback<void, ToolFailure>((queue) =>
		Effect.acquireRelease(
			Effect.try({
				try: () =>
					dirs.map(({ name, directory }) =>
						watch(directory, { recursive: true }, (_event, file) => {
							// A build rewrites migration metadata; only editable SQL starts another build.
							if (name === 'migrations' && file?.endsWith('.sql') !== true) return;
							pending.add(file === null ? name : `${name}/${file.split(path.sep).join('/')}`);
							Queue.offerUnsafe(queue, undefined);
						})
					),
				catch: (cause) =>
					new ToolFailure({ message: 'The workspace watcher could not open.', cause })
			}),
			(watchers) =>
				Effect.sync(() => {
					for (const watcher of watchers) watcher.close();
				})
		)
	);
	return yield* changes.pipe(
		Stream.debounce('150 millis'),
		Stream.runForEach(() =>
			Effect.gen(function* () {
				const edited = [...pending];
				pending.clear();
				// an editor's atomic save writes through a temp file: a path neither on disk nor in the last build's source
				// copy came and went, and would otherwise make a page-only edit look like more
				const changed = yield* Effect.filter(edited, (file) =>
					Effect.map(
						Effect.all([
							fs.exists(path.join(root, file)),
							fs.exists(path.join(root, '.norbital', 'source', file))
						]).pipe(Effect.orElseSucceed(() => [true, true] as const)),
						([now, before]) => now || before
					)
				);
				if (changed.length === 0) return;
				yield* buildWorkspace(root, {
					log: options.log,
					changed,
					...(previous === undefined ? {} : { previous }),
					...(options.spaServed === undefined ? {} : { spaServed: options.spaServed })
				}).pipe(
					Effect.tap((result) => Effect.sync(() => (previous = result))),
					Effect.flatMap(built),
					Effect.catch((error) =>
						Effect.sync(() => {
							previous = undefined;
							options.log(
								error instanceof AuthorErrors
									? error.errors.map((diagnostic) => diagnostic.message).join('\n')
									: String(error)
							);
						})
					)
				);
			})
		)
	);
});
