import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import type { Plugin, PluginOption } from 'vite';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Effect, Result, Schema } from 'effect';
import { auditAuthoredSystemColumns } from '../quality/audit.js';
import { WORKSPACE_ENTRY_FILE_NAME } from './client-entry.js';

export { WORKSPACE_ENTRY_FILE_NAME } from './client-entry.js';

export type BoltPluginOptions = Readonly<{
	readonly workspace?: string;
	readonly serverAssets?: ReadonlyArray<{ readonly source: string; readonly target: string }>;
}>;

const WorkspaceNameFileSchema = Schema.Struct({ name: Schema.optional(Schema.String) });

/**
 * What the organization is called, from the workspace's own manifest.
 *
 * `norbital.template.json` carries a `name` written to be read — "HR & Payroll". The host used to
 * read this file itself, at *its* build time, for every workspace it had a checkout of; the name
 * belongs to the workspace, so it is baked into the workspace's own bundle and travels with it.
 * Unreadable or nameless files fall through to `package.json`, then to the `Bolt` default.
 */
const workspaceTitleOf = (root: string): Effect.Effect<string> =>
	Effect.gen(function* () {
		for (const file of ['norbital.template.json', 'package.json']) {
			const title = yield* Effect.tryPromise(() => readFile(join(root, file), 'utf8')).pipe(
				Effect.flatMap((source) =>
					Schema.decodeUnknownEffect(Schema.fromJsonString(WorkspaceNameFileSchema))(source)
				),
				Effect.map(({ name }) => name ?? ''),
				Effect.result
			);
			if (Result.isSuccess(title) && title.success.length > 0) return title.success;
		}
		return 'Bolt';
	});

