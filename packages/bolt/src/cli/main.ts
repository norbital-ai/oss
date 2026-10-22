#!/usr/bin/env -S node --no-node-snapshot
/// <reference types="node" />
import { Effect, Console, FileSystem, Option, Schema } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Plugin, PluginOption, UserConfig } from 'vite';
import type {} from 'vitest/config';
import { check, type CheckDiagnostic } from '../compiler/check/index.ts';
import { writeTypeSetup } from '../compiler/names.ts';
import { EDITOR_SINGLETONS } from '../compiler/editor-dependencies.ts';
import { dev } from './dev.ts';
import { templatesCommand } from './templates.ts';
import { AuthorErrors, buildWorkspace, types, ToolFailure, type Log } from './build.ts';

/** This copy of the kit (src or build), so `/test`, `/test/browser` and pages' `$bolt` share one shell and one page SDK. */
const own = (path: string) =>
	join(
		dirname(fileURLToPath(import.meta.url)),
		'..',
		`${path}${extname(fileURLToPath(import.meta.url))}`
	);

/**
 * `bolt test`: the workspace's vitest, in process, with the kit preconfigured: the type setup written, svelte compiled,
 * `@norbital-ai/bolt/test(/browser)` and `$bolt` on this copy, DOM environments resolving the browser builds, and the
 * kit's timeouts. The workspace's own vitest config still loads, and wins where it sets a value. Chromium is Vitest
 * browser mode (`@vitest/browser-playwright`, `page` from `vitest/browser`) — https://vitest.dev/guide/browser/ — not
 * a kit launcher.
 */
const Runner = Schema.declare<Pick<typeof import('vitest/node'), 'parseCLI' | 'startVitest'>>(
	(input): input is Pick<typeof import('vitest/node'), 'parseCLI' | 'startVitest'> =>
		typeof input === 'object' &&
		input !== null &&
		'parseCLI' in input &&
		typeof input.parseCLI === 'function' &&
		'startVitest' in input &&
		typeof input.startVitest === 'function'
);
const test = Effect.fn('bolt.test')(function* (dir: string, args: readonly string[]) {
	const root = yield* Effect.try({
		try: () => realpathSync(dir),
		catch: (cause) => new ToolFailure({ message: 'The workspace directory could not open.', cause })
	});
	const runner = yield* Effect.tryPromise({
		try: () =>
			import(pathToFileURL(createRequire(join(root, 'package.json')).resolve('vitest/node')).href),
		catch: (cause) => new ToolFailure({ message: 'bolt test: vitest is not installed', cause })
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Runner)),
		Effect.mapError((cause) =>
			cause instanceof ToolFailure
				? cause
				: new ToolFailure({ message: 'The workspace Vitest entry is invalid.', cause })
		)
	);
	process.chdir(root);
	const { svelte } = yield* Effect.tryPromise({
		try: () => import('@sveltejs/vite-plugin-svelte'),
		catch: (cause) => new ToolFailure({ message: 'The Svelte compiler could not load.', cause })
	});
	const { filter, options } = runner.parseCLI(['vitest', 'run', ...args]);
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
	const mine: Plugin[] = svelte().map((plugin) => ({
		...plugin,
		apply: (config, environment) =>
			!theirs(config) &&
			(plugin.apply === undefined ||
				(typeof plugin.apply === 'function'
					? plugin.apply(config, environment)
					: plugin.apply === environment.command))
	}));
	// one directory per run: the test files' processes share the workspace check through it (`runChecked` in test/effect)
	const fs = yield* FileSystem.FileSystem;
	const runCache = yield* fs
		.makeTempDirectory({ prefix: 'bolt-test-run-' })
		.pipe(
			Effect.mapError(
				(cause) => new ToolFailure({ message: 'bolt test: no temporary directory', cause })
			)
		);
	const kit: Plugin = {
		name: 'bolt:test',
		config(config) {
			const setup = (config.test ??= {});
			setup.testTimeout ??= 180_000;
			setup.hookTimeout ??= 60_000;
			setup.fileParallelism ??= false;
			setup.env = { ...setup.env, BOLT_TEST_RUN_CACHE: runCache };
			if (setup.browser?.enabled !== true) {
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
						{ find: /^@norbital-ai\/bolt\/test\/browser$/, replacement: own('test/browser') },
						{ find: /^@norbital-ai\/bolt\/test$/, replacement: own('test/index') },
						{ find: /^\$bolt$/, replacement: own('page/index') }
					],
					conditions: ['svelte', 'browser']
				}
			};
		}
	};
	yield* Effect.tryPromise({
		try: () =>
			runner.startVitest('test', filter, { ...options, root }, { plugins: [...mine, kit] }),
		catch: (cause) => new ToolFailure({ message: 'The workspace test runner failed.', cause })
	}).pipe(
		Effect.ensuring(fs.remove(runCache, { recursive: true, force: true }).pipe(Effect.ignore))
	);
	const code = Number(process.exitCode ?? 0);
	process.exitCode = 0;
	return code === 0 ? 0 : code === 1 ? 1 : 2;
});

const print = (errors: readonly CheckDiagnostic[]) =>
	Effect.forEach(errors, (error) =>
		Console.error(
			`${error.code} ${error.message}${error.help === undefined ? '' : `\n${error.help}`}`
		)
	).pipe(Effect.andThen(Console.error(`${errors.length} errors`)));
