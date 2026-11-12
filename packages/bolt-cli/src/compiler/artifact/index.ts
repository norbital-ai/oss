/// <reference types="node" />
// `bolt build` writes the release into `.norbital/`: the BUNDLE a host runs (`bundle/`: `artifact.json`, `manifest.json`
// (C1, pure data), `schema.sql`, `guest.mjs` (tenant code only) with its `guest-assets/<sha256>`, `client/**`,
// `server/**`, `assets/**`, `skills/**`, `migrations/**` and `workspace/**`, the agent's `workspace_search` source and a
// host language tool's type setup), the SOURCE Studio edits (`source/`) and the SEED packs (`seed/<pack>/`), each with
// its own digest in `release.json`. Every host activates the bundle through `read_artifact`.
import { Effect, FileSystem, Option, Path, Schema } from 'effect';
import { SKILL_FILE, type EngineManifest, plan } from '@norbital-ai/bolt/engine';
import { TemplateManifest } from '@norbital-ai/bolt/protocol';
import { HOST_FILE, fingerprint, schema_slice } from '@norbital-ai/bolt/tooling';
import { constants, cpSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { GuestProgram } from '@norbital-ai/bolt/engine';
import { statements } from '@norbital-ai/store';
import type { Discovered } from '../discover.ts';
import { buildClient, BuildError, type Graphs } from './client.ts';
import { buildServerPages } from './server.ts';
import { layerLines, PLATFORM, type PreparedLayer } from './platform.ts';
import {
	artifact_hash,
	ArtifactJson,
	CONTRACT,
	tree
} from '@norbital-ai/bolt/artifact';
import { sha256_hex } from '@norbital-ai/store';

const TEST = /\.(test|spec)\.ts$/;
const mtime = (stat: FileSystem.File.Info) =>
	Option.getOrElse(
		Option.map(stat.mtime, (date) => date.getTime()),
		() => 0
	);
/**
 * `from`'s tree as clones into `to`, replaced whole: each path `take` admits (a directory it refuses is not entered),
 * symbolic links followed. Timestamps are kept, so `memoTreeHash` reads only the files that changed.
 */
export const cloneTree = Effect.fn('bolt.cloneTree')(function* (
	from: string,
	to: string,
	take: (file: string) => boolean = () => true
) {
	const fs = yield* FileSystem.FileSystem;
	yield* fs.remove(to, { recursive: true, force: true });
	if (!(yield* fs.exists(from))) return;
	yield* Effect.tryPromise({
		try: () =>
			cp(from, to, {
				recursive: true,
				dereference: true,
				preserveTimestamps: true,
				mode: constants.COPYFILE_FICLONE,
				filter: (at) => at === from || take(relative(from, at).split(sep).join('/'))
			}),
		catch: (cause) => new BuildError({ cause })
	});
});
// ponytail: keyed by millisecond mtime, so a same-size rewrite within one millisecond keeps its old digest (a build
// writes a file once); entries for deleted files stay until the process exits
const digests = new Map<string, { size: bigint; mtime: number; hex: string }>();
/** `tree_hash` (the same `<path>\0<sha256>` lines, `*.map` left out) that reads only the files changed since this process hashed them. */
export const memoTreeHash = Effect.fn('bolt.memoTreeHash')(function* (
	dir: string,
	/** Lines of files the tree holds only once its host adds them. */
	held: readonly string[] = []
) {
	const fs = yield* FileSystem.FileSystem;
	const lines = [...held];
	for (const file of yield* tree(dir)) {
		if (file.endsWith('.map')) continue;
		const at = join(dir, file),
			stat = yield* fs.stat(at);
		let known = digests.get(at);
		if (known === undefined || known.size !== stat.size || known.mtime !== mtime(stat)) {
			known = { size: stat.size, mtime: mtime(stat), hex: sha256_hex(yield* fs.readFile(at)) };
			digests.set(at, known);
		}
		lines.push(`${file}\0${known.hex}`);
	}
	return sha256_hex(lines.sort().join('\n'));
});

/** The template's catalogue metadata when present (`key` and `name`). */
const templateMeta = Effect.fn('bolt.templateMeta')(function* (root: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const file = path.join(root, 'norbital.template.json');
	if (!(yield* fs.exists(file))) return { handle: path.basename(root), name: path.basename(root) };
	const t = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TemplateManifest))(
		yield* fs.readFileString(file)
	);
	return { handle: t.key, name: t.name };
});

