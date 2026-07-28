import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { type Plugin, type PluginOption } from 'vite';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSeedManifest, seedManifestJson } from '@norbital-ai/platform-utils/seed/manifest';
import { parseNorbitalManifest } from '@norbital-ai/platform-utils/manifest/parse';
import {
	CHECKPOINT_MANIFEST_FILENAME,
	SERVE_ENTRY_FILENAME
} from '@norbital-ai/platform-utils/tenant_workspace/build-output';
import { runSvelteCheck } from './checker.js';
import { compilePodFilesystem } from './compiler/index.js';
import { generatePodMigrations } from './migrations.js';
import { SCHEMA_FUNCTIONS_SQL, SCHEMA_POST_DDL_SQL } from './schema-functions-sql.js';
import { workspaceExclusionsDdl } from './workspace-exclusions-sql.js';
import { readPodClientPlatformManifest, type PodClientPlatformManifest } from './platform.js';

export { compilePodFilesystem, discoverPodFilesystem } from './compiler/index.js';
export {
	buildPodClientPlatform,
	POD_CLIENT_PLATFORM_MANIFEST,
	type PodClientPlatformManifest
} from './platform.js';
export type {
	AppMetadata,
	DiagnosticSnapshot,
	DiscoveredApp,
	DiscoveredAppNode,
	DiscoveredCollection,
	DiscoveredCustomType,
	DiscoveredGroup,
	DiscoveredWorkspaceRole,
	PodFilesystemCompilation,
	PodFilesystemCompilerOptions,
	PodStructure,
	SourcePosition,
	StructuralDiagnostic
} from './compiler/index.js';

const CLIENT_ENTRY = 'virtual:pod/client-entry';
const CLIENT_RUNTIME = 'virtual:pod/client-runtime';
const SERVER_ENTRY = 'virtual:pod/server-entry';

function podBuildFile(relativePath: string): string {
	const abs = path.resolve(import.meta.dirname, '..', relativePath);
	return abs.split(path.sep).join('/');
}

export interface PodPluginOptions {
	readonly outDir?: string;
}

function clientOnlyPlugin(plugin: Plugin): Plugin {
	const appliesToEnvironment = plugin.applyToEnvironment;
	return {
		...plugin,
		applyToEnvironment(environment) {
			if (environment.name !== 'client') return false;
			return appliesToEnvironment?.call(plugin, environment) ?? true;
		}
	};
}

