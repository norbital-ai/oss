#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import type { CheckerDiagnostic } from '../../vite/checker.js';
import type { compilePodFilesystem as CompilePodFilesystem } from '../../vite/compiler/index.js';

const usage =
	'Usage: pod sync [--watch] | pod check | pod build | pod migration create <name> [--custom] | pod migrate | pod seed | pod start | pod dev [--seed] | pod platform build <out-dir> <package-key>';

type CompilationResult = Awaited<ReturnType<typeof CompilePodFilesystem>>;

function printCompilation(result: CompilationResult): number {
	if (!result.valid) {
		for (const diagnostic of result.diagnostics) {
			console.error(
				`${diagnostic.file}:${diagnostic.start.line}:${diagnostic.start.column} [${diagnostic.code}] ${diagnostic.message}`
			);
		}
		console.error(
			`Pod synchronization failed with ${result.diagnostics.length} structural error(s).`
		);
		return 1;
	}
	console.log(`Pod synchronized (${result.written.length} file(s) updated).`);
	return 0;
}

function printCheckDiagnostics(diagnostics: readonly CheckerDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		console.error(
			`${diagnostic.file}:${diagnostic.start.line}:${diagnostic.start.column} [${diagnostic.code}] ${diagnostic.message}`
		);
	}
}

async function checkPod(root: string): Promise<number> {
	const { checkPodWorkspace } = await import('../../vite/checker.js');
	const result = await checkPodWorkspace(root, { mode: 'build' });
	if (!result.valid) {
		printCheckDiagnostics(result.diagnostics);
		console.error(`Pod check failed with ${result.diagnostics.length} error(s).`);
		return 1;
	}
	console.log('Pod check completed (0 errors).');
	return 0;
}

async function buildStandalone(root: string): Promise<number> {
	const { createBuilder } = await import('vite');
	const { pod } = await import('../../vite/index.js');
	const { standaloneBuildDirectory } = await import('./standalone.js');
	const builder = await createBuilder({
		root,
		configFile: false,
		plugins: [pod({ outDir: standaloneBuildDirectory(root) })]
	});
	await builder.buildApp();
	console.log('Pod standalone build completed.');
	return 0;
}

async function buildClientPlatform(outDir: string, packageKey: string): Promise<number> {
	const { buildPodClientPlatform } = await import('../../vite/platform.js');
	await buildPodClientPlatform({ outDir, packageKey });
	console.log(`Pod client platform completed (${packageKey}).`);
	return 0;
}

async function migrate(root: string): Promise<number> {
	const { loadStandaloneEnvironment, migrateStandalone } = await import('./standalone.js');
	await migrateStandalone(root, loadStandaloneEnvironment());
	console.log('Pod migrations applied.');
	return 0;
}

async function createMigration(root: string, name: string, custom: boolean): Promise<number> {
	if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
		console.error('Migration name must contain only letters, numbers, hyphens, and underscores.');
		return 1;
	}
	const { compilePodFilesystem } = await import('../../vite/compiler/index.js');
	const compilation = await compilePodFilesystem({ root, mode: 'authoring' });
	const code = printCompilation(compilation);
	if (code !== 0) return code;
	const { generatePodMigrations } = await import('../../vite/migrations.js');
	const path = await import('node:path');
	await generatePodMigrations({
		root,
		migrationsRoot: path.join(root, '.norbital', 'migrations'),
		name,
		custom
	});
	console.log(`Pod ${custom ? 'data' : 'schema'} migration created in .norbital/migrations.`);
	return 0;
}

async function seed(root: string): Promise<number> {
	const { loadStandaloneEnvironment, seedStandalone } = await import('./standalone.js');
	await seedStandalone(root, loadStandaloneEnvironment());
	return 0;
}

async function start(root: string): Promise<number> {
	const { loadStandaloneEnvironment, startStandalone } = await import('./standalone.js');
	await startStandalone(root, loadStandaloneEnvironment());
	return 0;
}

