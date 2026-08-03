import { type Plugin, type PluginOption } from 'vite';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
	CHECKPOINT_MANIFEST_FILENAME,
	SERVE_ENTRY_FILENAME
} from '@norbital-ai/platform-utils/tenant_workspace/build-output';
import {
	POD_CLIENT_PLATFORM_MANIFEST,
	type PodClientPlatformManifest
} from './platform-contract.js';
import type {
	PodFilesystemCompilation,
	PodFilesystemCompilerOptions,
	PodStructure
} from './compiler/types.js';

export async function compilePodFilesystem(
	options: PodFilesystemCompilerOptions
): Promise<PodFilesystemCompilation> {
	const compiler = await import('./compiler/index.js');
	return compiler.compilePodFilesystem(options);
}

export async function discoverPodFilesystem(root: string): Promise<PodStructure> {
	const compiler = await import('./compiler/index.js');
	return compiler.discoverPodFilesystem(root);
}

export async function buildPodClientPlatform(input: {
	readonly outDir: string;
	readonly packageKey: string;
}): Promise<void> {
	const platform = await import('./platform.js');
	return platform.buildPodClientPlatform(input);
}

export { POD_CLIENT_PLATFORM_MANIFEST, type PodClientPlatformManifest };
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
} from './compiler/types.js';

const CLIENT_ENTRY = 'virtual:pod/client-entry';
const CLIENT_RUNTIME = 'virtual:pod/client-runtime';
const SERVER_ENTRY = 'virtual:pod/server-entry';
const ISOLATED_SERVER_MAX_OLD_SPACE_MIB = 144;

function podBuildFile(relativePath: string): string {
	const abs = path.resolve(import.meta.dirname, '..', relativePath);
	return abs.split(path.sep).join('/');
}

export interface PodPluginOptions {
	readonly outDir?: string;
	/** Non-JavaScript dependency sidecars required by the deployed server bundle. */
	readonly serverAssets?: readonly PodServerAsset[];
}

export interface PodServerAsset {
	/** Absolute build-time path to the source file. */
	readonly source: string;
	/** Artifact-relative path below `output/server` (defaults to the source basename). */
	readonly target?: string;
}

export async function copyPodServerAssets(
	serverOutDir: string,
	assets: readonly PodServerAsset[]
): Promise<void> {
	for (const asset of assets) {
		if (!path.isAbsolute(asset.source)) {
			throw new Error(`Pod server asset source must be absolute: ${asset.source}`);
		}
		const target = path.normalize(asset.target?.trim() || path.basename(asset.source));
		if (
			target === '.' ||
			path.isAbsolute(target) ||
			target === '..' ||
			target.startsWith(`..${path.sep}`)
		) {
			throw new Error(`Pod server asset target must stay below output/server: ${target}`);
		}
		const destination = path.join(serverOutDir, target);
		await mkdir(path.dirname(destination), { recursive: true });
		await copyFile(asset.source, destination);
	}
}

