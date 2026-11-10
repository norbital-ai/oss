/// <reference types="node" />
// The platform layer (§8, "Sharing package code in memory"): the browser code of Bolt's shell and page entries, ui,
// svelte, effect, std and the packages they pin, built with no workspace input at all. Every artifact on one Bolt
// release carries the same `assets/platform/**` byte for byte, so the CAS, a host's byte cache and a browser's cache
// hold one copy. A workspace's own build imports every module the layer exposes (an entry, its exports kept exactly)
// from there, and bundles only its own code and the packages it added.
import { createRequire } from 'node:module';
import { dirname, join, posix } from 'node:path';
import { Effect, FileSystem, Option, Schema } from 'effect';
import type { InlineConfig, Plugin, Rolldown } from 'vite';
import { EDITOR_SINGLETONS } from '../editor-dependencies.ts';
import { tree } from '@norbital-ai/bolt/artifact';
import { sha256Hex } from '@norbital-ai/store';
import { cachedSvelte } from './svelte-cache.ts';
import { BOLT, BOLT_PACKAGE, EXT } from '../bolt.ts';

export const SHELL = join(BOLT, 'shell');
const MOUNT = join(SHELL, `mount${EXT}`);
/** Where the layer's chunks sit in a client build, beside the workspace's own `assets/*`. */
export const PLATFORM = 'assets/platform';

/** Bolt's browser entries: the shell, `@norbital-ai/bolt` and its client subpaths. */
const ENTRIES = [
	'shell/mount',
	'index',
	'page/index',
	'page/integration',
	'decl/errors',
	'protocol/index'
];
/** Bare specifiers the layer exposes, resolved as the shell resolves them, else as ui does; one a release lacks is left out. */
const SPECIFIERS = [
	...['', '/layout', '/brand', '/capture', '/effect'].map((sub) => `@norbital-ai/ui${sub}`),
	...[
		'calendar',
		'csv',
		'date',
		'decimal',
		'formula',
		'json',
		'kind',
		'label',
		'sheet',
		'versioned',
		'wire',
		'zone'
	].map((sub) => `@norbital-ai/std/${sub}`),
	...[
		'',
		'/animate',
		'/attachments',
		'/easing',
		'/events',
		'/legacy',
		'/motion',
		'/reactivity',
		'/reactivity/window',
		'/store',
		'/transition',
		'/internal/client',
		'/internal/disclose-version',
		'/internal/flags/async',
		'/internal/flags/legacy',
		'/internal/flags/tracing'
	].map((sub) => `svelte${sub}`),
	'runed',
	'@iconify/svelte',
	'@internationalized/date',
	'marked',
	'fflate',
	...EDITOR_SINGLETONS
];

/** One svelte and one ui, the shell's: a package that would resolve its own copy reaches the shell's instead. */
export const shellRuntime = (id: string, importer: string | undefined) =>
	(id === 'svelte' ||
		id.startsWith('svelte/') ||
		id === '@norbital-ai/ui' ||
		id.startsWith('@norbital-ai/ui/')) &&
	importer !== undefined &&
	!importer.startsWith(SHELL);

const PlatformChunk = Schema.Struct({
	fileName: Schema.String,
	imports: Schema.Array(Schema.String),
	dynamicImports: Schema.Array(Schema.String)
});
export type PlatformChunk = typeof PlatformChunk.Type;
export type PlatformLayer = {
	/** A module the layer exposes, by its resolved id → the import a workspace chunk under `assets/` writes for it. */
	readonly modules: ReadonlyMap<string, string>;
	/** Every chunk of the layer by file name, for the workspace's initial module graph. */
	readonly chunks: ReadonlyMap<string, PlatformChunk>;
	readonly css: readonly string[];
};

const CachedPlatform = Schema.fromJsonString(
	Schema.Struct({
		key: Schema.String,
		modules: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
		chunks: Schema.Array(PlatformChunk),
		css: Schema.Array(Schema.String),
		/** Each file by its digest (`*.map` left out, as a tree's hash leaves it): a build hashes the layer unread. */
		digests: Schema.Array(Schema.Tuple([Schema.String, Schema.String]))
	})
);
const heldLayer = (held: typeof CachedPlatform.Type): PlatformLayer => ({
	modules: new Map(held.modules),
	chunks: new Map(held.chunks.map((chunk) => [chunk.fileName, chunk])),
	css: held.css
});
export type PreparedLayer = Readonly<{
	layer: PlatformLayer;
	digests: readonly (readonly [file: string, hex: string])[];
}>;
/**
 * A layer `bolt platform` wrote. A host holds one per package graph and mounts it read-only into every build on that
 * graph, so no build builds, copies or hashes it: the bundle a build leaves lacks `assets/platform/**` until its host
 * adds those files, and every digest already covers them (`layerLines`).
 */