async function develop(root: string, runSeed: boolean): Promise<number> {
	await buildStandalone(root);
	const { loadStandaloneEnvironment, migrateStandalone, seedStandalone, startStandalone } =
		await import('./standalone.js');
	const environment = loadStandaloneEnvironment();
	await migrateStandalone(root, environment);
	if (runSeed) await seedStandalone(root, environment);
	await startStandalone(root, environment);
	return 0;
}

async function watchPodFilesystem(root: string): Promise<number> {
	const { compilePodFilesystem } = await import('../../vite/compiler/index.js');
	const { checkPodWorkspace } = await import('../../vite/checker.js');
	let revision = 0;
	let running = false;
	let dirty = false;
	let timer: NodeJS.Timeout | undefined;
	const synchronize = async () => {
		if (running) return;
		running = true;
		dirty = false;
		const targetRevision = revision;
		try {
			const compilation = await compilePodFilesystem({
				root,
				mode: 'authoring',
				revision: targetRevision
			});
			printCompilation(compilation);
			if (compilation.valid) {
				const check = await checkPodWorkspace(root, {
					mode: 'authoring',
					revision: targetRevision,
					isCurrent: () => revision === targetRevision
				});
				if (check.published && check.changed) {
					const summary = `Pod check completed (${check.diagnostics.length} error(s)).`;
					if (check.valid) console.log(summary);
					else console.error(summary);
				}
			}
		} catch (error) {
			console.error(error instanceof Error ? error.message : error);
		} finally {
			running = false;
			if (dirty) queue();
		}
	};
	const queue = () => {
		revision += 1;
		dirty = true;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => void synchronize(), 400);
	};
	await synchronize();
	const server = await createServer({
		root,
		configFile: false,
		appType: 'custom',
		server: {
			middlewareMode: true,
			watch: {
				ignored: [
					'**/.norbital/**',
					'**/.svelte-check/**',
					'**/dist/**',
					'**/node_modules/**',
					'**/.git/**'
				]
			}
		}
	});
	server.watcher.on('all', queue);
	await new Promise<void>((resolve) => {
		process.once('SIGINT', resolve);
		process.once('SIGTERM', resolve);
	});
	if (timer) clearTimeout(timer);
	await server.close();
	return 0;
}

export async function runPodCli(
	args: readonly string[] = process.argv.slice(2),
	root = process.cwd()
): Promise<number> {
	if (args[0] === 'check' && args.length === 1) return checkPod(root);
	if (args[0] === 'build' && args.length === 1) return buildStandalone(root);
	if (args[0] === 'platform' && args[1] === 'build' && args.length === 4) {
		return buildClientPlatform(args[2], args[3]);
	}
	if (args[0] === 'migrate' && args.length === 1) return migrate(root);
	if (
		args[0] === 'migration' &&
		args[1] === 'create' &&
		args[2] &&
		(args.length === 3 || (args.length === 4 && args[3] === '--custom'))
	) {
		return createMigration(root, args[2], args[3] === '--custom');
	}
	if (args[0] === 'seed' && args.length === 1) return seed(root);
	if (args[0] === 'start' && args.length === 1) return start(root);
	if (args[0] === 'dev' && (args.length === 1 || (args.length === 2 && args[1] === '--seed'))) {
		return develop(root, args[1] === '--seed');
	}
	if (args[0] !== 'sync' || args.length > 2 || (args.length === 2 && args[1] !== '--watch')) {
		console.error(usage);
		return 1;
	}
	if (args[1] === '--watch') return watchPodFilesystem(root);
	const { compilePodFilesystem } = await import('../../vite/compiler/index.js');
	const compilation = await compilePodFilesystem({ root, mode: 'authoring' });
	const code = printCompilation(compilation);
	if (code !== 0) return code;
	const { generatePodMigrations } = await import('../../vite/migrations.js');
	const path = await import('node:path');
	await generatePodMigrations({
		root,
		migrationsRoot: path.join(root, '.norbital', 'migrations')
	});
	return 0;
}

if (process.argv[1] != null && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	runPodCli().then(
		(code) => {
			process.exitCode = code;
		},
		(error: unknown) => {
			console.error(error instanceof Error ? error.message : error);
			process.exitCode = 1;
		}
	);
}
