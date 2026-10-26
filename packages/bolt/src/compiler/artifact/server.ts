/// <reference types="node" />
// Public pages execute their loader and synchronous Svelte renderer inside one ordinary bounded guest invocation.
// The emitted programs stay outside client/**; neither a loader nor its imports enter a browser bundle.
import { builtinModules } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect, FileSystem } from 'effect';
import { cachedSvelte } from './svelte-cache.ts';
import { build, type Rolldown } from 'vite';
import type { EngineManifest } from '../../engine/manifest.ts';
import { publicPageKeys } from '../../engine/artifact/read.ts';
import { sha256Hex } from '@norbital-ai/store';
import type { Discovered } from '../discover.ts';
import { BuildError } from './client.ts';
import { publicWrapper } from './public-wrapper.ts';

const EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SHELL = join(SOURCE, 'shell');
const ENTRY = 'virtual:bolt-server-page';
const BYTES = '\0bolt-page-bytes:';
const NODE = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const SCRIPT = /\.[cm]?[jt]sx?$/;
const GENERATOR = /\bfunction\s*\*|[{,]\s*\*\s*[\w$]+\s*\(/;
const key = JSON.stringify;
const edge = join(SOURCE, 'decl', 'runtime', `guest${EXT}`);

/** Compiles each public route in isolation, retaining only that component and its server loader's dependencies. */
export const buildServerPages = Effect.fn('bolt.buildServerPages')(function* (
	directory: string,
	files: readonly Discovered[],
	m: EngineManifest,
	out: string
) {
	const fs = yield* FileSystem.FileSystem;
	const root = yield* fs.realPath(directory);
	const routes = publicPageKeys(m);
	const pages: Record<string, { file: string; sha256: string }> = {};
	if (routes.length === 0) return pages;
	const base = files.find((file) => file.role === 'messages');
	const locales = files.filter((file) => file.role === 'locale');
	for (const route of routes) {
		const kiosk = route.startsWith('kiosk/');
		const name = route.slice(kiosk ? 'kiosk/'.length : 'app/'.length);
		const component = files.find(
			(file) => file.role === (kiosk ? 'kiosk_page' : 'page') && file.name === name
		);
		const server = files.find(
			(file) => file.role === (kiosk ? 'kiosk_page_server' : 'page_server') && file.name === name
		);
		if (component === undefined || server === undefined)
			return yield* new BuildError({
				cause: new Error(`Public page ${route} requires its component and +page.server.ts loader`)
			});
		const codec = join(
			root,
			dirname(component.path),
			`${name.slice(name.lastIndexOf('/') + 1)}.page.data.ts`
		);
		if (!(yield* fs.exists(codec)))
			return yield* new BuildError({ cause: new Error(`Public page ${route} requires ${codec}`) });
		const wrapper = yield* publicWrapper(root, component);
		const entry = `import { install } from ${key(edge)};
import { attached } from ${key(join(SOURCE, 'decl', `body${EXT}`))};
import { Schema } from 'effect';
import { render } from 'svelte/server';
import { frameworkText } from ${key(join(SHELL, `i18n${EXT}`))};
import Page from ${key(wrapper)};
import definition from ${key(join(root, server.path))};
import dataCodec from ${key(codec)};
${base === undefined ? 'const base = {};' : `import base from ${key(join(root, base.path))};`}
${locales.map((file, index) => `import L${index} from ${key(join(root, file.path))};`).join('\n')}
const locales = { ${locales.map((file, index) => `${key(file.name.toLowerCase())}: L${index}`).join(', ')} };
install();
if (definition.data !== dataCodec) throw new Error('Public page ${route} must use its shared page.data.ts codec');
const load = definition.load[Symbol.for('norbital.bolt.generator')] ?? definition.load;
if (Object.prototype.toString.call(load) !== '[object GeneratorFunction]') throw new Error('Public page loader must be a generator');
export default { page: { ${key(route)}: { body: attached(function* (input, ctx) {
	const data = yield* load(input.request, ctx);
	const encoded = yield* Schema.encodeEffect(dataCodec)(data);
	const locale = input.boot.workspace.locale.toLowerCase();
	const messages = { ...frameworkText(locale), ...base, ...(locales[locale] ?? locales[locale.split('-')[0]] ?? {}) };
	const rendered = render(Page, { props: { data, boot: { ...input.boot, messages } } });
	return { body: rendered.body, head: rendered.head, data: encoded, messages };
}, 1) } } };`;
		const assets: Record<string, Uint8Array> = {};
		let foreignAsyncHooks = false;
		// vite-plugin-svelte dedupes `svelte` to the build root, so the runtime bundled is the root's copy, not
		// necessarily the compiler's: its render context is whichever one this build resolves.
		let renderContext: string | undefined;
		const built = yield* Effect.tryPromise({
			try: (signal) =>
				build({
					root,
					configFile: false,
					logLevel: 'silent',
					resolve: {
						alias: [{ find: /^@norbital-ai\/bolt$/, replacement: join(SOURCE, `index${EXT}`) }]
					},
					ssr: { noExternal: true, resolve: { conditions: ['svelte', 'module', 'production'] } },
					plugins: [
						{
							name: 'bolt:server-page',
							enforce: 'pre',
							// repository-health:allow EFF3 -- Vite owns this asynchronous build hook.
							async buildStart() {
								const runtime = await this.resolve(
									'svelte/server',
									join(SHELL, 'public', `server${EXT}`),
									{
										skipSelf: true
									}
								);
								if (runtime !== null)
									renderContext = join(dirname(runtime.id), '../internal/server/render-context.js');
							},
							// repository-health:allow EFF3 -- Vite owns this asynchronous resolver boundary.
							async resolveId(id, importer) {
								if (id === ENTRY) return `\0${ENTRY}`;
								if (
									id === '$bolt' ||
									id === '@norbital-ai/bolt/page' ||
									id === join(SHELL, 'public', `client${EXT}`) ||
									(importer?.split('?')[0] === join(SHELL, 'public', 'PublicPage.svelte') &&
										/^\.\/client\.[jt]s$/.test(id))
								)
									return join(SHELL, 'public', `server${EXT}`);
								if (id === 'svelte/internal/flags/async')
									throw new Error(
										'Public page SSR requires synchronous Svelte components; load data in pageServer'
									);
								if (NODE.has(id)) {
									const from =
										importer === undefined ? undefined : relative(root, importer.split('?')[0]!);
									if (
										from !== undefined &&
										!from.startsWith('..') &&
										!from.split(sep).includes('node_modules')
									)
										throw new Error(
											`Public page ${route}: ${from} imports ${id}; its guest has no Node modules`
										);
									if (id === 'node:async_hooks' && importer !== renderContext)
										foreignAsyncHooks = true;
									// Resolve dependency builtins as real externals so standard tree shaking can remove unused
									// barrel exports. Any builtin remaining in the final program is refused below.
									return { id, external: true, moduleSideEffects: false };
								}
								if (id.endsWith('?bytes')) {
									const resolved = await this.resolve(id.slice(0, -'?bytes'.length), importer, {
										skipSelf: true
									});
									return resolved === null ? null : `${BYTES}${resolved.id}`;
								}
								// All components, including ui components, use the compiler's one Svelte runtime.
								if (
									id === 'svelte' ||
									id.startsWith('svelte/') ||
									id === '@norbital-ai/ui' ||
									id.startsWith('@norbital-ai/ui/')
								)
									return this.resolve(id, join(SHELL, 'public', `server${EXT}`), {
										skipSelf: true
									});
								return null;
							},
							transform(source, id) {
								const path = relative(root, id);
								if (
									id.startsWith('\0') ||
									path.startsWith('..') ||
									path.split(sep).includes('node_modules') ||
									!SCRIPT.test(id) ||
									!GENERATOR.test(source)
								)
									return null;
								return {
									code: `import { install as __boltEdge } from ${key(edge)}; __boltEdge();${source}`,
									map: null
								};
							},
							load(id) {
								if (id === `\0${ENTRY}`) return entry;
								if (id.endsWith('.css')) return '';
								if (!id.startsWith(BYTES)) return null;
								return readFile(id.slice(BYTES.length), { signal }).then((bytes) => {
									const hash = sha256Hex(bytes);
									assets[hash] = bytes;
									return `export default globalThis[Symbol.for('norbital.bolt.asset')](${key(hash)});`;
								});
							}
						},
						cachedSvelte(
							{
								configFile: false,
								emitCss: false,
								compilerOptions: { dev: false, experimental: { async: false } }
							},
							join(root, '.norbital', 'cache', 'svelte')
						)
					],
					build: {
						ssr: true,
						write: false,
						minify: 'oxc',
						sourcemap: true,
						rolldownOptions: {
							platform: 'neutral',
							input: ENTRY,
							preserveEntrySignatures: 'strict',
							// Svelte uses its SSR target, while the program runs in an ECMAScript guest without Node's require.
							output: {
								format: 'es',
								codeSplitting: false,
								polyfillRequire: false,
								strictExecutionOrder: true,
								sourcemapExcludeSources: true
							}
						}
					}
				}),
			catch: (cause) => new BuildError({ cause })
		});
		const result = Array.isArray(built) ? built[0] : built;
		if (result === undefined || 'close' in result)
			return yield* new BuildError({ cause: new Error(`No server output for ${route}`) });
		const chunks = result.output.filter(
			(item): item is Rolldown.OutputChunk => item.type === 'chunk'
		);
		const chunk = chunks.find((item) => item.isEntry);
		const runtimes = new Set(
			(chunk?.moduleIds ?? []).flatMap((id) => {
				const at = id.lastIndexOf('/node_modules/svelte/');
				return at < 0 ? [] : [id.slice(0, at)];
			})
		);
		if (runtimes.size > 1)
			return yield* new BuildError({
				cause: new Error(
					`Public page ${route} bundles ${runtimes.size} Svelte runtimes; one is required`
				)
			});
		if (chunk === undefined || chunks.length !== 1)
			return yield* new BuildError({
				cause: new Error(`Public page ${route} must emit one standalone server entry`)
			});
		// The only retained dynamic external is Svelte's sync-unreachable async renderer branch.
		// The isolate provides no module if that branch is reached.
		// Rolldown records inlined dynamic imports as references to this emitted chunk, not external modules.
		const external = [
			...chunk.imports,
			...chunk.dynamicImports.filter(
				(id) => id !== chunk.fileName && (id !== 'node:async_hooks' || foreignAsyncHooks)
			)
		];
		if (external.length !== 0)
			return yield* new BuildError({
				cause: new Error(`Public page ${route} requires unbundled modules: ${external.join(', ')}`)
			});
		if (Buffer.byteLength(chunk.code) > 8 * 1024 * 1024)
			return yield* new BuildError({
				cause: new Error(`Public page ${route} exceeds the 8 MiB guest program limit`)
			});
		const file = `server/${route}.mjs`;
		yield* fs.makeDirectory(dirname(join(out, file)), { recursive: true });
		yield* fs.writeFileString(join(out, file), chunk.code);
		if (chunk.map !== null && chunk.map !== undefined)
			yield* fs.writeFileString(join(out, `${file}.map`), chunk.map.toString());
		for (const [hash, bytes] of Object.entries(assets)) {
			yield* fs.makeDirectory(join(out, `server/${route}.assets`), { recursive: true });
			yield* fs.writeFile(join(out, `server/${route}.assets`, hash), bytes);
		}
		pages[route] = { file, sha256: sha256Hex(chunk.code) };
	}
	return pages;
});