export const preparedLayer = Effect.fn('bolt.preparedLayer')(function* (dir: string) {
	const fs = yield* FileSystem.FileSystem;
	const held = yield* fs
		.readFileString(join(dir, 'layer.json'))
		.pipe(Effect.flatMap(Schema.decodeUnknownEffect(CachedPlatform)));
	return { layer: heldLayer(held), digests: held.digests } satisfies PreparedLayer;
});
/** The prepared layer's `memoTreeHash` lines, for a tree holding the client at `at`. */
export const layerLines = (prepared: PreparedLayer | undefined, at: string) =>
	prepared?.digests.map(([file, hex]) => `${join(at, PLATFORM, file)}\0${hex}`) ?? [];

/** Private to the workspace: pages always build through their import boundary. */
export const cachedPlatformLayer = Effect.fn('bolt.cachedPlatformLayer')(function* <E, R>(
	cache: string,
	key: string,
	out: string,
	build: Effect.Effect<PlatformLayer, E, R>
) {
	const fs = yield* FileSystem.FileSystem;
	const metadata = join(cache, 'layer.json'),
		files = join(cache, 'files');
	const held = yield* fs
		.readFileString(metadata)
		.pipe(Effect.flatMap(Schema.decodeUnknownEffect(CachedPlatform)), Effect.option);
	if (Option.isSome(held) && held.value.key === key && (yield* fs.exists(files))) {
		yield* fs.copy(files, join(out, PLATFORM), { overwrite: true });
		return heldLayer(held.value);
	}
	const layer = yield* build;
	yield* fs.makeDirectory(cache, { recursive: true });
	// An interrupted refresh must not leave old metadata describing a partial copy.
	yield* fs.remove(metadata, { force: true });
	yield* fs.remove(files, { recursive: true, force: true });
	yield* fs.copy(join(out, PLATFORM), files);
	const digests: [string, string][] = [];
	for (const file of yield* tree(files))
		if (!file.endsWith('.map'))
			digests.push([file, sha256Hex(yield* fs.readFile(join(files, file)))]);
	const temporary = `${metadata}.${process.pid}`;
	yield* fs.writeFileString(
		temporary,
		Schema.encodeSync(CachedPlatform)({
			key,
			modules: [...layer.modules],
			chunks: [...layer.chunks.values()],
			css: [...layer.css],
			digests
		})
	);
	yield* fs.rename(temporary, metadata);
	return layer;
});

/**
 * The layer's build into `out` (emptied first): rooted at Bolt's own package, with no workspace env, PostCSS or
 * public directory, no defines and no Tailwind, so nothing of the building workspace or host reaches its bytes.
 */
