import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import type { Plugin, PluginOption } from 'vite';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Effect, Result, Schema } from 'effect';
import {
	auditAuthoredClientWrappers,
	auditAuthoredSystemColumns,
	auditHooklessMutations
} from '../quality/audit.js';
import { SERVER_ASSET_DECLARATION_FILE_NAME, WORKSPACE_ENTRY_FILE_NAME } from './client-entry.js';

export { WORKSPACE_ENTRY_FILE_NAME } from './client-entry.js';

export type BoltPluginOptions = Readonly<{
	readonly workspace?: string;
	readonly serverAssets?: ReadonlyArray<{ readonly source: string; readonly target: string }>;
}>;

const WorkspaceNameFileSchema = Schema.Struct({ name: Schema.optional(Schema.String) });
/** Built once: a decoder is compiled where it is constructed, and this one runs per manifest read. */
const decodeWorkspaceNameFile = Schema.decodeUnknownEffect(
	Schema.fromJsonString(WorkspaceNameFileSchema)
);
const WORKSPACE_ENTRY_STYLESHEET_PLACEHOLDER = '__BOLT_ENTRY_STYLESHEET__';
const WORKSPACE_ENTRY_STYLESHEET_REFERENCE = 'virtual:bolt/application-stylesheet.css';
const WORKSPACE_ENTRY_STYLESHEET_ID = `\0${WORKSPACE_ENTRY_STYLESHEET_REFERENCE}`;
const WORKSPACE_ENTRY_STYLESHEET_MARKER = '--bolt-framework-stylesheet';

/**
 * What the organization is called, from the workspace's own manifest.
 *
 * `norbital.template.json` carries a `name` written to be read — "HR & Payroll". The host used to
 * read this file itself, at *its* build time, for every workspace it had a checkout of; the name
 * belongs to the workspace, so it is baked into the workspace's own bundle and travels with it.
 * Unreadable or nameless files fall through to `package.json`, then to the `Bolt` default.
 */
const workspaceTitleOf = (root: string): Effect.Effect<string> => {
	/** The `name` one manifest carries, or the empty string when it is missing or unreadable. */
	const named = (file: string): Effect.Effect<string> =>
		Effect.tryPromise(() => readFile(join(root, file), 'utf8')).pipe(
			Effect.flatMap(decodeWorkspaceNameFile),
			Effect.map(({ name }) => name ?? ''),
			Effect.result,
			Effect.map((title) => (Result.isSuccess(title) ? title.success : ''))
		);
	return named('norbital.template.json').pipe(
		Effect.flatMap((title) => (title.length > 0 ? Effect.succeed(title) : named('package.json'))),
		Effect.map((title) => (title.length > 0 ? title : 'Bolt'))
	);
};

