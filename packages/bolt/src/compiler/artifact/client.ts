/// <reference types="node" />
// The artifact's `client/**`: an internal SPA whose main-thread module graph initializes before admission, and a
// shared Vite/Svelte multi-entry graph for server-rendered public routes. Each public entry reaches its requested
// page, shared wrapper and codec; the internal shell, agent, Studio and session registry remain in the private SPA.
// There is no template Vite config (§3.2: `vite.config.ts` is deleted with no successor). Runtime assets live in the
// workspace `assets/` directory, which the artifact ships as `assets/**` and hosts serve at `/assets/*` after the
// client's own chunks; a page reaches a file there by that path, or imports one through Vite's `?url` / `?worker`,
// which this build fingerprints into `client/assets/`.
import { Effect, FileSystem, Schema, Result } from 'effect';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { build, type Rolldown } from 'vite';
import type { EngineManifest } from '../../engine/manifest.ts';
import type { ShellManifest } from '../../shell/nav.ts';
import type { Discovered } from '../discover.ts';
import { EDITOR_SINGLETONS } from '../editor-dependencies.ts';
import { clientImportBoundary } from './client-boundary.ts';
import { publicWrapper } from './public-wrapper.ts';

const SOURCE = dirname(fileURLToPath(import.meta.url));
const SHELL = join(SOURCE, '../../shell');
/** Source (`.ts`) in the checkout, emitted `.js` in the published package. */
const EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
const BOLT = join(SOURCE, `../../index${EXT}`);
const ENTRY = 'virtual:bolt-client';
const ViteManifest = Schema.Record(
	Schema.String,
	Schema.Struct({
		file: Schema.String,
		isEntry: Schema.optionalKey(Schema.Boolean),
		imports: Schema.optionalKey(Schema.Array(Schema.String)),
		css: Schema.optionalKey(Schema.Array(Schema.String))
	})
);
const key = JSON.stringify;
const escape = (text: string) =>
	text.replace(/[<&"]/g, (c) => (c === '<' ? '&lt;' : c === '&' ? '&amp;' : '&quot;'));
export class BuildError extends Schema.TaggedError<BuildError>()('BuildError', {
	cause: Schema.Defect()
}) {}
const version = Effect.fnUntraced(function* (pkg: string) {
	const fs = yield* FileSystem.FileSystem;
	const decoded = yield* fs
		.readFileString(pkg)
		.pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(
					Schema.fromJsonString(Schema.Struct({ version: Schema.optionalKey(Schema.String) }))
				)
			),
			Effect.result
		);
	return Result.isSuccess(decoded) ? (decoded.success.version ?? null) : null;
});

/** ui's brand icons, copied beside the client's chunks under names a workspace's own `assets/` does not take. */
const ICONS = {
	'bolt-favicon.ico': 'favicon.ico',
	'bolt-favicon-32.png': 'favicon-32x32.png',
	'bolt-apple-icon.png': 'apple-icon.png'
} as const;
/**
 * The document every non-`/__bolt` path answers with. Staging's head: the brand icons, the light/dark theme colour, an
 * edge-to-edge viewport and the home-screen app meta, and the viewer's theme (`bolt.theme`, else the system's) applied
 * before paint, so a dark page never flashes light (`shell/theme.ts` keeps it after).
 */