export const platformConfig = Effect.fn('bolt.platformConfig')(function* (
	out: string,
	cache: string,
	specifiers: Map<string, string>
) {
	const fs = yield* FileSystem.FileSystem;
	// every core effect module is an entry: a module a workspace bundles itself (an `effect/http` or other
	// subdirectory page import) reaches effect's core through the layer, never through a second copy of it
	const effect = dirname(createRequire(import.meta.url).resolve('effect'));
	const modules = (yield* fs.readDirectory(effect, { recursive: true }))
		.filter((file) => file.endsWith('.js') && !/^(?!internal\/)[^/]+\//.test(file))
		.sort()
		.map((file) => join(effect, file));
	for (const id of modules) {
		const sub = posix.relative(effect, id).replace(/\.js$/, '');
		specifiers.set(sub === 'index' ? 'effect' : `effect/${sub}`, id);
	}
	const startup = new Set<string>();
	const entries: Plugin = {
		name: 'bolt:platform',
		enforce: 'pre',
		// repository-health:allow EFF3 -- Vite resolves through its Promise plugin ABI.
		async resolveId(id, importer) {
			return shellRuntime(id, importer) ? this.resolve(id, MOUNT, { skipSelf: true }) : null;
		},
		// repository-health:allow EFF3 -- Vite resolves through its Promise plugin ABI.
		async buildStart() {
			// a package this install lacks resolves to null and is left out of the layer (its importers bundle it)
			const find = (specifier: string, importer: string) => this.resolve(specifier, importer);
			const ui = await find('@norbital-ai/ui', MOUNT);
			const ids = new Set<string>();
			for (const specifier of SPECIFIERS) {
				const resolved =
					(await find(specifier, MOUNT)) ?? (ui === null ? null : await find(specifier, ui.id));
				if (resolved !== null && !resolved.external) {
					ids.add(resolved.id);
					specifiers.set(specifier, resolved.id);
				}
			}
			for (const id of [...ids].sort()) this.emitFile({ type: 'chunk', id });
		},
		buildEnd(error) {
			if (error) return;
			// Keep the shell's static dependency graph together, without pulling in feature chunks
			// or other platform entries. Keep the entry facades for workspace imports.
			const pending = [MOUNT];
			while (pending.length > 0) {
				const id = pending.pop();
				if (id === undefined || startup.has(id)) continue;
				const module = this.getModuleInfo(id);
				if (module === null) continue;
				startup.add(id);
				pending.push(...module.importedIds);
			}
		}
	};
	// an asset URL's placeholder names a per-build random reference id: kept as a sourcemap name, the layer's maps
	// would differ build to build
	const stableNames: Plugin = {
		name: 'bolt:platform-map-names',
		enforce: 'post',
		generateBundle(_, bundle) {
			for (const o of Object.values(bundle))
				if (o.type === 'asset' && o.fileName.endsWith('.map') && typeof o.source === 'string')
					o.source = o.source.replace(/import\.meta\.ROLLDOWN_FILE_URL_[\w$]+/g, 'import.meta.url');
		}
	};
	const config: InlineConfig = {
		configFile: false,
		logLevel: 'silent',
		root: yield* fs.realPath(BOLT_PACKAGE),
		base: './',
		envDir: false,
		publicDir: false,
		cacheDir: join(cache, 'vite'),
		css: { postcss: {} },
		plugins: [
			entries,
			stableNames,
			// a scoped class hashes the component's CSS, not its absolute path, which differs per install
			cachedSvelte(
				{
					configFile: false,
					compilerOptions: { cssHash: ({ hash, css }) => `svelte-${hash(css)}` }
				},
				join(cache, 'svelte')
			)
		],
		build: {
			outDir: out,
			emptyOutDir: true,
			assetsDir: PLATFORM,
			sourcemap: true,
			rolldownOptions: {
				input: [...ENTRIES.map((path) => join(BOLT, `${path}${EXT}`)), ...modules],
				preserveEntrySignatures: 'strict',
				output: {
					sourcemapExcludeSources: true,
					// Keep transfers short on lossy links, preserving module initialization across chunks.
					strictExecutionOrder: true,
					codeSplitting: {
						groups: [{ name: 'shell', test: (id) => startup.has(id), maxSize: 950_000 }]
					}
				}
			}
		}
	};
	return config;
});

/** What a workspace build reads of the layer's output. */
export const platformLayer = (
	built: Rolldown.RolldownOutput,
	specifiers: ReadonlyMap<string, string>
): PlatformLayer => {
	const chunks = built.output.filter((o): o is Rolldown.OutputChunk => o.type === 'chunk');
	const modules = new Map(
		chunks.flatMap((chunk) =>
			chunk.isEntry && chunk.facadeModuleId !== null
				? [[chunk.facadeModuleId, `./${posix.relative('assets', chunk.fileName)}`] as const]
				: []
		)
	);
	// Resolve bare imports before Vite's workspace-root dedupe can select a second runtime.
	for (const [specifier, resolved] of specifiers) {
		const shared = modules.get(resolved);
		if (shared !== undefined) modules.set(specifier, shared);
	}
	return {
		modules,
		chunks: new Map(chunks.map((chunk) => [chunk.fileName, chunk])),
		css: built.output
			.filter((o) => o.type === 'asset' && o.fileName.endsWith('.css'))
			.map((o) => o.fileName)
			.sort()
	};
};
