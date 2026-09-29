/// <reference types="node" />
// The artifact's `client/**` (§2.3 decision 2): one Vite + Svelte build of the workspace shell with a lazy chunk per page,
// carrying its own Svelte, ui, std and bolt client code. `$bolt` is the booted shell client (§3.5); every `svelte` import
// resolves to the shell's own copy, so pages and the shell share one runtime.
// There is no template Vite config (§3.2: `vite.config.ts` is deleted with no successor). Runtime assets live in the
// workspace `assets/` directory, which the artifact ships as `assets/**` and hosts serve at `/assets/*` after the
// client's own chunks; a page reaches a file there by that path, or imports one through Vite's `?url` / `?worker`,
// which this build fingerprints into `client/assets/`.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { build, type Rollup } from 'vite';
import type { EngineManifest } from '../../engine/contracts.ts';
import type { Discovered } from '../discover.ts';

const SHELL = fileURLToPath(new URL('../../shell/', import.meta.url));
/** Source (`.ts`) in the checkout, emitted `.js` in the published package. */
const EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
const BOLT = fileURLToPath(new URL(`../../index${EXT}`, import.meta.url));
const ENTRY = 'virtual:bolt-client';
const key = JSON.stringify;
const escape = (text: string) => text.replace(/[<&"]/g, (c) => (c === '<' ? '&lt;' : c === '&' ? '&amp;' : '&quot;'));
const version = (pkg: string | URL): string | null => { try { return (JSON.parse(readFileSync(pkg, 'utf8')) as { version?: string }).version ?? null; } catch { return null; } };

/** ui's brand icons, copied beside the client's chunks under names a workspace's own `assets/` does not take. */
const ICONS = { 'bolt-favicon.ico': 'favicon.ico', 'bolt-favicon-32.png': 'favicon-32x32.png', 'bolt-apple-icon.png': 'apple-icon.png' } as const;
/**
 * The document every non-`/__bolt` path answers with. Staging's head: the brand icons, the light/dark theme colour, an
 * edge-to-edge viewport and the home-screen app meta, and the viewer's theme (`bolt.theme`, else the system's) applied
 * before paint, so a dark page never flashes light (`shell/theme.ts` keeps it after).
 */
const document = (title: string, entry: string, css: readonly string[]) => `<!doctype html>
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
#bolt-loading{position:fixed;inset:0;z-index:1;display:grid;place-items:center;background:var(--background,#f2f1ed);color:var(--foreground,#26251e);font:500 .875rem Geist,system-ui,sans-serif}
.dark #bolt-loading{background:var(--background,#191815);color:var(--foreground,#f7f7f4)}
#bolt-loading-content{display:flex;flex-direction:column;align-items:center;gap:1rem}
#bolt-loading img{width:2.75rem;height:2.75rem;border-radius:.5rem}
#bolt-loading p{margin:0;opacity:.7}
#bolt-loading-track{width:8rem;height:2px;overflow:hidden;background:rgba(127,127,127,.25)}
#bolt-loading-track::after{content:"";display:block;width:40%;height:100%;background:var(--brand-500,#e87432);animation:bolt-opening 1.3s ease-in-out infinite alternate}
@keyframes bolt-opening{from{transform:translateX(-100%)}to{transform:translateX(250%)}}
@media(prefers-reduced-motion:reduce){#bolt-loading-track::after{animation:none;transform:translateX(75%)}}
</style>
${css.map((c) => `<link rel="stylesheet" href="/${c}">`).join('\n')}
<script type="module" src="/${entry}"></script>
</head>
<body><div id="bolt"></div><div id="bolt-loading" role="status" aria-live="polite"><div id="bolt-loading-content"><img src="/assets/bolt-apple-icon.png" alt=""><strong>Norbital</strong><p>Opening workspace…</p><div id="bolt-loading-track" aria-hidden="true"></div></div></div></body>
</html>
`;

/** Builds `<out>/index.html` and `<out>/assets/**`; returns the entry chunk and stylesheets. */
export async function buildClient(root: string, files: readonly Discovered[], m: EngineManifest, out: string, title: string): Promise<{ entry: string; css: string[] }> {
	const pages = files.filter((f) => f.role === 'page').map((f) => `${key(f.name)}: () => import(${key(join(root, f.path))})`);
	const shell = { workspace: m.workspace, agent: m.agent, apps: m.apps, groups: m.groups ?? {} };
	// hook:ui-kit — the client stylesheet: ui's tokens + Tailwind, scanning the shell and the workspace's pages
	// generated inputs sit at a fixed path under the workspace, so a rebuild is byte for byte the same
	const gen = join(root, '.norbital', 'cache', 'client'), styles = join(gen, 'client.css');
	mkdirSync(gen, { recursive: true });
	writeFileSync(styles, `@import ${key(createRequire(import.meta.url).resolve('@norbital-ai/ui/base.css'))};\n@source ${key(SHELL)};\n@source ${key(root)};\n`);
	// hook:server-cli — the messages: the base (`+messages.ts`) under the reader's first matching `+<locale>.messages.ts`
	const reps = files.filter((f) => f.role === 'representation').map((f) => `${key(f.name)}: () => import(${key(join(root, f.path))})`);
	// a channel's connection UI (`+*.connect.svelte`), the same lazy map: a provider bolt ships and one the workspace
	// writes are both an entry here, and the shell cannot tell which it loaded
	const connects = files.filter((f) => f.role === 'connect').map((f) => `${key(f.name)}: () => import(${key(join(root, f.path))})`);
	// custom fields: the manifest's shape, and the renderer (imported with the entry: display grids render it synchronously)
	const renderers = files.filter((f) => f.role === 'renderer');
	const customFields = Object.entries(m.customFields).map(([name, spec]) => {
		const r = renderers.findIndex((f) => f.name === name);
		const s = spec as { shape: unknown; label?: unknown };
		return `${key(name)}: { shape: ${key(s.shape)}${typeof s.label === 'string' ? `, label: ${key(s.label)}` : ''}${r < 0 ? '' : `, renderer: F${r}`} }`;
	});
	const base = files.find((f) => f.role === 'messages'), locales = files.filter((f) => f.role === 'locale');
	const entry = `import ${key(styles)};
import { mountShell } from ${key(join(SHELL, `mount${EXT}`))};
${base === undefined ? 'const base = {};' : `import base from ${key(join(root, base.path))};`}
${locales.map((l, i) => `import L${i} from ${key(join(root, l.path))};`).join('\n')}
${renderers.map((r, i) => `import F${i} from ${key(join(root, r.path))};`).join('\n')}
const locales = { ${locales.map((l, i) => `${key(l.name.toLowerCase())}: L${i}`).join(', ')} };
const tag = navigator.languages.map((l) => l.toLowerCase()).flatMap((l) => [l, l.split('-')[0]]).find((l) => l in locales);
mountShell(document.getElementById('bolt'), { manifest: ${key(shell)}, pages: { ${pages.join(', ')} },
	messages: { ...base, ...(tag === undefined ? {} : locales[tag]) },
	representations: { ${reps.join(', ')} }, connects: { ${connects.join(', ')} }, customFields: { ${customFields.join(', ')} } });`;
	const result = await build({
		// relative: chunks and assets resolve from their importer, so the host may serve the workspace under a path
		configFile: false, logLevel: 'silent', root, base: './',
		// hook:shell — the account menu's versions (L-BOLT-073): the workspace's, this Bolt's and the building Node's
		define: { __BOLT_BUILD__: key({ workspace: version(join(root, 'package.json')), bolt: version(new URL('../../../package.json', import.meta.url)), node: process.versions.node }) },
		// `$bolt` is resolved below, not aliased: rolldown reads `$bolt` in a regex alias's replacement as a capture group
		resolve: { alias: [{ find: /^@norbital-ai\/bolt$/, replacement: BOLT }] },
		plugins: [
			{
				name: 'bolt:client', enforce: 'pre',
				async resolveId(id, importer) {
					if (id === ENTRY) return `\0${id}`;
					if (id === '$bolt') return fileURLToPath(new URL(`../../client/index${EXT}`, import.meta.url));
					// one Svelte runtime: the shell's
					if ((id === 'svelte' || id.startsWith('svelte/')) && importer !== undefined && !importer.startsWith(SHELL))
						return this.resolve(id, join(SHELL, `mount${EXT}`), { skipSelf: true });
					// one ui: pages and the record view reach ui as the shell does, so its contexts (`$bolt`, kinds) are the shell's
					if ((id === '@norbital-ai/ui' || id.startsWith('@norbital-ai/ui/')) && importer !== undefined && !importer.startsWith(SHELL)) return this.resolve(id, join(SHELL, `mount${EXT}`), { skipSelf: true });
					return null;
				},
				load: (id) => id === `\0${ENTRY}` ? entry : null,
			},
			svelte({ configFile: false }),
			tailwindcss(),
		],
		// maps name their sources but carry none: an asset's placeholder id in a source's text follows emission order, so an
		// embedded source made two builds of one workspace differ (the artifact is byte for byte)
		build: { outDir: out, emptyOutDir: true, sourcemap: true, rollupOptions: { input: { shell: ENTRY }, output: { entryFileNames: 'assets/[name]-[hash].js', sourcemapExcludeSources: true } } },
	}) as Rollup.RollupOutput;
	const chunk = result.output.find((o): o is Rollup.OutputChunk => o.type === 'chunk' && o.isEntry)!;
	const css = result.output.filter((o) => o.type === 'asset' && o.fileName.endsWith('.css')).map((o) => o.fileName).sort();
	const require = createRequire(import.meta.url);
	for (const [name, source] of Object.entries(ICONS)) copyFileSync(require.resolve(`@norbital-ai/ui/assets/favicon/${source}`), join(out, 'assets', name));
	// the workspace's own `assets/**` (app banners, kiosk models, media) served at `/assets/<path>`, beside the shell's chunks
	if (existsSync(join(root, 'assets'))) cpSync(join(root, 'assets'), join(out, 'assets'), { recursive: true });
	writeFileSync(join(out, 'index.html'), document(title, chunk.fileName, css));
	return { entry: chunk.fileName, css };
}
