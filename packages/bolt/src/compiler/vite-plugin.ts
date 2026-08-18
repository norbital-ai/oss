import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Plugin, PluginOption } from 'vite';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Effect } from 'effect';
import { auditAuthoredSystemColumns } from '../quality/audit.js';

export type BoltPluginOptions = Readonly<{
	readonly workspace?: string;
	readonly serverAssets?: ReadonlyArray<{ readonly source: string; readonly target: string }>;
}>;

/** Owns the virtual client runtime/application modules and emitted browser shell. */
const VitePlugins = {
bolt: (options: BoltPluginOptions = {}): PluginOption => {
	const clientRuntimeId = '\0virtual:bolt/client-runtime';
	const applicationId = '\0virtual:bolt/application';
	const compiler: Plugin = {
		name: '@norbital-ai/bolt',
		// `pre` so the audit below reads the authored markup rather than the JavaScript
		// `vite-plugin-svelte` has already turned it into — a component prop stops being a syntactic
		// position the moment the component is compiled.
		enforce: 'pre',
		/**
		 * The `norbital_*` rule, as an authoring error rather than a lint anyone can skip.
		 *
		 * Every workspace build passes each authored file through here, so there is no file the guard
		 * can miss and no extension it can be dodged with — which is the failure mode of the scan in
		 * Colony's `dependencies.test.ts`, green for years because it only ever looked at `.ts`.
		 */
		transform: (code, id) => {
			const file = id.split('?')[0] ?? id;
			if (!file.endsWith('.svelte') || /\/(?:node_modules|\.yalc|\.norbital)\//.test(file)) return null;
			const findings = auditAuthoredSystemColumns({ [file]: code });
			if (findings.length === 0) return null;
			throw new Error(
				[
					'Authored source may not hand a framework-owned system column to a framework component.',
					...findings.map(({ line, component, prop, column }) => `  ${file}:${line} — <${component} ${prop}={… ${column} …}>`),
					'The framework already knows the record it mounted a surface for; remove the prop and let it supply the identity.'
				].join('\n')
			);
		},
		config: () => ({
			define: { __BOLT_WORKSPACE__: JSON.stringify(options.workspace ?? 'bolt.workspace.ts') },
			resolve: {
				alias: { '$bolt': resolve(process.cwd(), '.norbital/generated') },
				dedupe: ['effect', 'svelte']
			},
			build: { outDir: '.norbital/dist', rollupOptions: { input: 'virtual:bolt/application' } }
		}),
		resolveId: (id) => id === 'virtual:bolt/client-runtime' ? clientRuntimeId : id === 'virtual:bolt/application' ? applicationId : null,
		load: (id) => {
			// Every name the generated client imports must be re-exported here. `startBrowserReplica`
			// was declared in the virtual module's .d.ts (sync.ts:217) and imported by the generated
			// client (sync.ts:262) but never re-exported, so `vite build` failed for every template
			// while `bolt sync` — which does not resolve this module — stayed green.
			if (id === clientRuntimeId)
				return `export { createBrowserWorkspaceRuntime, createWorkspaceApiProxy, startBrowserReplica, startLocalReplica } from '@norbital-ai/bolt/client-runtime';`;
			if (id === applicationId) return `import { appLoaders } from '$bolt/client'; export { appLoaders };`;
			return null;
		},
		/** Owns generate bundle behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
		generateBundle: function (_options, bundle) {
			const entry = Object.values(bundle).find((output) => output.type === 'chunk' && output.isEntry);
			if (entry === undefined) throw new Error('Bolt client build did not emit an entry chunk');
			this.emitFile({
				type: 'asset',
				fileName: 'index.html',
				source: `<!doctype html><html lang="en" data-bolt-tenant="local" data-bolt-environment="development" data-bolt-release="local"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bolt</title></head><body><main id="bolt-app"></main><script type="module" src="/${entry.fileName}"></script></body></html>`
			});
		},
		closeBundle: () =>
			Effect.runPromise(
				Effect.gen(function* () {
					const assets = options.serverAssets ?? [];
					const outDir = resolve(process.cwd(), '.norbital/dist');
					yield* Effect.all(
						assets.map((asset) =>
							Effect.gen(function* () {
								const target = resolve(outDir, asset.target);
								yield* Effect.tryPromise(() => mkdir(dirname(target), { recursive: true }));
								yield* Effect.tryPromise(() => copyFile(asset.source, target));
							})
						),
						{ concurrency: 'unbounded' }
					);
				})
			)
	};
	return [svelte(), compiler];
}
};

export const boltPlugin = VitePlugins.bolt;
export const bolt = boltPlugin;