/** `schema.sql`: the plan from an empty database, in apply order (review aid; hosts apply `plan`, rule 69). */
export const schemaSql = (m: EngineManifest) =>
	Effect.map(
		plan(null, m),
		(p) => `${statements(p).map((s) => `${s.sql.trim().replace(/;?$/, ';')}`).join('\n\n')}\n`
	);

/** The workspace's type setup, copied into the artifact's `workspace/` beside its source. */
const TYPE_SETUP = [
	'tsconfig.json',
	'package.json',
	'.norbital/tsconfig.json',
	'.norbital/names.ts',
	'.norbital/bolt.d.ts'
] as const;
const Graph = Schema.Struct({
	spa: Schema.Array(Schema.String),
	pages: Schema.Array(Schema.String)
});
const PageEntry = Schema.Struct({
	entry: Schema.String,
	css: Schema.Array(Schema.String),
	server: Schema.Struct({ file: Schema.String, sha256: Schema.String })
});
const HeldPages = Schema.fromJsonString(
	Schema.Struct({
		key: Schema.String,
		sources: Schema.Array(Schema.String),
		pages: Schema.Record(Schema.String, PageEntry),
		/** Each route's stylesheet sources: the next build's first public pass starts from them. */
		styles: Schema.Record(Schema.String, Schema.Array(Schema.String))
	})
);
/** The public pages' browser and SSR builds are a function of the workspace files in their graphs and what `clientKey` covers. */
export const pagesKey = Effect.fn('bolt.pagesKey')(function* (
	root: string,
	clientKey: string,
	sources: readonly string[]
) {
	const fs = yield* FileSystem.FileSystem;
	const lines = [clientKey];
	for (const source of sources) {
		const at = join(root, source);
		lines.push(`${source}\0${(yield* fs.exists(at)) ? sha256_hex(yield* fs.readFile(at)) : ''}`);
	}
	return sha256_hex(lines.join('\n'));
});
/** The parts of a bundle the public pages' builds write, each with its name in the held copy. */
const heldParts = (out: string) =>
	[
		[join(out, 'client', 'public'), 'public'],
		[join(out, 'server'), 'server']
	] as const;