/** Owns the virtual client runtime/application modules and the emitted workspace client. */
const VitePlugins = {
	bolt: (options: BoltPluginOptions = {}): PluginOption => {
		const clientRuntimeId = '\0virtual:bolt/client-runtime';
		const applicationId = '\0virtual:bolt/application';
		let workspaceRoot = process.cwd();
		const authoredClientBoundary = (id: string, importer: string | undefined): void => {
			if (importer === undefined) return;
			const importerFile = (importer.split('?')[0] ?? importer).replaceAll('\\', '/');
			const authoredRoot = `${resolve(workspaceRoot, 'src').replaceAll('\\', '/')}/`;
			if (!importerFile.startsWith(authoredRoot)) return;
			const privateGeneratedFiles = new Set(
				[
					'framework-client',
					'framework-client.js',
					'framework-collections',
					'framework-collections.js'
				].map((file) =>
					resolve(workspaceRoot, '.norbital', 'generated', file).replaceAll('\\', '/')
				)
			);
			const importedFile =
				id.startsWith('.') || id.startsWith('/')
					? resolve(dirname(importerFile), id).replaceAll('\\', '/')
					: undefined;
			const privateImport =
				id === 'virtual:bolt/client-runtime' ||
				id === '$bolt/framework-client' ||
				id.startsWith('$bolt/framework-client.') ||
				id === '$bolt/framework-collections' ||
				id.startsWith('$bolt/framework-collections.') ||
				id === '@norbital-ai/bolt/client-runtime' ||
				id.startsWith('@norbital-ai/bolt/client-runtime/') ||
				id.startsWith('@norbital-ai/bolt/build/client/runtime') ||
				id.startsWith('@norbital-ai/ui/collection-runtime/relationship-directory') ||
				(importedFile !== undefined && privateGeneratedFiles.has(importedFile));
			if (!privateImport) return;
			throw new Error(
				`Authored source may import only $bolt/client for browser data access; ${id} is private Bolt runtime wiring (${importerFile}).`
			);
		};
		const compiler: Plugin = {
			name: '@norbital-ai/bolt',
			// `pre` so the audit below reads the authored markup rather than the JavaScript
			// `vite-plugin-svelte` has already turned it into — a component prop stops being a syntactic
			// position the moment the component is compiled.
			enforce: 'pre',
			buildStart() {
				for (const finding of auditHooklessMutations(workspaceRoot))
					this.warn({
						code: 'BOLT_HOOK_REVIEW',
						message: `${finding.file}:${finding.line}: ${finding.collection} permits mutations without ${finding.expectedHooks}. Review whether its writes require domain validation.`,
						id: join(workspaceRoot, finding.file)
					});
			},
			/**
			 * The system-column rule, as an authoring error rather than a lint anyone can skip.
			 *
			 * Every workspace build passes each authored file through here, so there is no file the guard
			 * can miss and no extension it can be dodged with — which is the failure mode of a scan that
			 * only ever looked at `.ts`.
			 */
			transform: (code, id) => {
				const file = id.split('?')[0] ?? id;
				if (/\/(?:node_modules|\.yalc|\.norbital)\//.test(file)) return null;
				if (
					file.startsWith(`${resolve(workspaceRoot, 'src')}${sep}`) &&
					/\.(?:svelte|ts)$/.test(file)
				) {
					const wrappers = auditAuthoredClientWrappers({ [file]: code });
					if (wrappers.length > 0)
						throw new Error(
							[
								'Authored client writes must use CollectionForm or an inline command handler.',
								...wrappers.map(
									({ line, functionName, call }) =>
										`  ${file}:${line} — ${functionName} wraps ${call}`
								)
							].join('\n')
						);
				}
				if (!file.endsWith('.svelte')) return null;
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
			config: (config) => {
				// Programmatic callers can build a workspace selected by `root` without changing the
				// process working directory. The CLI's `--root` option relies on that contract.
				workspaceRoot = resolve(config.root ?? process.cwd());
				return {
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
				};
			},
			resolveId: (id, importer) => {
				authoredClientBoundary(id, importer);
				return id === 'virtual:bolt/client-runtime'
					? clientRuntimeId
					: id === 'virtual:bolt/application'
						? applicationId
						: id === WORKSPACE_ENTRY_STYLESHEET_REFERENCE
							? WORKSPACE_ENTRY_STYLESHEET_ID
							: null;
			},
			load: (id) => {
				if (id === WORKSPACE_ENTRY_STYLESHEET_ID)
					return `.bolt-app { ${WORKSPACE_ENTRY_STYLESHEET_MARKER}: 1; }`;
				// Every generated-client import must be re-exported here. This virtual module is a separate
				// resolution boundary: an omission survives `bolt sync` and fails only when Vite builds a
				// tenant.
				if (id === clientRuntimeId)
					return `export { createBrowserWorkspaceRuntime, createWorkspaceApiProxy } from '@norbital-ai/bolt/client-runtime';`;
				if (id === applicationId) {
					return Effect.runPromise(
						workspaceTitleOf(workspaceRoot).pipe(
							Effect.map((title) =>
								[
									`import ${JSON.stringify(WORKSPACE_ENTRY_STYLESHEET_REFERENCE)};`,
									`import { mountWorkspace as mountBoltWorkspace } from '@norbital-ai/bolt/client/workspace';`,
									`import { toError } from '@norbital-ai/std';`,
									`import { Effect } from 'effect';`,
									`const title = ${JSON.stringify(title)};`,
									`const applicationStylesheet = ${JSON.stringify(WORKSPACE_ENTRY_STYLESHEET_PLACEHOLDER)};`,
									`let applicationStylesheetReady;`,
									`const loadApplicationStylesheet = () => {`,
									`\tif (applicationStylesheet.length === 0) return Promise.resolve();`,
									`\tif (applicationStylesheetReady !== undefined) return applicationStylesheetReady;`,
									`\tapplicationStylesheetReady = new Promise((resolve, reject) => {`,
									`\t\tconst href = new URL(applicationStylesheet, import.meta.url).href;`,
									`\t\tif (Array.from(document.styleSheets).some((sheet) => sheet.href === href)) {`,
									`\t\t\tresolve();`,
									`\t\t\treturn;`,
									`\t\t}`,
									`\t\tconst existing = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).find((link) => link.href === href);`,
									`\t\tconst link = existing ?? Object.assign(document.createElement('link'), { rel: 'stylesheet', href });`,
									`\t\tlink.addEventListener('load', () => resolve(), { once: true });`,
									`\t\tlink.addEventListener('error', () => reject(new Error(\`Workspace framework stylesheet failed to load: \${href}\`)), { once: true });`,
									`\t\tif (existing === undefined) document.head.append(link);`,
									`\t});`,
									`\treturn applicationStylesheetReady;`,
									`};`,
									``,
									`/**`,
									` * Mounts this workspace into an element the host owns.`,
									` *`,
									` * The only export, and the whole of what a host may do with an artifact's client. The`,
									` * generated workspace is imported *inside* the callback rather than at the top of this file:`,
									` * importing it builds a browser runtime whose query cache is namespaced by tenant and`,
									` * environment, and \`mountWorkspace\` declares the session before it calls that loader.`,
									` *`,
									` * The framework shell itself is part of this entry chunk. Its scoped CSS is emitted beside`,
									` * the entry, but an artifact has no HTML document for Vite to add a link to. The compiler`,
									` * fills the stylesheet placeholder above with the emitted asset and this await prevents the`,
									` * shell from mounting before that sheet has applied.`,
									` */`,
									`export const mountWorkspace = async (target, options) => {`,
									`\tawait loadApplicationStylesheet();`,
									`\treturn mountBoltWorkspace(target, {`,
									`\t\t...options,`,
									`\t\tloadWorkspace: () => Effect.runPromise(`,
									`\t\t\tEffect.all({`,
									`\t\t\t\tworkspace: Effect.tryPromise({ try: () => import('$bolt/client'), catch: toError }),`,
									`\t\t\t\tframework: Effect.tryPromise({ try: () => import('$bolt/framework-client.js'), catch: toError }),`,
									`\t\t\t\tmessages: Effect.tryPromise({ try: () => import('$bolt/i18n-messages.js'), catch: toError })`,
									`\t\t\t}, { concurrency: 'unbounded' }).pipe(`,
									`\t\t\t\tEffect.map(({ workspace, framework, messages }) => ({`,
									`\t\t\t\ttitle,`,
									`\t\t\t\tname: title,`,
									`\t\t\t\tappLoaders: workspace.appLoaders,`,
									`\t\t\t\tappGroups: workspace.appGroups,`,
									`\t\t\t\tappMeta: workspace.appMeta,`,
									`\t\t\t\tdocumentationFiles: workspace.documentationFiles,`,
									`\t\t\t\trepresentationLoaders: workspace.representationLoaders,`,
									`\t\t\t\tcustomTypeRendererLoaders: workspace.customTypeRendererLoaders,`,
									`\t\t\t\tpolicyNames: workspace.policyNames,`,
									`\t\t\t\tagentNames: workspace.agentNames,`,
									`\t\t\t\ttenantMessages: messages.tenantMessages,`,
									`\t\t\t\tclient: workspace.client,`,
									`\t\t\t\tframeworkClient: framework.frameworkClient,`,
									`\t\t\t\tsyncStatus: framework.syncStatus,`,
									`\t\t\t\tcreateBootstrap: framework.createBootstrap,`,
									`\t\t\t\tchangeAccessScope: framework.changeAccessScope`,
									`\t\t\t\t}))`,
									`\t\t\t)`,
									`\t\t)`,
									`\t});`,
									`};`,
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
			 * There are two stylesheets with different owners. The workspace's Tailwind sheet is imported
			 * by the generated client, which Vite reaches dynamically and preloads itself. The framework
			 * shell's scoped styles belong to this entry chunk. Because an artifact build generates no HTML,
			 * nothing else can link that entry stylesheet; fill the stable placeholder in the entry's own
			 * loader with the asset Vite emitted for it.
			 */
			generateBundle: {
				// Vite emits CSS assets in its own generate hook. Running after ordinary hooks makes the
				// marker-bearing entry sheet observable here without depending on its content-hashed name.
				order: 'post',
				handler: (_output, bundle) => {
					const entry = Object.values(bundle).find(
						(output) => output.type === 'chunk' && output.isEntry
					);
					if (entry === undefined || entry.type !== 'chunk')
						throw new Error('Bolt client build did not emit an entry chunk');
					// One pass: the marker test reads every asset's whole source, so it runs once per output
					// rather than once per surviving link in a filter/map/sort chain.
					const stylesheets: Array<string> = [];
					for (const output of Object.values(bundle)) {
						if (output.type !== 'asset' || !output.fileName.endsWith('.css')) continue;
						if (!String(output.source).includes(WORKSPACE_ENTRY_STYLESHEET_MARKER)) continue;
						stylesheets.push(output.fileName);
					}
					stylesheets.sort();
					const [stylesheet] = stylesheets;
					if (stylesheets.length !== 1 || stylesheet === undefined)
						throw new Error(
							`Bolt client entry emitted ${stylesheets.length} marked framework stylesheets; expected one`
						);
					if (!entry.code.includes(WORKSPACE_ENTRY_STYLESHEET_PLACEHOLDER))
						throw new Error('Bolt client entry lost its framework stylesheet placeholder');
					entry.code = entry.code.replace(WORKSPACE_ENTRY_STYLESHEET_PLACEHOLDER, stylesheet);
				}
			},
			/**
			 * Copies the workspace's declared server assets, and writes down that it did.
			 *
			 * The copy alone is not enough. These files land in the same directory as the compiled
			 * client, and `bolt sync` used to index everything it found there as a public browser asset
			 * — so a WebAssembly module a workspace declared for its *own* runtime was published at a
			 * URL the moment it was declared. The compiler cannot tell the two apart by looking: it
			 * never reads `vite.config.ts` (Vite does), and a path is not a permission. The declaration
			 * is the only authority, so it is written beside the output for the compiler to read.
			 */
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
						// The declared target *is* the key the guest's asset bridge asks for, so it is
						// recorded exactly as authored — normalized to forward slashes, and to nothing else.
						const targets = assets.map((asset) => asset.target.split(sep).join('/')).toSorted();
						yield* Effect.tryPromise(() => mkdir(outDir, { recursive: true }));
						yield* Effect.tryPromise(() =>
							writeFile(
								join(outDir, SERVER_ASSET_DECLARATION_FILE_NAME),
								`${JSON.stringify({ targets }, null, '\t')}\n`,
								'utf8'
							)
						);
					})
				)
		};
		return [svelte(), tailwindcss(), compiler];
	}
};

export const boltPlugin = VitePlugins.bolt;
export const bolt = boltPlugin;
