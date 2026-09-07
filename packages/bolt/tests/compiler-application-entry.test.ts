import type { Plugin } from 'vite';
import { describe, expect, it } from 'vitest';
import { boltPlugin } from '../src/compiler/vite-plugin.js';

const applicationId = '\0virtual:bolt/application';

/** Returns the Bolt-owned plugin from the Vite plugin tuple. */
function compilerPlugin(): Plugin {
	const plugins = boltPlugin();
	const plugin = (Array.isArray(plugins) ? plugins : [plugins]).find(
		(candidate): candidate is Plugin =>
			typeof candidate === 'object' &&
			candidate !== null &&
			'name' in candidate &&
			candidate.name === '@norbital-ai/bolt'
	);
	if (plugin === undefined) throw new Error('The Bolt compiler plugin is missing');
	return plugin;
}

describe('workspace application entry', () => {
	it('enforces the canonical authored client write path during compilation', () => {
		const plugin = compilerPlugin();
		const configure = typeof plugin.config === 'function' ? plugin.config : plugin.config?.handler;
		if (typeof configure !== 'function') throw new Error('Missing compiler config hook');
		configure.call({} as never, { root: '/workspace' } as never, {} as never);
		const transform =
			typeof plugin.transform === 'function' ? plugin.transform : plugin.transform?.handler;
		if (typeof transform !== 'function') throw new Error('Missing compiler transform hook');
		const context = {} as never;
		expect(() =>
			transform.call(
				context,
				'<script>function save() { return client.db.rows.mutate([]); }</script>',
				'/workspace/src/apps/+rows.svelte'
			)
		).toThrow(/save wraps/);
		expect(() =>
			transform.call(
				context,
				'export const save = () => client.invoke.refresh({});',
				'/workspace/src/lib/actions.ts'
			)
		).toThrow(/save wraps/);
		expect(() =>
			transform.call(
				context,
				'<button onclick={() => client.invoke.refresh({})}>Refresh</button>',
				'/workspace/src/apps/+rows.svelte'
			)
		).not.toThrow();
		expect(() =>
			transform.call(
				context,
				'export const save = () => client.invoke.refresh({});',
				'/workspace/node_modules/example/index.ts'
			)
		).not.toThrow();
	});
	it('rejects private runtime imports from authored browser source', () => {
		const plugin = compilerPlugin();
		const configure = typeof plugin.config === 'function' ? plugin.config : plugin.config?.handler;
		if (typeof configure !== 'function')
			throw new Error('The Bolt compiler plugin has no config hook');
		configure.call({} as never, { root: '/workspace' } as never, {} as never);

		const resolve =
			typeof plugin.resolveId === 'function' ? plugin.resolveId : plugin.resolveId?.handler;
		if (typeof resolve !== 'function')
			throw new Error('The Bolt compiler plugin has no resolver hook');
		const context = {
			error(message: string): never {
				throw new Error(message);
			}
		};

		for (const source of [
			'@norbital-ai/bolt/client-runtime',
			'$bolt/framework-client.js',
			'$bolt/framework-collections.js',
			'@norbital-ai/ui/collection-runtime/relationship-directory'
		]) {
			expect(() =>
				resolve.call(context as never, source, '/workspace/src/apps/+private.svelte', {} as never)
			).toThrow(/private Bolt runtime wiring/);
		}
	});

	it('blocks mounting on the framework stylesheet Vite emits for the entry', async () => {
		const plugin = compilerPlugin();
		const load = plugin.load;
		if (typeof load !== 'function')
			throw new Error('The Bolt compiler plugin no longer has a loader');
		const source = await (
			load as (this: void, id: string) => string | null | Promise<string | null>
		)(applicationId);
		if (typeof source !== 'string')
			throw new Error('The Bolt application loader returned no source');

		expect(source).toContain('await loadApplicationStylesheet()');
		expect(source).toContain('import "virtual:bolt/application-stylesheet.css"');
		expect(source).toContain('__BOLT_ENTRY_STYLESHEET__');

		const generateBundle = plugin.generateBundle;
		const generate =
			typeof generateBundle === 'function' ? generateBundle : generateBundle?.handler;
		if (typeof generate !== 'function')
			throw new Error('The Bolt compiler plugin no longer validates its output bundle');
		const entry = {
			type: 'chunk',
			isEntry: true,
			code: source
		};
		const stylesheet = {
			type: 'asset',
			fileName: 'assets/application.css',
			source: '.bolt-app{--bolt-framework-stylesheet:1}'
		};
		generate.call(
			{} as never,
			{} as never,
			{ 'workspace.js': entry, 'assets/application.css': stylesheet } as never,
			false
		);

		expect(entry.code).toContain('assets/application.css');
		expect(entry.code).not.toContain('__BOLT_ENTRY_STYLESHEET__');
		expect(entry.code.indexOf('await loadApplicationStylesheet()')).toBeLessThan(
			entry.code.indexOf('return mountBoltWorkspace')
		);
		expect(source).toContain('documentationFiles: workspace.documentationFiles');
	});

	it("links every stylesheet of the entry's static import graph, and none reached only dynamically", async () => {
		const plugin = compilerPlugin();
		const load = plugin.load;
		if (typeof load !== 'function')
			throw new Error('The Bolt compiler plugin no longer has a loader');
		const source = await (
			load as (this: void, id: string) => string | null | Promise<string | null>
		)(applicationId);
		if (typeof source !== 'string')
			throw new Error('The Bolt application loader returned no source');
		const generateBundle = plugin.generateBundle;
		const generate =
			typeof generateBundle === 'function' ? generateBundle : generateBundle?.handler;
		if (typeof generate !== 'function')
			throw new Error('The Bolt compiler plugin no longer validates its output bundle');

		const chunk = (
			fileName: string,
			imports: ReadonlyArray<string>,
			importedCss: ReadonlyArray<string>,
			extra: Readonly<Record<string, unknown>> = {}
		) => ({
			type: 'chunk',
			fileName,
			imports: [...imports],
			dynamicImports: [],
			viteMetadata: { importedCss: new Set(importedCss), importedAssets: new Set<string>() },
			code: '',
			...extra
		});
		const entry = chunk('workspace.js', ['assets/shell.js'], [], {
			isEntry: true,
			code: source,
			dynamicImports: ['assets/_people.js']
		});
		const bundle = {
			'workspace.js': entry,
			// The shell reaches the table statically; the table reaches the renderer statically.
			'assets/shell.js': chunk('assets/shell.js', ['assets/collection-table.js'], []),
			'assets/collection-table.js': chunk(
				'assets/collection-table.js',
				['assets/data-renderer.js'],
				['assets/collection-table.css']
			),
			'assets/data-renderer.js': chunk('assets/data-renderer.js', [], ['assets/data-renderer.css']),
			// An app is reached only through `import()`; Vite's preload helper links its sheet.
			'assets/_people.js': chunk(
				'assets/_people.js',
				['assets/collection-table.js'],
				['assets/_people.css']
			),
			'assets/application.css': {
				type: 'asset',
				fileName: 'assets/application.css',
				source: '.bolt-app{--bolt-framework-stylesheet:1}'
			},
			'assets/collection-table.css': {
				type: 'asset',
				fileName: 'assets/collection-table.css',
				source: '.collection-table-narrow{display:none}'
			},
			'assets/data-renderer.css': {
				type: 'asset',
				fileName: 'assets/data-renderer.css',
				source: '.cm-editor{height:100%}'
			},
			'assets/_people.css': {
				type: 'asset',
				fileName: 'assets/_people.css',
				source: '.people{display:grid}'
			}
		};
		generate.call({} as never, {} as never, bundle as never, false);

		expect(entry.code).toContain(
			'"assets/application.css,assets/collection-table.css,assets/data-renderer.css"'
		);
		expect(entry.code).not.toContain('_people.css');
		expect(entry.code).not.toContain('__BOLT_ENTRY_STYLESHEET__');
		expect(entry.code).toContain('Promise.all(applicationStylesheets.map(linkStylesheet))');
	});
});
