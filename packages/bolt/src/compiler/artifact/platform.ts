/// <reference types="node" />
// The platform layer (§8, "Sharing package code in memory"): the browser code of Bolt's shell and page entries, ui,
// svelte, effect, std and the packages they pin, built with no workspace input at all. Every artifact on one Bolt
// release carries the same `assets/platform/**` byte for byte, so the CAS, a host's byte cache and a browser's cache
// hold one copy. A workspace's own build imports every module the layer exposes (an entry, its exports kept exactly)
// from there, and bundles only its own code and the packages it added.
import { createRequire } from 'node:module';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect, FileSystem } from 'effect';
import type { InlineConfig, Plugin, Rolldown } from 'vite';
import { EDITOR_SINGLETONS } from '../editor-dependencies.ts';
import { cachedSvelte } from './svelte-cache.ts';

const SOURCE = dirname(fileURLToPath(import.meta.url));
/** Source (`.ts`) in the checkout, emitted `.js` in the published package. */
const EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
export const SHELL = join(SOURCE, '../../shell');
const MOUNT = join(SHELL, `mount${EXT}`);
/** Where the layer's chunks sit in a client build, beside the workspace's own `assets/*`. */
export const PLATFORM = 'assets/platform';

/** Bolt's browser entries: the shell, `@norbital-ai/bolt` (and `$bolt`'s page module) and its client subpaths. */
const BOLT = [
	'shell/mount',
	'index',
	'page/index',
	'page/integration',
	'decl/errors',
	'protocol/cursor'
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

export type PlatformLayer = {
	/** A module the layer exposes, by its resolved id → the import a workspace chunk under `assets/` writes for it. */
	readonly modules: ReadonlyMap<string, string>;
	/** Every chunk of the layer by file name, for the workspace's initial module graph. */
	readonly chunks: ReadonlyMap<string, Rolldown.OutputChunk>;
	readonly css: readonly string[];
};

/**
 * The layer's build into `out` (emptied first): rooted at Bolt's own package, with no workspace env, PostCSS or
 * public directory, no defines and no Tailwind, so nothing of the building workspace or host reaches its bytes.
 */
export const platformConfig = Effect.fn('bolt.platformConfig')(function* (
	out: string,
	cache: string
) {
	const fs = yield* FileSystem.FileSystem;
	// every effect module is an entry: a module a workspace bundles itself (an `effect/unstable/*` page import) reaches
	// effect's core through the layer, never through a second copy of it
	const effect = dirname(createRequire(import.meta.url).resolve('effect'));
	const modules = (yield* fs.readDirectory(effect, { recursive: true }))
		.filter((file) => file.endsWith('.js') && !/^(?:unstable|testing)\//.test(file))
		.sort()
		.map((file) => join(effect, file));
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
				if (resolved !== null && !resolved.external) ids.add(resolved.id);
			}
			for (const id of [...ids].sort()) this.emitFile({ type: 'chunk', id });
		}
	};
	const config: InlineConfig = {
		configFile: false,
		logLevel: 'silent',
		root: yield* fs.realPath(join(SOURCE, '../../..')),
		base: './',
		envDir: false,
		publicDir: false,
		cacheDir: join(cache, 'vite'),
		css: { postcss: {} },
		plugins: [
			entries,
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
				input: [...BOLT.map((path) => join(SOURCE, '../..', `${path}${EXT}`)), ...modules],
				preserveEntrySignatures: 'strict',
				output: { sourcemapExcludeSources: true }
			}
		}
	};
	return config;
});

/** What a workspace build reads of the layer's output. */
export const platformLayer = (built: Rolldown.RolldownOutput): PlatformLayer => {
	const chunks = built.output.filter((o): o is Rolldown.OutputChunk => o.type === 'chunk');
	return {
		modules: new Map(
			chunks.flatMap((chunk) =>
				chunk.isEntry && chunk.facadeModuleId !== null
					? [[chunk.facadeModuleId, `./${posix.relative('assets', chunk.fileName)}`] as const]
					: []
			)
		),
		chunks: new Map(chunks.map((chunk) => [chunk.fileName, chunk])),
		css: built.output
			.filter((o) => o.type === 'asset' && o.fileName.endsWith('.css'))
			.map((o) => o.fileName)
			.sort()
	};
};