const dir = Argument.string('dir').pipe(Argument.withDefault('.'));
const bank = Flag.string('bank').pipe(Flag.optional);
const log: Log = (line) => console.log(line);
const checkCommand = Command.make('check', { dir }, ({ dir }) =>
	Effect.gen(function* () {
		const result = yield* check(resolve(dir));
		const errors = [
			...result.errors,
			...(result.manifest === undefined ? [] : yield* types(resolve(dir)))
		];
		if (errors.length > 0)
			return yield* Effect.fail(new AuthorErrors({ errors, message: `${errors.length} errors` }));
		yield* Console.log(`ok (${result.stages.join(' → ')} → types)`);
	})
);
const buildCommand = Command.make(
	'build',
	{
		dir,
		bank,
		json: Flag.boolean('json').pipe(Flag.withDefault(false)),
		preview: Flag.boolean('preview').pipe(Flag.withDefault(false)),
		checked: Flag.boolean('checked').pipe(
			Flag.withDescription(
				"source its repository's CI already checked: build the type index, skip the checks"
			),
			Flag.withDefault(false)
		)
	},
	({ dir, bank, json, preview, checked }) =>
		buildWorkspace(resolve(dir), {
			...(Option.isNone(bank) ? {} : { bank: bank.value }),
			preview,
			checked,
			log
		}).pipe(
			Effect.catchTag('AuthorErrors', (error) =>
				json
					? print(error.errors).pipe(
							Effect.andThen(Console.error(JSON.stringify({ errors: error.errors }))),
							Effect.andThen(Effect.fail(error))
						)
					: Effect.fail(error)
			)
		)
);
const devCommand = Command.make(
	'dev',
	{
		dir,
		bank,
		port: Flag.integer('port').pipe(Flag.withDefault(5180)),
		seed: Flag.string('seed').pipe(Flag.withDefault('base')),
		founder: Flag.string('founder').pipe(Flag.optional),
		db: Flag.string('db').pipe(Flag.optional)
	},
	(options) =>
		Effect.scoped(
			dev(resolve(options.dir), {
				port: options.port,
				seed: options.seed,
				...(Option.isNone(options.bank) ? {} : { bank: options.bank.value }),
				...(Option.isNone(options.founder) ? {} : { founder: options.founder.value }),
				...(Option.isNone(options.db) ? {} : { db: options.db.value }),
				log
			}).pipe(Effect.andThen(Effect.never))
		)
);
const testCommand = Command.make(
	'test',
	{ dir, args: Argument.variadic(Argument.string('args')) },
	({ dir, args }) =>
		Effect.gen(function* () {
			yield* writeTypeSetup(resolve(dir));
			const code = yield* test(resolve(dir), args);
			if (code === 0) return;
			return yield* Effect.fail(
				code === 1
					? new AuthorErrors({ message: 'The workspace tests failed.', errors: [] })
					: new ToolFailure({ message: 'The workspace test runner failed.' })
			);
		})
);
const ServerModule = Schema.declare<Pick<typeof import('@norbital-ai/bolt-server'), 'main'>>(
	(input): input is Pick<typeof import('@norbital-ai/bolt-server'), 'main'> =>
		typeof input === 'object' &&
		input !== null &&
		'main' in input &&
		typeof input.main === 'function'
);
const startCommand = Command.make(
	'start',
	{
		port: Flag.integer('port').pipe(Flag.optional),
		args: Argument.variadic(Argument.string('args')),
		seed: Flag.string('seed').pipe(Flag.optional),
		founder: Flag.string('founder').pipe(Flag.optional),
		trustProxy: Flag.string('trust-proxy').pipe(Flag.optional),
		accept: Flag.boolean('accept').pipe(Flag.withDefault(false)),
		dev: Flag.boolean('dev').pipe(Flag.withDefault(false))
	},
	(options) =>
		Effect.gen(function* () {
			const server = yield* Effect.tryPromise({
				try: () =>
					import(
						pathToFileURL(
							createRequire(join(process.cwd(), 'package.json')).resolve('@norbital-ai/bolt-server')
						).href
					),
				catch: (cause) =>
					new ToolFailure({ message: '@norbital-ai/bolt-server is not installed', cause })
			}).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(ServerModule)),
				Effect.mapError((cause) =>
					cause instanceof ToolFailure
						? cause
						: new ToolFailure({ message: 'The Bolt server entry is invalid.', cause })
				)
			);
			const argv = [
				...(Option.isNone(options.port) ? [] : [`--port=${options.port.value}`]),
				...(Option.isNone(options.seed) ? [] : [`--seed=${options.seed.value}`]),
				...(Option.isNone(options.founder) ? [] : [`--founder=${options.founder.value}`]),
				...(Option.isNone(options.trustProxy) ? [] : [`--trust-proxy=${options.trustProxy.value}`]),
				...(options.accept ? ['--accept'] : []),
				...(options.dev ? ['--dev'] : []),
				...options.args
			];
			const code = yield* server.main(argv);
			if (code !== 0)
				return yield* Effect.fail(new ToolFailure({ message: `bolt start exited ${code}` }));
		})
);
export const boltCommand = Command.make('bolt').pipe(
	Command.withSubcommands([
		devCommand,
		checkCommand,
		buildCommand,
		testCommand,
		startCommand,
		templatesCommand
	])
);
export const main = (argv: readonly string[]) =>
	Command.runWith(boltCommand, { version: '1.0.0' })(
		argv[0] === 'test' && argv[1] === '--' ? ['test', '.', ...argv.slice(1)] : argv
	).pipe(
		Effect.as(0),
		Effect.catchTag('AuthorErrors', (error) => print(error.errors).pipe(Effect.as(1))),
		Effect.catch((error) => Console.error(error).pipe(Effect.as(2)))
	);
if (
	process.argv[1] !== undefined &&
	realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
	NodeRuntime.runMain(
		main(process.argv.slice(2)).pipe(
			Effect.tap((code) =>
				Effect.sync(() => {
					process.exitCode = code;
				})
			),
			Effect.provide(NodeServices.layer)
		)
	);