/** Writes the compiled bundle into `out`: empty for a full build, a clone of the last bundle for a watch's rebuild. */
export const writeArtifact = Effect.fn('bolt.writeArtifact')(function* (
	root: string,
	c: { manifest: EngineManifest; guest: GuestProgram },
	files: readonly Discovered[],
	out: string,
	options: {
		/** The paths edited since the last build (a watch): the browser and SSR builds are kept while none is in their graphs. */
		readonly changed?: readonly string[];
		/** A dev server serves the internal SPA from source: its graph never forces a rebuild. */
		readonly spaServed?: boolean;
		/** The layer its host prepared (`bolt build --platform`): its files are the host's to add to the bundle. */
		readonly prepared?: PreparedLayer;
	} = {}
) {
	const fs = yield* FileSystem.FileSystem;
	const meta = yield* templateMeta(root);
	const cache = join(root, '.norbital', 'cache'),
		keyFile = join(cache, 'client.key'),
		graphFile = join(cache, 'client-graph.json'),
		kept = join(cache, 'client-kept'),
		heldDir = join(cache, 'pages');
	// what the generated entries are made of: the manifest parts they read and every discovered file's path
	const clientKey = sha256_hex(
		JSON.stringify([
			meta.name,
			c.manifest.workspace,
			c.manifest.apps,
			c.manifest.groups ?? {},
			c.manifest.custom_fields,
			files.map((f) => f.path)
		])
	);
	const changed = options.changed;
	const graph =
		changed === undefined ||
		(yield* fs.readFileString(keyFile).pipe(Effect.orElseSucceed(() => ''))) !== clientKey
			? undefined
			: yield* fs
					.readFileString(graphFile)
					.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Graph))),
						Effect.option,
						Effect.map(Option.getOrUndefined)
					);
	// a page build is reused only while no file in its module graph changed
	const stale =
		graph === undefined ||
		(changed ?? []).some(
			(file) =>
				graph.pages.includes(file) || (options.spaServed !== true && graph.spa.includes(file))
		);
	// an edit only the dev server's internal SPA reaches leaves the bundle as it was, its source copy too: its digest holds,
	// so a host following the build sees no new release while the dev server hot-updates the page
	const served =
		options.spaServed === true &&
		graph !== undefined &&
		changed !== undefined &&
		changed.every((file) => graph.spa.includes(file) && !graph.pages.includes(file));
	const previous =
		!stale && (yield* fs.exists(join(out, 'artifact.json')))
			? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ArtifactJson))(
					yield* fs.readFileString(join(out, 'artifact.json'))
				)
			: undefined;
	// a build starts from an empty bundle; a watch's rebuild edits a clone of the last one, so a file it leaves alone
	// keeps its mtime and its remembered digest
	if (changed === undefined) yield* fs.remove(out, { recursive: true, force: true });
	else if (previous === undefined) {
		// the platform layer is the same bytes for every build on this Bolt: a rebuilt client keeps it (`buildClient`)
		const layer = join(out, 'client', PLATFORM);
		yield* fs.remove(kept, { recursive: true, force: true });
		if (yield* fs.exists(layer)) {
			yield* fs.makeDirectory(kept, { recursive: true });
			yield* fs.rename(layer, join(kept, 'platform'));
		}
		yield* fs.remove(join(out, 'client'), { recursive: true, force: true });
		yield* fs.remove(join(out, 'server'), { recursive: true, force: true });
		if (yield* fs.exists(join(kept, 'platform'))) {
			yield* fs.makeDirectory(dirname(layer), { recursive: true });
			yield* fs.rename(join(kept, 'platform'), layer);
		}
	}
	yield* fs.makeDirectory(out, { recursive: true });
	const manifestText = `${JSON.stringify(c.manifest, null, '\t')}\n`;
	yield* fs.writeFileString(join(out, 'manifest.json'), manifestText);
	yield* fs.writeFileString(join(out, 'guest.mjs'), c.guest.source);
	if (c.guest.source_map === undefined)
		yield* fs.remove(join(out, 'guest.mjs.map'), { force: true });
	else yield* fs.writeFileString(join(out, 'guest.mjs.map'), c.guest.source_map);
	// `?bytes` imports (§5.8), by sha256; server-only, never under the browser-served `assets/`. guest.mjs names each sha, so its hash covers them
	yield* fs.remove(join(out, 'guest-assets'), { recursive: true, force: true });
	for (const [hash, bytes] of Object.entries(c.guest.assets ?? {})) {
		yield* fs.makeDirectory(join(out, 'guest-assets'), { recursive: true });
		yield* fs.writeFile(join(out, 'guest-assets', hash), bytes);
	}
	yield* fs.writeFileString(join(out, 'schema.sql'), yield* schemaSql(c.manifest));
	yield* cloneTree(join(root, 'migrations'), join(out, 'migrations'));
	const pages: Record<string, ArtifactJson['pages'][string]> = {};
	let client: ArtifactJson['client'];
	if (previous !== undefined) {
		Object.assign(pages, previous.pages);
		client = previous.client;
	} else {
		const sources: Graphs = { spa: new Set(), pages: new Set() };
		// most edits reach no public page: the last build of these exact inputs is the build
		const held = yield* fs.readFileString(join(heldDir, 'pages.json')).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(HeldPages)),
			Effect.option,
			Effect.map(Option.getOrUndefined)
		);
		const kept =
			held !== undefined && held.key === (yield* pagesKey(root, clientKey, held.sources))
				? held
				: undefined;
		const builtClient = yield* buildClient(
			root,
			files,
			c.manifest,
			join(out, 'client'),
			meta.name,
			sources,
			options.prepared?.layer,
			kept !== undefined,
			held?.styles
		);
		if (kept === undefined) {
			const serverPages = yield* buildServerPages(root, files, c.manifest, out, sources.pages);
			for (const [route, server] of Object.entries(serverPages)) {
				const page = builtClient.pages[route];
				if (page === undefined)
					return yield* new BuildError({
						cause: new Error(`Public page ${route} has no browser entry`)
					});
				pages[route] = { ...page, server };
			}
			const graphed = [...sources.pages].sort();
			yield* fs.remove(heldDir, { recursive: true, force: true });
			yield* fs.makeDirectory(heldDir, { recursive: true });
			for (const [from, to] of heldParts(out))
				if (yield* fs.exists(from))
					yield* Effect.sync(() => cpSync(from, join(heldDir, to), { recursive: true }));
			yield* fs.writeFileString(
				join(heldDir, 'pages.json'),
				JSON.stringify({
					key: yield* pagesKey(root, clientKey, graphed),
					sources: graphed,
					pages,
					styles: builtClient.publicSources
				})
			);
		} else {
			Object.assign(pages, kept.pages);
			for (const source of kept.sources) sources.pages.add(source);
			for (const [to, from] of heldParts(out))
				if (yield* fs.exists(join(heldDir, from)))
					yield* Effect.sync(() => cpSync(join(heldDir, from), to, { recursive: true }));
		}
		client = { entry: builtClient.entry, css: builtClient.css };
		yield* fs.makeDirectory(dirname(keyFile), { recursive: true });
		yield* fs.writeFileString(
			graphFile,
			JSON.stringify({ spa: [...sources.spa].sort(), pages: [...sources.pages].sort() })
		);
		yield* fs.writeFileString(keyFile, clientKey);
	}
	yield* cloneTree(join(root, 'assets'), join(out, 'assets'));
	// each skill's folder as its tree: `+skill.md` is written as its `SKILL.md`
	yield* fs.remove(join(out, 'skills'), { recursive: true, force: true });
	for (const f of files.filter((x) => x.role === 'skill'))
		for (const file of c.manifest.agent.skills[f.name]?.files ?? []) {
			const to = join(out, 'skills', f.name, file);
			yield* fs.makeDirectory(dirname(to), { recursive: true });
			yield* fs.copyFile(join(root, dirname(f.path), file === SKILL_FILE ? '+skill.md' : file), to);
		}
	if (!served)
		yield* cloneTree(join(root, 'src'), join(out, 'workspace', 'src'), (file) => !TEST.test(file));
	yield* cloneTree(join(root, 'migrations'), join(out, 'workspace', 'migrations'));
	// the type setup `check` wrote beside it: a host's language tool type-checks the release as built
	for (const file of TYPE_SETUP)
		if (yield* fs.exists(join(root, file))) {
			yield* fs.makeDirectory(dirname(join(out, 'workspace', file)), { recursive: true });
			yield* fs.copyFile(join(root, file), join(out, 'workspace', file));
		}
	const hashes = {
		manifest: sha256_hex(manifestText),
		guest: sha256_hex(c.guest.source),
		client: yield* memoTreeHash(join(out, 'client'), layerLines(options.prepared, '')),
		server: yield* memoTreeHash(join(out, 'server'))
	};
	const body = {
		format: 1 as const,
		contract: CONTRACT,
		handle: meta.handle,
		name: meta.name,
		schema: fingerprint(schema_slice(c.manifest)),
		client,
		pages,
		hashes
	};
	const artifact: ArtifactJson = { ...body, hash: yield* artifact_hash(out, body) };
	yield* fs.writeFileString(
		join(out, 'artifact.json'),
		`${JSON.stringify(artifact, null, '\t')}\n`
	);
	return artifact;
});