/** Owns the virtual client runtime/application modules and the emitted workspace client. */
const VitePlugins = {
	bolt: (options: BoltPluginOptions = {}): PluginOption => {
		const clientRuntimeId = '\0virtual:bolt/client-runtime';
		const applicationId = '\0virtual:bolt/application';
		const workspaceRoot = process.cwd();
		const compiler: Plugin = {
			name: '@norbital-ai/bolt',
			// `pre` so the audit below reads the authored markup rather than the JavaScript
			// `vite-plugin-svelte` has already turned it into — a component prop stops being a syntactic
			// position the moment the component is compiled.
			enforce: 'pre',
			/**
			 * The system-column rule, as an authoring error rather than a lint anyone can skip.
			 *
			 * Every workspace build passes each authored file through here, so there is no file the guard
			 * can miss and no extension it can be dodged with — which is the failure mode of a scan that
			 * only ever looked at `.ts`.
			 */
			transform: (code, id) => {
				const file = id.split('?')[0] ?? id;
				if (!file.endsWith('.svelte') || /\/(?:node_modules|\.yalc|\.norbital)\//.test(file))
					return null;
				const findings = auditAuthoredSystemColumns({ [file]: code });
				if (findings.length === 0) return null;
				throw new Error(
					[
						'Authored source may not hand a framework-owned system column to a framework component.',
						...findings.map(
							({ line, component, prop, column }) =>
								`  ${file}:${line} — <${component} ${prop}={… ${column} …}>`
						),
						'The framework already knows the record it mounted a surface for; remove the prop and let it supply the identity.'
					].join('\n')
				);
			},
			config: () => ({
				define: { __BOLT_WORKSPACE__: JSON.stringify(options.workspace ?? 'bolt.workspace.ts') },
				resolve: {
					alias: { $bolt: resolve(workspaceRoot, '.norbital/generated') },
					dedupe: ['effect', 'svelte']
				},
				build: {
					outDir: '.norbital/dist',
					/**
					 * The previous build is removed before this one writes.
					 *
					 * `bolt sync` embeds every file under `.norbital/dist` into the artifact, so a file
					 * left behind by an older build ships inside a newer artifact — a stale client served
					 * as though it were this release's. Emptying makes the directory a report of exactly
					 * one build rather than an accumulation.
					 */
					emptyOutDir: true,
					rollupOptions: {
						input: 'virtual:bolt/application',
						/**
						 * The entry keeps its exports.
						 *
						 * An app build defaults this to `false`, which drops the entry signature: the
						 * emitted entry was 29 bytes of `import"./client-….js";` and `mountWorkspace` was
						 * unreachable, so the artifact carried a client nothing could start.
						 */
						preserveEntrySignatures: 'strict',
						output: { entryFileNames: WORKSPACE_ENTRY_FILE_NAME }
					}
				}
			}),
			resolveId: (id) =>
				id === 'virtual:bolt/client-runtime'
					? clientRuntimeId
					: id === 'virtual:bolt/application'
						? applicationId
						: null,
			load: (id) => {
				// Every generated-client import must be re-exported here. This virtual module is a separate
				// resolution boundary: an omission survives `bolt sync` and fails only when Vite builds a
				// tenant, which is how the old replica bootstrap remained broken unnoticed.
				if (id === clientRuntimeId)
					return `export { createBrowserWorkspaceRuntime, createWorkspaceApiProxy, startLocalReplica, switchWorkspaceAccessScope } from '@norbital-ai/bolt/client-runtime';`;
				if (id === applicationId) {
					return Effect.runPromise(
						workspaceTitleOf(workspaceRoot).pipe(
							Effect.map((title) =>
								[
									`import { mountWorkspace as mountBoltWorkspace } from '@norbital-ai/bolt/client/workspace';`,
									`import { Effect } from 'effect';`,
									`const title = ${JSON.stringify(title)};`,
									``,
									`/**`,
									` * Mounts this workspace into an element the host owns.`,
									` *`,
									` * The only export, and the whole of what a host may do with an artifact's client. The`,
									` * generated modules are imported *inside* the callback rather than at the top of this`,
									` * file: importing the generated client builds the browser runtime, whose query cache is`,
									` * namespaced by tenant and environment, and \`mountWorkspace\` declares the session`,
									` * before it calls this. Statically importing them would build that cache from a session`,
									` * that had not been declared yet.`,
									` */`,
									`export const mountWorkspace = (target, options) =>`,
									`\tmountBoltWorkspace(target, {`,
									`\t\t...options,`,
									`\t\tloadWorkspace: () => Effect.runPromise(`,
									`\t\t\tEffect.all({`,
									`\t\t\t\tworkspace: Effect.promise(() => import('$bolt/client')),`,
									`\t\t\t\tmessages: Effect.promise(() => import('$bolt/i18n-messages.js'))`,
									`\t\t\t}, { concurrency: 'unbounded' }).pipe(`,
									`\t\t\t\tEffect.map(({ workspace, messages }) => ({`,
									`\t\t\t\ttitle,`,
									`\t\t\t\tname: title,`,
									`\t\t\t\tappLoaders: workspace.appLoaders,`,
									`\t\t\t\tappGroups: workspace.appGroups,`,
									`\t\t\t\tappMeta: workspace.appMeta,`,
									`\t\t\t\trepresentationLoaders: workspace.representationLoaders,`,
									`\t\t\t\tcustomTypeRendererLoaders: workspace.customTypeRendererLoaders,`,
									`\t\t\t\tpolicyNames: workspace.policyNames,`,
									`\t\t\t\tagentNames: workspace.agentNames,`,
									`\t\t\t\ttenantMessages: messages.tenantMessages,`,
									`\t\t\t\tclient: workspace.client,`,
									`\t\t\t\tchangeAccessScope: workspace.changeAccessScope,`,
									`\t\t\t\tstartLocalReplica: (accessScope) => workspace.startLocalReplica(workspace.runtime, undefined, { accessScope })`,
									`\t\t\t\t}))`,
									`\t\t\t)`,
									`\t\t)`,
									`\t});`,
									``
								].join('\n')
							)
						)
					);
				}
				return null;
			},
			/**
			 * The build must emit an entry with exports, or the artifact carries a client nothing can start.
			 *
			 * Checked here rather than left to whoever fetches it: a `vite build` that silently drops the
			 * entry signature produced a 29-byte `import"./client-….js";` and every symptom of that
			 * appeared much later, in a browser, as a missing export on a module the host had just
			 * fetched over the network.
			 *
			 * The workspace stylesheet is not this hook's business. It is imported by the *generated
			 * client*, which is only ever reached through a dynamic import, so Vite's own preload helper
			 * inserts the link before that chunk runs. An earlier version of this rewrote the entry
			 * chunk's text to inject a `<link>`; that was a mechanism invented to work around importing
			 * the sheet in the wrong place.
			 */
			generateBundle: (_output, bundle) => {
				const entry = Object.values(bundle).find(
					(output) => output.type === 'chunk' && output.isEntry
				);
				if (entry === undefined) throw new Error('Bolt client build did not emit an entry chunk');
			},
			closeBundle: () =>
				Effect.runPromise(
					Effect.gen(function* () {
						const assets = options.serverAssets ?? [];
						const outDir = resolve(workspaceRoot, '.norbital/dist');
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
		return [svelte(), tailwindcss(), compiler];
	}
};

export const boltPlugin = VitePlugins.bolt;
export const bolt = boltPlugin;
