import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { build, type Plugin } from 'vite';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { safeParse } from '@norbital-ai/std/json';
import {
	POD_CLIENT_PLATFORM_MANIFEST,
	type PodClientPlatformManifest
} from './platform-contract.js';

export { POD_CLIENT_PLATFORM_MANIFEST, type PodClientPlatformManifest };

const PACKAGE_KEY_PATTERN = /^[0-9a-f]{16}$/;
const VIRTUAL_PREFIX = '\0virtual:norbital-platform-entry:';
const platformPathSchema = z
	.string()
	.min(1)
	.refine((value) => !path.isAbsolute(value) && !value.split('/').includes('..'));
const REQUIRED_PLATFORM_IMPORTS = [
	'@norbital-ai/pod/client/platform',
	'@norbital-ai/pod/client/runtime',
	'svelte/internal/client'
] as const;
const podClientPlatformManifestSchema = z
	.object({
		format: z.literal('pod-client-platform-1'),
		packageKey: z.string().regex(PACKAGE_KEY_PATTERN),
		imports: z.record(z.string().min(1), platformPathSchema),
		stylesheets: z.array(platformPathSchema)
	})
	.superRefine((manifest, context) => {
		for (const specifier of REQUIRED_PLATFORM_IMPORTS) {
			if (manifest.imports[specifier] != null) continue;
			context.addIssue({
				code: 'custom',
				path: ['imports', specifier],
				message: `Missing required platform import: ${specifier}`
			});
		}
	});

interface PlatformEntry {
	readonly specifier: string;
	readonly source: string;
	readonly stylesheet?: string;
}

async function packageRoot(packageName: string, entrySpecifier = packageName): Promise<string> {
	let current = path.dirname(fileURLToPath(import.meta.resolve(entrySpecifier)));
	for (;;) {
		try {
			const source = await readFile(path.join(current, 'package.json'), 'utf8');
			const packageJson = safeParse(source);
			if (
				typeof packageJson === 'object' &&
				packageJson != null &&
				'name' in packageJson &&
				packageJson.name === packageName
			) {
				return current;
			}
		} catch (error) {
			if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
		}
		const parent = path.dirname(current);
		if (parent === current) throw new Error(`Could not locate package root for ${packageName}`);
		current = parent;
	}
}

async function uiBuildRoot(): Promise<string> {
	return path.join(await packageRoot('@norbital-ai/ui', '@norbital-ai/ui/layout'), 'build');
}

async function uiEntries(): Promise<PlatformEntry[]> {
	const root = await uiBuildRoot();
	const entries: PlatformEntry[] = [];
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const filePath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(filePath);
				continue;
			}
			if (entry.name !== 'index.js') continue;
			const relativeDirectory = path.relative(root, directory).split(path.sep).join('/');
			if (relativeDirectory) {
				entries.push({
					specifier: `@norbital-ai/ui/${relativeDirectory}`,
					source: filePath
				});
			}
		}
	};
	await visit(root);
	entries.push(
		{
			specifier: '@norbital-ai/ui/collection-table/navigation',
			source: path.join(root, 'collection-table/collection-table-navigation.svelte.js')
		},
		{
			specifier: '@norbital-ai/ui/utils/pixel-drag.js',
			source: path.join(root, 'utils/pixel-drag.js')
		}
	);
	return entries;
}

async function packageExportEntries(packageName: string): Promise<PlatformEntry[]> {
	const source = await readFile(path.join(await packageRoot(packageName), 'package.json'), 'utf8');
	const packageJson = safeParse(source);
	if (
		typeof packageJson !== 'object' ||
		packageJson == null ||
		!('exports' in packageJson) ||
		typeof packageJson.exports !== 'object' ||
		packageJson.exports == null
	) {
		throw new Error(`${packageName} package exports are missing`);
	}
	return Object.keys(packageJson.exports)
		.filter((subpath) => subpath !== './package.json' && !subpath.includes('*'))
		.map((subpath) => (subpath === '.' ? packageName : `${packageName}/${subpath.slice(2)}`))
		.map((specifier) => ({
			specifier,
			source: fileURLToPath(import.meta.resolve(specifier))
		}));
}

async function platformEntries(): Promise<PlatformEntry[]> {
	const podRoot = await packageRoot('@norbital-ai/pod', '@norbital-ai/pod/client/platform');
	const svelteRoot = await packageRoot('svelte', 'svelte/internal/client');
	return [
		{
			specifier: '@norbital-ai/pod/client/platform',
			source: path.join(podRoot, 'build/ui/shell/mount-client.js'),
			stylesheet: path.join(podRoot, 'build/app.css')
		},
		{
			specifier: '@norbital-ai/pod/client',
			source: path.join(podRoot, 'build/ui/public.js')
		},
		{
			specifier: '@norbital-ai/pod/client/runtime',
			source: path.join(podRoot, 'build/ui/state/client.js')
		},
		...(await uiEntries()),
		...(await packageExportEntries('@norbital-ai/std')),
		{ specifier: 'svelte', source: path.join(svelteRoot, 'src/index-client.js') },
		{
			specifier: 'svelte/internal/client',
			source: fileURLToPath(import.meta.resolve('svelte/internal/client'))
		},
		{ specifier: 'svelte-sonner', source: fileURLToPath(import.meta.resolve('svelte-sonner')) }
	].sort((left, right) => left.specifier.localeCompare(right.specifier));
}