const document = (
	title: string,
	entry: string,
	css: readonly string[],
	modules: readonly string[],
	accessStyles: string
) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="theme-color" content="#f7f6f2" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#191815" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="${escape(title)}">
<title>${escape(title)}</title>
<link rel="icon" href="/assets/bolt-favicon.ico" sizes="any">
<link rel="icon" type="image/png" href="/assets/bolt-favicon-32.png">
<link rel="apple-touch-icon" href="/assets/bolt-apple-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<script>(function(){var t;try{t=localStorage.getItem('bolt.theme')}catch(e){}var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.classList.add('dark');document.documentElement.style.colorScheme=d?'dark':'light'})()</script>
<style>
body{margin:0}
${accessStyles}
#bolt-loading{position:fixed;inset:0;z-index:1;overflow:auto}
</style>
${css.map((c) => `<link rel="stylesheet" href="/${c}">`).join('\n')}
<script type="application/json" id="bolt-initial-modules">${key({ modules, css }).replaceAll('<', '\\u003c')}</script>
<script type="module" src="/${entry}"></script>
</head>
<body><div id="bolt"></div><div id="bolt-loading" role="status" aria-live="polite" aria-busy="true" class="access-frame"><main class="access-loading-content"><div class="access-loading-cluster"><img class="access-loading-mark" src="/assets/bolt-apple-icon.png" alt=""><h1 class="access-loading-name">${escape(title)}</h1><p class="access-loading-status">Opening workspace…</p><div class="access-loading-track" aria-hidden="true"></div></div></main></div></body>
</html>
`;

/** Builds `<out>/index.html` and `<out>/assets/**`; returns the entry chunk and stylesheets. */
export const buildClient = Effect.fn('bolt.buildClient')(function* (
	root: string,
	files: readonly Discovered[],
	m: EngineManifest,
	out: string,
	title: string
) {
	const fs = yield* FileSystem.FileSystem;
	const sourceRoot = yield* fs.realPath(root);
	const publicFiles = files.filter((file) => {
		if (file.role !== 'page' && file.role !== 'kiosk_page') return false;
		const owner = file.name.slice(0, file.name.lastIndexOf('/'));
		return (
			(file.role === 'page'
				? (m.apps[owner]?.audience ?? 'members')
				: (m.kiosks?.[owner]?.auth ?? 'members')) !== 'members'
		);
	});
	const pages = [
		...files
			.filter((f) => f.role === 'page')
			.map((f) => `${key(f.name)}: () => import(${key(join(root, f.path))})`),
		...files
			.filter((f) => f.role === 'kiosk_page')
			.map((f) => `${key(`kiosk/${f.name}`)}: () => import(${key(join(root, f.path))})`)
	];
	const sessions = files.filter((f) => f.role === 'session');
	const shell: ShellManifest = {
		workspace: m.workspace,
		apps: m.apps,
		kiosks: m.kiosks ?? {},
		groups: m.groups ?? {}
	};
	// hook:ui-kit — the client stylesheet: ui's tokens + Tailwind, scanning the shell and the workspace's pages
	// generated inputs sit at a fixed path under the workspace, so a rebuild is byte for byte the same
	const gen = join(root, '.norbital', 'cache', 'client'),
		styles = join(gen, 'client.css');
	yield* fs.makeDirectory(gen, { recursive: true });
	yield* fs.writeFileString(
		styles,
		`@import ${key(createRequire(import.meta.url).resolve('@norbital-ai/ui/base.css'))};\n@source ${key(SHELL)};\n@source ${key(root)};\n`
	);
	// hook:server-cli — the messages: the base (`+messages.ts`) under the reader's first matching `+<locale>.messages.ts`
	const reps = files
		.filter((f) => f.role === 'representation')
		.map((f) => `${key(f.name)}: () => import(${key(join(root, f.path))})`);
	const integrationSetups = files
		.filter((f) => f.role === 'integration_setup')
		.map((f) => `${key(f.name)}: { load: () => import(${key(join(root, f.path))}) }`);
	// custom fields: the manifest's shape, and the renderer (imported with the entry: display grids render it synchronously)
	const renderers = files.filter((f) => f.role === 'renderer');
	const customFields = Object.entries(m.customFields).map(([name, spec]) => {
		const r = renderers.findIndex((f) => f.name === name);
		return `${key(name)}: { shape: ${key(spec.shape)}${typeof spec.label === 'string' ? `, label: ${key(spec.label)}` : ''}${r < 0 ? '' : `, renderer: F${r}`} }`;
	});
	const base = files.find((f) => f.role === 'messages'),
		locales = files.filter((f) => f.role === 'locale');
	const entry = `import ${key(styles)};
import { initializeShellAssets, mountShell } from ${key(join(SHELL, `mount${EXT}`))};
${base === undefined ? 'const base = {};' : `import base from ${key(join(root, base.path))};`}
${locales.map((l, i) => `import L${i} from ${key(join(root, l.path))};`).join('\n')}
${sessions.map((s, i) => `import S${i} from ${key(join(root, s.path))};`).join('\n')}
${renderers.map((r, i) => `import F${i} from ${key(join(root, r.path))};`).join('\n')}
const locales = { ${locales.map((l, i) => `${key(l.name.toLowerCase())}: L${i}`).join(', ')} };
const tag = navigator.languages.map((l) => l.toLowerCase()).flatMap((l) => [l, l.split('-')[0]]).find((l) => l in locales);
const ready = initializeShellAssets(import.meta.url);
ready.then(() => mountShell(document.getElementById('bolt'), { ready, workspaceName: ${key(title)}, publicRoutes: ${key(publicFiles.map((file) => `${file.role === 'page' ? 'app' : 'kiosk'}/${file.name}`))}, manifest: ${key(shell)}, pages: { ${pages.join(', ')} },
	sessions: { ${sessions.map((s, i) => `${key(s.name)}: S${i}`).join(', ')} },
	messages: { ...base, ...(tag === undefined ? {} : locales[tag]) },
	integrationSetups: { ${integrationSetups.join(', ')} }, representations: { ${reps.join(', ')} }, customFields: { ${customFields.join(', ')} } })).catch((cause) => {
	const status = document.querySelector('#bolt-loading p');
	if (status !== null) { status.textContent = 'The workspace could not finish loading. Reload to try again.'; status.setAttribute('role', 'alert'); }
	console.error(cause);
});`;
	const versions = {
		workspace: yield* version(join(root, 'package.json')),
		bolt: yield* version(join(SOURCE, '../../../package.json')),
		node: process.versions.node
	};
	const compile = Effect.fn('bolt.buildClient.bundle')(function* (
		source: string | Record<string, string>,
		destination: string,
		publicPage: boolean
	) {
		const built = yield* Effect.tryPromise({
			try: () =>
				build({
					// relative: chunks and assets resolve from their importer, so the host may serve the workspace under a path
					configFile: false,
					logLevel: 'silent',
					root,
					base: './',
					// hook:shell — the account menu's versions (L-BOLT-073): the workspace's, this Bolt's and the building Node's
					define: { __BOLT_BUILD__: key(versions) },
					// `$bolt` is resolved below, not aliased: rolldown reads `$bolt` in a regex alias's replacement as a capture group
					resolve: {
						dedupe: EDITOR_SINGLETONS,
						alias: [{ find: /^@norbital-ai\/bolt$/, replacement: BOLT }]
					},
					plugins: [
						clientImportBoundary(root, files),
						{
							name: 'bolt:client',
							enforce: 'pre',
							// repository-health:allow EFF3 -- Vite resolves through its Promise plugin ABI.
							async resolveId(id, importer) {
								if (id === ENTRY) return `\0${id}`;
								if (id === '$bolt' || (publicPage && id === '@norbital-ai/bolt/page'))
									return publicPage
										? join(SHELL, 'public', `client${EXT}`)
										: join(SOURCE, '../../page', `index${EXT}`);
								// one Svelte runtime: the shell's
								if (
									(id === 'svelte' || id.startsWith('svelte/')) &&
									importer !== undefined &&
									!importer.startsWith(SHELL)
								)
									return this.resolve(id, join(SHELL, `mount${EXT}`), { skipSelf: true });
								// one ui: pages and the record view reach ui as the shell does, so its contexts (`$bolt`, kinds) are the shell's
								if (
									(id === '@norbital-ai/ui' || id.startsWith('@norbital-ai/ui/')) &&
									importer !== undefined &&
									!importer.startsWith(SHELL)
								)
									return this.resolve(id, join(SHELL, `mount${EXT}`), { skipSelf: true });
								return null;
							},
							load: (id) => (id === `\0${ENTRY}` && typeof source === 'string' ? source : null)
						},
						svelte({ configFile: false }),
						tailwindcss()
					],
					// maps name their sources but carry none: an asset's placeholder id in a source's text follows emission order, so an
					// embedded source made two builds of one workspace differ (the artifact is byte for byte)
					build: {
						outDir: destination,
						emptyOutDir: true,
						sourcemap: true,
						...(publicPage ? { manifest: true, cssCodeSplit: true } : {}),
						rolldownOptions: {
							input: typeof source === 'string' ? { shell: ENTRY } : source,
							output: { entryFileNames: 'assets/[name]-[hash].js', sourcemapExcludeSources: true }
						}
					}
				}),
			catch: (cause) => new BuildError({ cause })
		});
		const result = Array.isArray(built) ? built[0] : built;
		if (result === undefined || 'close' in result)
			return yield* Effect.fail(
				new BuildError({ cause: new Error('the client bundler returned no output') })
			);
		const chunk = result.output.find(
			(o): o is Rolldown.OutputChunk => o.type === 'chunk' && o.isEntry
		);
		if (chunk === undefined)
			return yield* Effect.fail(
				new BuildError({ cause: new Error('the client bundler emitted no entry') })
			);
		const css = result.output
			.filter((o) => o.type === 'asset' && o.fileName.endsWith('.css'))
			.map((o) => o.fileName)
			.sort();
		const chunks = new Map(
			result.output
				.filter((item): item is Rolldown.OutputChunk => item.type === 'chunk')
				.map((item) => [item.fileName, item])
		);
		/** Every chunk `entry` reaches through static and dynamic imports, itself included. */
		const reach = (entry: string) => {
			const reached = new Set<string>();
			const visit = (name: string): void => {
				if (reached.has(name)) return;
				const item = chunks.get(name);
				if (item === undefined) return;
				reached.add(name);
				for (const imported of [...item.imports, ...item.dynamicImports]) visit(imported);
			};
			visit(entry);
			return reached;
		};
		const initialized = reach(chunk.fileName);
		initialized.delete(chunk.fileName);
		const sourcesFor = (entry: string) => {
			const reached = reach(entry);
			return [
				...new Set(
					[...reached]
						.flatMap((name) => {
							const chunk = chunks.get(name);
							return chunk === undefined ? [] : Object.entries(chunk.modules);
						})
						.filter(([, module]) => module.renderedLength > 0)
						.map(([id]) => id.split('?', 1)[0] ?? '')
						.filter(
							(id) =>
								isAbsolute(id) &&
								(id.startsWith(`${sourceRoot}/`) || id.startsWith(SHELL)) &&
								/\.(?:svelte|[cm]?[jt]sx?)$/.test(id)
						)
				)
			].sort();
		};
		const manifest: typeof ViteManifest.Type = publicPage
			? yield* fs.readFileString(join(destination, '.vite', 'manifest.json')).pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ViteManifest))),
					Effect.mapError((cause) => new BuildError({ cause }))
				)
			: {};
		return {
			entry: chunk.fileName,
			css,
			modules: [...initialized].sort(),
			chunks,
			sourcesFor,
			manifest
		};
	});
	const publicEntry = Effect.fnUntraced(function* (
		bundle: Effect.Success<ReturnType<typeof compile>>,
		route: string
	) {
		const entries = [...bundle.chunks.values()].filter((chunk) => chunk.isEntry);
		const matches = entries.filter((chunk) => chunk.name === route);
		const chunk = matches[0];
		if (matches.length !== 1 || chunk === undefined)
			return yield* new BuildError({
				cause: new Error(
					`Public page ${route} has no unique Vite input entry: ${key(entries.slice(0, 20).map(({ name, fileName, facadeModuleId }) => ({ name, fileName, facadeModuleId })))}`
				)
			});
		// Vite owns manifest keys (which can reflect canonical path aliases); the emitted filename is authoritative.
		const projections = Object.entries(bundle.manifest).filter(
			([, page]) => page.isEntry === true && page.file === chunk.fileName
		);
		const projection = projections[0];
		if (projections.length !== 1 || projection === undefined)
			return yield* new BuildError({
				cause: new Error(
					`Public page ${route} has no unique Vite manifest entry for ${chunk.fileName}: ${key(
						Object.entries(bundle.manifest)
							.slice(0, 20)
							.map(([name, page]) => ({ name, file: page.file, isEntry: page.isEntry }))
					)}`
				)
			});
		return { chunk, name: projection[0], page: projection[1] };
	});
	const internal = yield* compile(entry, out, false);
	const require = createRequire(import.meta.url);
	for (const [name, source] of Object.entries(ICONS))
		yield* fs.copyFile(
			require.resolve(`@norbital-ai/ui/assets/favicon/${source}`),
			join(out, 'assets', name)
		);
	// the workspace's own `assets/**` (app banners, kiosk models, media) served at `/assets/<path>`, beside the shell's chunks
	if (yield* fs.exists(join(root, 'assets')))
		yield* fs.copy(join(root, 'assets'), join(out, 'assets'), { overwrite: true });
	yield* fs.writeFileString(
		join(out, 'index.html'),
		document(
			title,
			internal.entry,
			internal.css,
			internal.modules,
			yield* fs.readFileString(require.resolve('@norbital-ai/ui/brand/access.css'))
		)
	);
	const publicPages: Record<string, { entry: string; css: string[] }> = {};
	const publicEntries: Record<string, string> = {};
	const publicStylesheets = new Map<string, string>();
	for (const file of publicFiles) {
		const role = file.role === 'page' ? 'page_server' : 'kiosk_page_server';
		if (!files.some((candidate) => candidate.role === role && candidate.name === file.name))
			return yield* new BuildError({
				cause: new Error(`Public page ${file.path} requires a server loader and shared data codec.`)
			});
		const route = `${file.role === 'page' ? 'app' : 'kiosk'}/${file.name}`;
		const publicStyles = join(gen, `${encodeURIComponent(route)}.css`);
		yield* fs.writeFileString(
			publicStyles,
			`@import ${key(require.resolve('@norbital-ai/ui/base.css'))};\n@source ${key(join(root, file.path))};\n@source ${key(join(SHELL, 'public', 'PublicPage.svelte'))};\n`
		);
		const codec = join(root, file.path.replace(/\+([^/]+)\.page\.svelte$/, '$1.page.data.ts'));
		const wrapper = yield* publicWrapper(root, file);
		const browser = join(gen, 'public', `${route}.ts`);
		yield* fs.makeDirectory(dirname(browser), { recursive: true });
		yield* fs.writeFileString(
			browser,
			`import ${key(publicStyles)};
import { Effect } from 'effect';
import Page from ${key(wrapper)};
import codec from ${key(codec)};
import { hydratePublicPage } from ${key(join(SHELL, 'public', `client${EXT}`))};
Effect.runPromise(hydratePublicPage(Page, codec, ${key(route)})).catch((cause) => {
	console.error('Public page could not hydrate', cause);
	const status = document.createElement('p'); status.setAttribute('role', 'alert'); status.textContent = 'This page could not become interactive. Reload to try again.'; document.getElementById('bolt')?.append(status);
});`
		);
		publicEntries[route] = browser;
		publicStylesheets.set(route, publicStyles);
	}
	if (publicFiles.length > 0) {
		// Two whole-public-graph passes retain transitive Tailwind discovery without rebuilding each route separately.
		const destination = join(out, 'public');
		const discovered = yield* compile(publicEntries, destination, true);
		for (const route of Object.keys(publicEntries)) {
			const { chunk } = yield* publicEntry(discovered, route);
			const styles = publicStylesheets.get(route);
			if (styles === undefined)
				return yield* new BuildError({
					cause: new Error(`Public page ${route} has no generated stylesheet`)
				});
			yield* fs.writeFileString(
				styles,
				`@import ${key(require.resolve('@norbital-ai/ui/base.css'))};\n${discovered
					.sourcesFor(chunk.fileName)
					.map((path) => `@source ${key(path)};`)
					.join('\n')}\n`
			);
		}
		const built = yield* compile(publicEntries, destination, true);
		for (const route of Object.keys(publicEntries)) {
			const { name, page } = yield* publicEntry(built, route);
			const seen = new Set<string>(),
				css = new Set<string>();
			let missing: string | undefined;
			// Match Vite's static import CSS order; Vite's preload helper owns dynamically imported JS and CSS.
			const collect = (name: string): void => {
				if (seen.has(name)) return;
				seen.add(name);
				const chunk = built.manifest[name];
				if (chunk === undefined) {
					missing = name;
					return;
				}
				for (const imported of chunk.imports ?? []) collect(imported);
				for (const file of chunk.css ?? []) css.add(`public/${file}`);
			};
			collect(name);
			if (missing !== undefined)
				return yield* new BuildError({
					cause: new Error(`Public page ${route} has an incomplete Vite manifest: ${missing}`)
				});
			const assets = { entry: `public/${page.file}`, css: [...css] };
			publicPages[route] = assets;
			const prefix = `public/${route}`;
			yield* fs.makeDirectory(join(out, prefix), { recursive: true });
			yield* fs.writeFileString(
				join(out, prefix, 'index.html'),
				`<!doctype html>
<html lang="__BOLT_PUBLIC_LOCALE__"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="bolt-release" content="__BOLT_PUBLIC_RELEASE__"><title>${escape(title)}</title>
${assets.css.map((css) => `<link rel="stylesheet" href="/${css}">`).join('\n')}
<!--bolt-public-head--><script type="module" src="/${assets.entry}"></script></head><body><div id="bolt"><!--bolt-public-body--></div><script type="application/json" id="bolt-public-hydration">__BOLT_PUBLIC_HYDRATION__</script></body></html>`
			);
		}
	}
	return { entry: internal.entry, css: internal.css, pages: publicPages };
});