export function pod(options: PodPluginOptions = {}): PluginOption[] {
	let root = '';
	let artifactRoot = '';
	let clientDistRoot = '';
	let migrationsRoot = '';
	let generatedClient = '';
	let generatedWorkspace = '';
	let clientEntryFile = '';
	let clientStylesheets: string[] = [];
	let clientPlatform: { manifest: PodClientPlatformManifest; publicBase: string } | undefined;
	let buildArtifactsPrepared = false;

	async function finalizeArtifacts(): Promise<void> {
		if (!clientEntryFile) throw new Error('Pod client entry was not emitted');
		await mkdir(clientDistRoot, { recursive: true });
		const platform = clientPlatform;
		const platformStylesheets = platform
			? platform.manifest.stylesheets.map((file) => `${platform.publicBase}${file}`)
			: [];
		const stylesheets = [...platformStylesheets, ...clientStylesheets.map((file) => `/${file}`)];
		await writeFile(
			path.join(clientDistRoot, 'index.html'),
			`<!doctype html><html><head><meta charset="utf-8"><script>(function(){var stored=localStorage.getItem('mode-watcher-mode');var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;if(stored==='dark'||(stored==='system'&&prefersDark)||(!stored&&prefersDark)){document.documentElement.classList.add('dark');document.documentElement.style.colorScheme='dark';}})();</script><meta name="viewport" content="width=device-width,initial-scale=1">${stylesheets.map((file) => `<link rel="stylesheet" href="${file}">`).join('')}</head><body><script type="module" src="/${clientEntryFile}"></script></body></html>\n`
		);
		// The container entry point. Two lines so the server bundle stays importable at build
		// time (below) without starting a request loop.
		await writeFile(
			path.join(artifactRoot, SERVE_ENTRY_FILENAME),
			`import { startPodStdioServer } from './output/server/index.js';\nstartPodStdioServer();\n`
		);
		await writeFile(path.join(clientDistRoot, 'package.json'), '{"type":"module"}\n');
		await mkdir(path.join(artifactRoot, 'output/server'), { recursive: true });
		await writeFile(path.join(artifactRoot, 'output/server/package.json'), '{"type":"module"}\n');
		const serverModule: unknown = await import(
			`${pathToFileURL(path.join(artifactRoot, 'output/server/index.js')).href}?build=${Date.now()}`
		);
		if (
			typeof serverModule === 'object' &&
			serverModule != null &&
			'workspaceSeedManifest' in serverModule &&
			serverModule.workspaceSeedManifest != null
		) {
			await writeFile(
				path.join(artifactRoot, 'seed-manifest.json'),
				seedManifestJson(parseSeedManifest(serverModule.workspaceSeedManifest))
			);
		}
		if (
			typeof serverModule !== 'object' ||
			serverModule == null ||
			!('workspaceManifest' in serverModule) ||
			serverModule.workspaceManifest == null
		) {
			throw new Error('Pod server build did not export workspaceManifest');
		}
		await writeFile(
			path.join(artifactRoot, CHECKPOINT_MANIFEST_FILENAME),
			`${JSON.stringify(serverModule.workspaceManifest, null, 2)}\n`
		);

		await writeFile(path.join(artifactRoot, 'schema-functions.sql'), SCHEMA_FUNCTIONS_SQL);
		// EXCLUDE constraints ride along in schema-post-ddl.sql rather than in an artifact of
		// their own: every consumer (applier, checkpoint required-paths, bundled build, DDL
		// validator, pod_migrate, studio preview) already reads that one file.
		await writeFile(
			path.join(artifactRoot, 'schema-post-ddl.sql'),
			`${SCHEMA_POST_DDL_SQL}\n\n${workspaceExclusionsDdl(parseNorbitalManifest(serverModule.workspaceManifest))}`
		);
	}

	const buildPlugin: Plugin = {
		name: 'norbital-pod-build',
		enforce: 'pre',
		applyToEnvironment: () => true,
		async config(_config, environment) {
			root = path.resolve(_config.root ?? process.cwd());
			const configuredBuildTarget = process.env.NORBITAL_POD_BUILD_TARGET;
			if (
				configuredBuildTarget != null &&
				configuredBuildTarget !== 'server' &&
				configuredBuildTarget !== 'client'
			) {
				throw new Error(`Invalid NORBITAL_POD_BUILD_TARGET: ${configuredBuildTarget}`);
			}
			const configuredOutDir = options.outDir ?? process.env.NORBITAL_BUILD_OUT;
			const platformDirectory = process.env.NORBITAL_POD_PLATFORM_DIR?.trim();
			if (platformDirectory) {
				const manifest = await readPodClientPlatformManifest(platformDirectory);
				const configuredPublicBase = process.env.NORBITAL_POD_PLATFORM_BASE_URL?.trim();
				const publicBase = configuredPublicBase || `/_platform/${manifest.packageKey}/`;
				clientPlatform = {
					manifest,
					publicBase: publicBase.endsWith('/') ? publicBase : `${publicBase}/`
				};
			}
			artifactRoot = configuredOutDir
				? path.resolve(root, configuredOutDir)
				: path.join(root, '.norbital/dist');
			clientDistRoot = configuredOutDir ? path.join(artifactRoot, 'dist') : artifactRoot;
			migrationsRoot = configuredOutDir
				? path.join(artifactRoot, '.norbital/migrations')
				: path.join(root, '.norbital/migrations');
			const generatedRoot = path.join(root, '.norbital/generated');
			generatedClient = path.join(generatedRoot, 'client.ts');
			generatedWorkspace = path.join(generatedRoot, 'workspace.ts');
			const mode = environment.command === 'build' ? 'build' : 'authoring';
			if (process.env.NORBITAL_POD_SYNCED !== '1') {
				const compilation = await compilePodFilesystem({ root, mode });
				if (!compilation.valid) {
					throw new Error(
						`Pod filesystem has ${compilation.diagnostics.length} structural error(s)`
					);
				}
			}
			if (environment.command === 'build' && !buildArtifactsPrepared) {
				buildArtifactsPrepared = true;
				if (process.env.NORBITAL_POD_CHECKED !== '1') await runSvelteCheck(root);
				if (configuredBuildTarget !== 'client') {
					await rm(artifactRoot, { recursive: true, force: true });
				}
				// Generate migrations before either Vite environment is built. Drizzle runs in a
				// child Node process; starting it after the client build made it overlap with the
				// retained server/client Rolldown graphs and could exceed the 500 MiB sandbox.
				// Split builds intentionally keep their existing no-migration behavior.
				if (configuredBuildTarget == null) {
					await generatePodMigrations({ root, migrationsRoot });
				}
			}
			return {
				appType: 'custom',
				server: { watch: { ignored: ['**/.norbital/**', '**/.svelte-check/**'] } },
				resolve: {
					dedupe: ['svelte', 'zod', 'runed', '@iconify/svelte']
				},
				builder: {
					sharedConfigBuild: true,
					sharedPlugins: true,
					buildApp: async (builder) => {
						if (configuredBuildTarget !== 'client') {
							await builder.build(builder.environments.server);
						}
						if (configuredBuildTarget !== 'server') {
							await builder.build(builder.environments.client);
							await finalizeArtifacts();
						}
					}
				},
				environments: {
					server: {
						consumer: 'server',
						keepProcessEnv: true,
						resolve: { noExternal: true },
						build: {
							outDir: path.join(artifactRoot, 'output/server'),
							emptyOutDir: true,
							copyPublicDir: false,
							minify: 'oxc',
							reportCompressedSize: false,
							sourcemap: false,
							ssr: true,
							rolldownOptions: {
								input: SERVER_ENTRY,
								external: (id: string) => id.startsWith('node:'),
								output: {
									format: 'esm',
									codeSplitting: false,
									entryFileNames: 'index.js'
								}
							}
						}
					},
					client: {
						consumer: 'client',
						build: {
							outDir: clientDistRoot,
							emptyOutDir: false,
							copyPublicDir: false,
							minify: 'oxc',
							reportCompressedSize: false,
							sourcemap: false,
							rolldownOptions: {
								input: CLIENT_ENTRY,
								experimental: { chunkOptimization: false, lazyBarrel: false },
								output: {
									codeSplitting: {
										groups: [
											{
												name: 'schema-runtime',
												test: /node_modules[\\/]zod[\\/]/,
												priority: 10
											},
											{
												name: 'platform-runtime',
												test: /(?:node_modules[\\/]@norbital-ai[\\/]platform-utils|packages[\\/]platform-utils)[\\/]/,
												priority: 9
											},
											{ name: 'workspace-runtime', tags: ['$initial'] }
										]
									}
								}
							}
						}
					}
				}
			};
		},
		resolveId(source) {
			const platformFile =
				this.environment.name === 'client' ? clientPlatform?.manifest.imports[source] : undefined;
			if (platformFile && clientPlatform) {
				return {
					id: `${clientPlatform.publicBase}${platformFile}`,
					external: true
				};
			}
			if (source === CLIENT_ENTRY || source === SERVER_ENTRY) {
				return `\0${source}`;
			}
			if (source === CLIENT_RUNTIME) {
				if (clientPlatform) {
					const runtimeFile = clientPlatform.manifest.imports['@norbital-ai/pod/client/runtime'];
					if (!runtimeFile) {
						throw new Error('Pod client platform does not export its client runtime');
					}
					return {
						id: `${clientPlatform.publicBase}${runtimeFile}`,
						external: true
					};
				}
				return podBuildFile('runtime/client.js');
			}
			if (source === '$pod/client') return generatedClient;
		},
		load(id) {
			if (id === `\0${SERVER_ENTRY}`) {
				return `import workspace from ${JSON.stringify(generatedWorkspace.split(path.sep).join('/'))};
import { handlePodRequest, registerPodWorkspace, getTenantManifest } from ${JSON.stringify(podBuildFile('runtime/server.js'))};
export { startPodStdioServer } from ${JSON.stringify(podBuildFile('runtime/serve.js'))};
registerPodWorkspace(workspace);
export const workspaceSeedManifest = workspace.seed?.manifest ?? null;
export const workspaceManifest = getTenantManifest();
export { handlePodRequest };`;
			}
			if (id !== `\0${CLIENT_ENTRY}`) return;
			return `${clientPlatform ? '' : `import ${JSON.stringify(podBuildFile('app.css'))};\n`}import { mountPodWorkspace } from '@norbital-ai/pod/client/platform';
import { appLoaders } from ${JSON.stringify(generatedClient.split(path.sep).join('/'))};
import { collectionSurfaces } from ${JSON.stringify(path.join(root, '.norbital/generated/collection-surfaces.ts').split(path.sep).join('/'))};
import { customTypeRenderers } from ${JSON.stringify(path.join(root, '.norbital/generated/custom-type-renderers.ts').split(path.sep).join('/'))};
mountPodWorkspace({ apps: appLoaders, collectionSurfaces, customTypeRenderers });`;
		},
		async writeBundle(_options, bundle) {
			if (this.environment.name !== 'client') return;
			const outputs = Object.values(bundle);
			const entryChunks = outputs.flatMap((output) =>
				output.type === 'chunk' && output.isEntry ? [output] : []
			);
			const clientEntry =
				entryChunks.find((output) => output.facadeModuleId === `\0${CLIENT_ENTRY}`) ??
				(entryChunks.length === 1 ? entryChunks[0] : undefined);
			if (!clientEntry) throw new Error('Pod client entry was not emitted');
			clientEntryFile = clientEntry.fileName;
			clientStylesheets = outputs
				.filter((output) => output.type === 'asset' && output.fileName.endsWith('.css'))
				.map((output) => output.fileName)
				.sort();
		}
	};
	return [
		...svelte({ configFile: false }).map((plugin) =>
			plugin.name === 'vite-plugin-svelte:config' ? plugin : clientOnlyPlugin(plugin)
		),
		...tailwindcss().map(clientOnlyPlugin),
		buildPlugin
	];
}