export async function readPodClientPlatformManifest(
	directory: string
): Promise<PodClientPlatformManifest> {
	const manifestPath = path.join(directory, POD_CLIENT_PLATFORM_MANIFEST);
	const parsed = podClientPlatformManifestSchema.safeParse(
		safeParse(await readFile(manifestPath, 'utf8'))
	);
	if (!parsed.success) {
		throw new Error(
			`Invalid Pod client platform manifest at ${manifestPath}: ${parsed.error.message}`
		);
	}
	if (parsed.data.stylesheets.length === 0) {
		throw new Error(`Pod client platform manifest has no stylesheet at ${manifestPath}`);
	}
	return parsed.data;
}

function platformManifestPlugin(
	packageKey: string,
	entries: readonly PlatformEntry[],
	uiRoot: string
): { input: Record<string, string>; plugin: Plugin } {
	const entryByVirtualId = new Map<string, PlatformEntry>();
	const input: Record<string, string> = {};
	for (const [index, entry] of entries.entries()) {
		const id = `${VIRTUAL_PREFIX}${index}`;
		entryByVirtualId.set(id, entry);
		input[`entry-${index}`] = id;
	}
	const plugin: Plugin = {
		name: 'norbital-pod-client-platform',
		enforce: 'pre',
		buildStart() {
			if (!this.meta.rolldownVersion) {
				throw new Error('Pod client platform builds require Vite 8 with Rust-backed Rolldown');
			}
		},
		resolveId(source, importer) {
			if (entryByVirtualId.has(source)) return source;
			if (source.startsWith('#lib/') && importer?.startsWith(uiRoot)) {
				const subpath = source.slice('#lib/'.length);
				if (subpath === 'utils') return path.join(uiRoot, 'utils/index.js');
				if (subpath.startsWith('utils/')) {
					return path.join(uiRoot, `${subpath}${subpath.endsWith('.js') ? '' : '.js'}`);
				}
				return path.join(uiRoot, subpath, 'index.js');
			}
		},
		load(id) {
			const entry = entryByVirtualId.get(id);
			if (entry) {
				const stylesheet = entry.stylesheet ? `import ${JSON.stringify(entry.stylesheet)};` : '';
				return `${stylesheet}export * from ${JSON.stringify(entry.source)};`;
			}
		},
		generateBundle(_options, bundle) {
			const imports: Record<string, string> = {};
			const stylesheets: string[] = [];
			for (const output of Object.values(bundle)) {
				if (output.type === 'asset' && output.fileName.endsWith('.css')) {
					stylesheets.push(output.fileName);
					continue;
				}
				if (output.type !== 'chunk' || !output.isEntry || !output.facadeModuleId) continue;
				const entry = entryByVirtualId.get(output.facadeModuleId);
				if (entry) imports[entry.specifier] = output.fileName;
			}
			if (Object.keys(imports).length !== entries.length) {
				const missing = entries
					.map((entry) => entry.specifier)
					.filter((specifier) => imports[specifier] == null);
				throw new Error(`Pod client platform entries were not emitted: ${missing.join(', ')}`);
			}
			const manifest: PodClientPlatformManifest = {
				format: 'pod-client-platform-1',
				packageKey,
				imports,
				stylesheets: stylesheets.sort()
			};
			this.emitFile({
				type: 'asset',
				fileName: POD_CLIENT_PLATFORM_MANIFEST,
				source: `${JSON.stringify(manifest, null, 2)}\n`
			});
		}
	};
	return { input, plugin };
}

export async function buildPodClientPlatform(input: {
	readonly outDir: string;
	readonly packageKey: string;
}): Promise<void> {
	if (!PACKAGE_KEY_PATTERN.test(input.packageKey)) {
		throw new Error(`Invalid Pod client platform package key: ${input.packageKey}`);
	}
	const entries = await platformEntries();
	const platform = platformManifestPlugin(input.packageKey, entries, await uiBuildRoot());
	const outputDirectory = path.resolve(input.outDir);
	await build({
		root: process.cwd(),
		configFile: false,
		base: './',
		plugins: [...svelte({ configFile: false }), ...tailwindcss(), platform.plugin],
		build: {
			outDir: outputDirectory,
			emptyOutDir: true,
			copyPublicDir: false,
			cssCodeSplit: false,
			minify: 'oxc',
			reportCompressedSize: false,
			sourcemap: false,
			rolldownOptions: {
				input: platform.input,
				preserveEntrySignatures: 'strict',
				experimental: { chunkOptimization: false, lazyBarrel: false },
				output: {
					entryFileNames: 'entries/[name]-[hash].js',
					chunkFileNames: 'chunks/[name]-[hash].js',
					assetFileNames: 'assets/[name]-[hash][extname]'
				}
			}
		}
	});
	const manifestPath = path.join(outputDirectory, POD_CLIENT_PLATFORM_MANIFEST);
	const parsed = podClientPlatformManifestSchema.safeParse(
		safeParse(await readFile(manifestPath, 'utf8'))
	);
	if (!parsed.success) {
		throw new Error(`Invalid generated Pod client platform manifest: ${parsed.error.message}`);
	}
	const stylesheets = (await readdir(outputDirectory, { recursive: true }))
		.filter((file) => file.endsWith('.css'))
		.map((file) => file.split(path.sep).join('/'))
		.sort();
	if (stylesheets.length === 0) {
		throw new Error('Pod client platform build did not emit a stylesheet');
	}
	await writeFile(manifestPath, `${JSON.stringify({ ...parsed.data, stylesheets }, null, 2)}\n`);
}
