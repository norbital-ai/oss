/// <reference types="node" />
import { Effect, Predicate, Schema } from 'effect';
import { realpathSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Plugin, PluginOption, UserConfig } from 'vite';
import type {} from 'vitest/config';
import { EDITOR_SINGLETONS } from '../compiler/editor-dependencies.ts';
import { BOLT, EXT } from '../compiler/bolt.ts';
import { lintTests } from '../test/lint.ts';
import { AuthorErrors, ToolFailure } from './build.ts';

/** This copy of the kit (src or build), so `/test` and `/test/browser` share one shell and one page SDK with `$bolt`. */
const own = (path: string) => join(dirname(fileURLToPath(import.meta.url)), '..', `${path}${EXT}`);
/** One worker per core but one: the realm runner passes its share with `--maxWorkers`. */
export const workers = Math.max(1, availableParallelism() - 1);

type Runner = Pick<typeof import('vitest/node'), 'parseCLI' | 'startVitest'>;
const Runner = Schema.declare<Runner>(
	(input): input is Runner =>
		Predicate.isObject(input) &&
		Predicate.isFunction(input['parseCLI']) &&
		Predicate.isFunction(input['startVitest'])
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
const plugins = (svelte: Svelte): Plugin[] => {
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
			// the realm's rules for every suite: forks, no per-file isolation, a minute's hang guard,
			// and every failure reported
			setup.testTimeout = 60_000;
			setup.hookTimeout = 60_000;
			delete setup.bail;
			// real-browser tests live only in Bolt's own suite
			delete setup.browser;
			setup.fileParallelism = true;
			// the module cache is the workspace's own, never a parent directory's: suites run side by side
			setup.fsModuleCachePath ??= join(process.cwd(), 'node_modules', '.vitest-cache');
			// a template with no mechanisms of its own (blank) has nothing to prove
			setup.passWithNoTests = true;
			setup.maxWorkers ??= workers;
			setup.pool = 'forks';
			setup.isolate = false;
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
							find: /^@norbital-ai\/bolt-cli\/test\/browser$/,
							replacement: own('test/browser')
						},
						{ find: /^@norbital-ai\/bolt-cli\/test$/, replacement: own('test/index') },
						{ find: /^\$bolt$/, replacement: join(BOLT, 'page', `index${EXT}`) }
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
 * `@norbital-ai/bolt-cli/test(/browser)` on the kit's copy and `$bolt` on its Bolt's, DOM environments resolving the browser builds, and
 * the realm's pool, hang guard and test lint. The workspace's own vitest config still loads, and wins
 * elsewhere. No real browser: those tests live only in Bolt's own suite.
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
	// the test lint first, but the suite still runs: every failure is reported
	const lint = yield* lintTests(root, { template: true }).pipe(
		Effect.mapError(
			(cause) => new ToolFailure({ message: 'bolt test: the test lint failed.', cause })
		)
	);
	yield* Effect.tryPromise({
		try: () =>
			runner.startVitest(
				'test',
				filter,
				{ ...options, root },
				{
					plugins: plugins(svelte)
				}
			),
		catch: (cause) => new ToolFailure({ message: 'The workspace test runner failed.', cause })
	});
	const code = Number(process.exitCode ?? 0);
	process.exitCode = 0;
	if (lint.length > 0)
		return yield* new AuthorErrors({
			message: `The workspace tests break the test lint:\n${lint.map((line) => `  ${line}`).join('\n')}`,
			errors: []
		});
	if (code === 0) return;
	return yield* Effect.fail(
		code === 1
			? new AuthorErrors({ message: 'The workspace tests failed.', errors: [] })
			: new ToolFailure({ message: 'The workspace test runner failed.' })
	);
});