/** What a template holds beside its source: never copied into a release's `source/`. */
const NOT_SOURCE = new Set([
	'node_modules',
	'.norbital',
	'.git',
	'.tmp',
	'.turbo',
	'.svelte-kit',
	'build',
	'dist',
	'coverage',
	'.DS_Store',
	HOST_FILE
]);
/** The template's authored tree without tests and its host file, the source Studio edits, cloned into `out`. */
export const writeSource = Effect.fn('bolt.writeSource')(function* (root: string, out: string) {
	const fs = yield* FileSystem.FileSystem;
	yield* fs.remove(out, { recursive: true, force: true });
	// entry by entry: `out` lies inside `root` (under `.norbital/`), and cp refuses to copy a tree into itself
	for (const entry of yield* fs.readDirectory(root))
		if (!NOT_SOURCE.has(entry) && !TEST.test(entry))
			yield* cloneTree(
				join(root, entry),
				join(out, entry),
				(file) => !file.endsWith('.DS_Store') && !TEST.test(`${entry}/${file}`)
			);
	return yield* memoTreeHash(out);
});

/** `.norbital/release.json`: the digests that name the release's parts (`*.map` excluded, so a rebuild is byte-stable). */
export const ReleaseJson = Schema.Struct({
	format: Schema.Literal(1),
	handle: Schema.String,
	bundle: Schema.String,
	source: Schema.String,
	seed: Schema.Record(Schema.String, Schema.String)
});
export type ReleaseJson = typeof ReleaseJson.Type;
