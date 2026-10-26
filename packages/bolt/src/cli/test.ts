/// <reference types="node" />
import { Effect, FileSystem, Schema } from 'effect';
import { realpathSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Plugin, PluginOption, UserConfig } from 'vite';
import type {} from 'vitest/config';
import { EDITOR_SINGLETONS } from '../compiler/editor-dependencies.ts';
import { AuthorErrors, ToolFailure } from './build.ts';

/** This copy of the kit (src or build), so `/test`, `/test/browser` and pages' `$bolt` share one shell and one page SDK. */
const own = (path: string) =>
	join(
		dirname(fileURLToPath(import.meta.url)),
		'..',
		`${path}${extname(fileURLToPath(import.meta.url))}`
	);
// half the cores: a worker runs its isolates, PGlite and Vite transforms on more than one thread, and the CPU budgets
// suites assert are measured per thread, so an oversubscribed machine (or one spilling onto slower cores) fails them.
// A worker holds up to about 2 GiB (a large template's PGlite plus its isolates), so memory bounds the pool too.
const positiveInteger = (name: string, fallback: number): number => {
	const value = Number(process.env[name] ?? fallback);
	if (!Number.isSafeInteger(value) || value < 1)
		throw new Error(`${name} must be a positive integer`);
	return value;
};
const templateWorkers = positiveInteger(
	'BOLT_TEST_WORKERS',
	Math.max(1, Math.min(Math.floor(availableParallelism() / 2), Math.floor(totalmem() / 2 ** 31)))
);
export const workers = Math.min(
	templateWorkers,
	positiveInteger('VITEST_MAX_WORKERS', templateWorkers)
);