async function runIsolatedBuild(config: {
	readonly root: string;
	readonly configFile: string;
	readonly mode: string;
	readonly logLevel: string;
	readonly clearScreen: boolean;
}): Promise<void> {
	const worker = fileURLToPath(new URL('./isolated-build.js', import.meta.url));
	const inheritedEnvironment = {
		...process.env,
		NORBITAL_POD_BUILD_TARGET: 'server',
		NORBITAL_POD_ISOLATED_BUILD: '1'
	};
	const child = spawn(
		process.execPath,
		[`--max-old-space-size=${ISOLATED_SERVER_MAX_OLD_SPACE_MIB}`, worker, JSON.stringify(config)],
		{
			cwd: config.root,
			env: inheritedEnvironment,
			stdio: 'inherit'
		}
	);
	await new Promise<void>((resolve, reject) => {
		const forwardedSignals = ['SIGINT', 'SIGTERM'] as const;
		const signalHandlers = forwardedSignals.map(
			(signal) => [signal, () => child.kill(signal)] as const
		);
		for (const [signal, handler] of signalHandlers) process.once(signal, handler);
		const cleanup = () => {
			for (const [signal, handler] of signalHandlers) process.off(signal, handler);
		};
		child.once('error', (error) => {
			cleanup();
			reject(error);
		});
		child.once('exit', (code, signal) => {
			cleanup();
			if (code === 0) {
				resolve();
				return;
			}
			reject(
				new Error(
					`Isolated Pod server build ${signal ? `was terminated by ${signal}` : `exited with status ${code ?? 'unknown'}`}`
				)
			);
		});
	});
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

async function clientPlugins(): Promise<PluginOption[]> {
	const [{ svelte }, { default: tailwindcss }] = await Promise.all([
		import('@sveltejs/vite-plugin-svelte'),
		import('@tailwindcss/vite')
	]);
	return [
		...svelte({ configFile: false }).map((plugin) =>
			plugin.name === 'vite-plugin-svelte:config' ? plugin : clientOnlyPlugin(plugin)
		),
		...tailwindcss().map(clientOnlyPlugin)
	];
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

	async function prepareBuild(options: {
		readonly clearArtifacts: boolean;
		readonly generateMigrations: boolean;
	}): Promise<void> {
		if (buildArtifactsPrepared) return;
		buildArtifactsPrepared = true;
		if (process.env.NORBITAL_POD_SYNCED !== '1') {
			const compilation = await compilePodFilesystem({ root, mode: 'build' });
			if (!compilation.valid) {
				throw new Error(`Pod filesystem has ${compilation.diagnostics.length} structural error(s)`);
			}
		}
		if (process.env.NORBITAL_POD_CHECKED !== '1') {
			const { runSvelteCheck } = await import('./checker.js');
			await runSvelteCheck(root);
		}
		if (options.clearArtifacts) await rm(artifactRoot, { recursive: true, force: true });
		if (options.generateMigrations) {
			const { generatePodMigrations } = await import('./migrations.js');
			await generatePodMigrations({ root, migrationsRoot });
		}
	}

	async function finalizeArtifacts(): Promise<void> {
		if (!clientEntryFile) throw new Error('Pod client entry was not emitted');
		const [
			{ parseSeedManifest, seedManifestJson },
			{ parseNorbitalManifest },
			{ SCHEMA_FUNCTIONS_SQL, nonTemporalCollections, schemaPostDdlSql },
			{ workspaceExclusionsDdl }
		] = await Promise.all([
			import('@norbital-ai/platform-utils/seed/manifest'),
			import('@norbital-ai/platform-utils/manifest/parse'),
			import('./schema-functions-sql.js'),
			import('./workspace-exclusions-sql.js')
		]);
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
		// The runtime entry point. Two lines so the server bundle stays importable at build
		// time (below) without binding a socket. The boot is awaited at the top level, so a
		// runtime that cannot reach its host exits non-zero with the reason rather than
		// listening on a port that answers nothing.
		await writeFile(
			path.join(artifactRoot, SERVE_ENTRY_FILENAME),
			`import { startPodHttpServer } from './output/server/index.js';\nawait startPodHttpServer();\n`
		);
		await writeFile(path.join(clientDistRoot, 'package.json'), '{"type":"module"}\n');
		await mkdir(path.join(artifactRoot, 'output/server'), { recursive: true });
		await copyPodServerAssets(path.join(artifactRoot, 'output/server'), options.serverAssets ?? []);
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
		const manifest = parseNorbitalManifest(serverModule.workspaceManifest);
		await writeFile(
			path.join(artifactRoot, 'schema-post-ddl.sql'),
			`${schemaPostDdlSql(nonTemporalCollections(manifest))}\n\n${workspaceExclusionsDdl(manifest)}`
		);
	}

	const buildPlugin: Plugin = {
		name: 'norbital-pod-build',
		enforce: 'pre',
		applyToEnvironment: () => true,
		async config(_config, environment) {
			root = path.resolve(_config.root ?? process.cwd());
			const configuredBuildTarget = process.env.NORBITAL_POD_BUILD_TARGET;
			const isolatedBuildValue = process.env.NORBITAL_POD_ISOLATED_BUILD;
			const isolatedBuild = isolatedBuildValue === '1';
			if (isolatedBuildValue != null && !isolatedBuild) {
				throw new Error('Invalid internal NORBITAL_POD_ISOLATED_BUILD marker');
			}
			if (
				configuredBuildTarget != null &&
				configuredBuildTarget !== 'server' &&
				configuredBuildTarget !== 'client'
			) {
				throw new Error(`Invalid NORBITAL_POD_BUILD_TARGET: ${configuredBuildTarget}`);
			}
			if (isolatedBuild && configuredBuildTarget !== 'server') {
				throw new Error('Internal isolated Pod builds must target the server environment');
			}
			const configuredOutDir = options.outDir ?? process.env.NORBITAL_BUILD_OUT;
			const platformDirectory = process.env.NORBITAL_POD_PLATFORM_DIR?.trim();
			if (platformDirectory && configuredBuildTarget !== 'server') {
				const { readPodClientPlatformManifest } = await import('./platform.js');
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
			if (environment.command !== 'build' && process.env.NORBITAL_POD_SYNCED !== '1') {
				const compilation = await compilePodFilesystem({ root, mode });
				if (!compilation.valid) {
					throw new Error(
						`Pod filesystem has ${compilation.diagnostics.length} structural error(s)`
					);
				}
			}
			if (environment.command === 'build' && configuredBuildTarget != null) {
				await prepareBuild({
					clearArtifacts: configuredBuildTarget === 'server',
					generateMigrations: configuredBuildTarget === 'server' && isolatedBuild
				});
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
						if (configuredBuildTarget === 'server') {
							await builder.build(builder.environments.server);
							return;
						}
						if (configuredBuildTarget === 'client') {
							await builder.build(builder.environments.client);
							await finalizeArtifacts();
							return;
						}
						if (
							Object.values(builder.environments).some(
								(environment) => environment.config.build.watch
							)
						) {
							throw new Error(
								'Pod coordinated production builds do not support vite build --watch'
							);
						}
						const configFile = builder.config.configFile;
						if (configFile == null) {
							// Programmatic configFile:false builds cannot be reconstructed in a child.
							// Keep standalone SDK builds functional; production Vite config builds use
							// isolated processes so each Rolldown graph is released before the next one.
							await prepareBuild({ clearArtifacts: true, generateMigrations: true });
							await builder.build(builder.environments.server);
							await builder.build(builder.environments.client);
							await finalizeArtifacts();
							return;
						}
						const isolatedConfig = {
							root: builder.config.root,
							configFile,
							mode: builder.config.mode,
							logLevel: builder.config.logLevel ?? 'info',
							clearScreen: builder.config.clearScreen ?? true
						};
						await runIsolatedBuild(isolatedConfig);
						await builder.build(builder.environments.client);
						await finalizeArtifacts();
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
							minify: false,
							reportCompressedSize: false,
							sourcemap: false,
							ssr: true,
							rolldownOptions: {
								input: SERVER_ENTRY,
								external: (id: string) => id.startsWith('node:'),
								output: {
									format: 'esm',
									codeSplitting: true,
									entryFileNames: 'index.js',
									chunkFileNames: 'chunks/[name]-[hash].js'
								}
							}
						}
					},
					...(configuredBuildTarget === 'server'
						? {}
						: {
								client: {
									consumer: 'client' as const,
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
							})
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
				return podBuildFile('ui/state/client.js');
			}
			if (source === '$pod/client') return generatedClient;
		},
		load(id) {
			if (id === `\0${SERVER_ENTRY}`) {
				return `import workspace from ${JSON.stringify(generatedWorkspace.split(path.sep).join('/'))};
	import { handlePodHostCommand, handlePodRequest, registerPodWorkspace, registerPodDatabaseNotifications, registerPodHostPlugins, getTenantManifest } from ${JSON.stringify(podBuildFile('server/entry.js'))};
export { startPodHttpServer } from ${JSON.stringify(podBuildFile('serve/hosted.js'))};
registerPodWorkspace(workspace);
export const workspaceSeedManifest = workspace.seed?.manifest ?? null;
export const workspaceManifest = getTenantManifest();
	export { handlePodHostCommand, handlePodRequest, registerPodDatabaseNotifications, registerPodHostPlugins };`;
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
		...(process.env.NORBITAL_POD_BUILD_TARGET === 'server' ? [] : [clientPlugins()]),
		buildPlugin
	];
}