type Runner = Pick<typeof import('vitest/node'), 'parseCLI' | 'startVitest'>;
const Runner = Schema.declare<Runner>(
	(input): input is Runner =>
		typeof input === 'object' &&
		input !== null &&
		'parseCLI' in input &&
		typeof input.parseCLI === 'function' &&
		'startVitest' in input &&
		typeof input.startVitest === 'function'
);
type Svelte = typeof import('@sveltejs/vite-plugin-svelte').svelte;
/** Vitest as `from` (a package.json or module) resolves it, and the Svelte compiler. */
const load = Effect.fnUntraced(function* (from: string) {
	const runner = yield* Effect.tryPromise({
		try: (): Promise<unknown> =>
			import(pathToFileURL(createRequire(from).resolve('vitest/node')).href),
		catch: (cause) => new ToolFailure({ message: 'bolt test: vitest is not installed', cause })
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Runner)),
		Effect.mapError((cause) =>
			cause instanceof ToolFailure
				? cause
				: new ToolFailure({ message: 'The workspace Vitest entry is invalid.', cause })
		)
	);
	const { svelte } = yield* Effect.tryPromise({
		try: () => import('@sveltejs/vite-plugin-svelte'),
		catch: (cause) => new ToolFailure({ message: 'The Svelte compiler could not load.', cause })
	});
	return { runner, svelte };
});
/** The kit's plugins for one Vite server: Svelte keeps per-server state, so each project gets its own. */
const plugins = (svelte: Svelte, options: { runCache: string }): Plugin[] => {
	const theirs = (config: UserConfig) => {
		const found = (plugin: PluginOption): boolean =>
			Array.isArray(plugin)
				? plugin.some(found)
				: typeof plugin === 'object' &&
					plugin !== null &&
					!(plugin instanceof Promise) &&
					'name' in plugin &&
					plugin.name === 'vite-plugin-svelte' &&
					!mine.includes(plugin);
		return (config.plugins ?? []).some(found);
	};
	// template pages compile in Svelte's async mode (`await` in markup), as the client build compiles them
	const mine: Plugin[] = svelte({ compilerOptions: { experimental: { async: true } } }).map(
		(plugin) => ({
			...plugin,
			apply: (config, environment) =>
				!theirs(config) &&
				(plugin.apply === undefined ||
					(typeof plugin.apply === 'function'
						? plugin.apply(config, environment)
						: plugin.apply === environment.command))
		})
	);
	const kit: Plugin = {
		name: 'bolt:test',
		config(config) {
			const setup = (config.test ??= {});
			// a hung suite fails fast: the slowest legitimate case is well under a minute
			setup.testTimeout ??= 60_000;
			setup.hookTimeout ??= 30_000;
			// `BOLT_TEST_BAIL=1` stops at the first failure (and at the first file that cannot be collected)
			if (process.env['BOLT_TEST_BAIL'] === '1') setup.bail ??= 1;
			// files run in parallel, each in its own process with its own workspace and database
			setup.fileParallelism ??= true;
			setup.maxWorkers ??= workers;
			setup.env = { ...setup.env, BOLT_TEST_RUN_CACHE: options.runCache };
			const node = setup.browser?.enabled !== true;
			if (node) {
				setup.pool ??= 'forks';
				if (setup.pool === 'forks')
					setup.execArgv = [...new Set([...(setup.execArgv ?? []), '--no-node-snapshot'])];
			}
			setup.setupFiles = [...new Set([own('test/dom'), ...[setup.setupFiles ?? []].flat()])];
			((config.server ??= {}).fs ??= {}).strict ??= false;
			if (setup.projects !== undefined)
				setup.projects = setup.projects.map((project) =>
					typeof project === 'string' && !/[*?{[]/.test(project) && /\.[cm]?[jt]s$/.test(project)
						? { extends: project, plugins: [...mine, kit] }
						: typeof project === 'object' && project !== null && !(project instanceof Promise)
							? { ...project, plugins: [...(project.plugins ?? []), ...mine, kit] }
							: project
				);
			return {
				resolve: {
					dedupe: [
						'@iconify/svelte',
						'effect',
						'@effect/vitest',
						'vitest',
						'@effect/platform-node',
						'@effect/platform-node-shared',
						...EDITOR_SINGLETONS
					],
					alias: [
						{
							find: /^@norbital-ai\/bolt\/test\/browser$/,
							replacement: own('test/browser')
						},
						{ find: /^@norbital-ai\/bolt\/test$/, replacement: own('test/index') },
						{ find: /^\$bolt$/, replacement: own('page/index') }
					],
					conditions: ['svelte', 'browser']
				}
			};
		}
	};
	return [...mine, kit];
};
/**
 * `bolt test`: the workspace's vitest, in process, with the kit preconfigured: the type setup written, svelte compiled,
 * `@norbital-ai/bolt/test(/browser)` and `$bolt` on the kit's copy, DOM environments resolving the browser builds, and
 * the kit's timeouts. The workspace's own vitest config still loads, and wins where it sets a value. Chromium is Vitest
 * browser mode (`@vitest/browser-playwright`, `page` from `vitest/browser`) — https://vitest.dev/guide/browser/ — not
 * a kit launcher.
 */
export const testWorkspace = Effect.fn('bolt.test')(function* (
	dir: string,
	args: readonly string[]
) {
	const root = yield* Effect.try({
		try: () => realpathSync(dir),
		catch: (cause) => new ToolFailure({ message: 'The workspace directory could not open.', cause })
	});
	const { runner, svelte } = yield* load(join(root, 'package.json'));
	process.chdir(root);
	const { filter, options } = runner.parseCLI(['vitest', 'run', ...args]);
	// one directory per run: the test files' processes share each workspace's check through it (`runChecked` in
	// test/effect)
	const fs = yield* FileSystem.FileSystem;
	const runCache = yield* fs
		.makeTempDirectory({ prefix: 'bolt-test-run-' })
		.pipe(
			Effect.mapError(
				(cause) => new ToolFailure({ message: 'bolt test: no temporary directory', cause })
			)
		);
	yield* Effect.tryPromise({
		try: () =>
			runner.startVitest(
				'test',
				filter,
				{ ...options, root },
				{
					plugins: plugins(svelte, { runCache })
				}
			),
		catch: (cause) => new ToolFailure({ message: 'The workspace test runner failed.', cause })
	}).pipe(
		Effect.ensuring(fs.remove(runCache, { recursive: true, force: true }).pipe(Effect.ignore))
	);
	const code = Number(process.exitCode ?? 0);
	process.exitCode = 0;
	if (code === 0) return;
	return yield* Effect.fail(
		code === 1
			? new AuthorErrors({ message: 'The workspace tests failed.', errors: [] })
			: new ToolFailure({ message: 'The workspace test runner failed.' })
	);
});
