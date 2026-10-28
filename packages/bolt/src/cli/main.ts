#!/usr/bin/env -S node --no-node-snapshot
/// <reference types="node" />
import { Effect, Console, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { realpathSync, statSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckDiagnostic } from '../protocol/diagnostic.ts';
import { dev, tethered } from './dev.ts';
import { hostFileOf } from '../node/host.ts';
import { templatesCommand } from './templates.ts';
import {
	AuthorErrors,
	buildWorkspace,
	ToolFailure,
	watchWorkspace,
	type Built,
	type Log
} from './build.ts';
import { testWorkspace } from './test.ts';

const print = (errors: readonly CheckDiagnostic[]) =>
	Effect.forEach(errors, (error) =>
		Console.error(
			`${error.code} ${error.message}${error.help === undefined ? '' : `\n${error.help}`}`
		)
	).pipe(Effect.andThen(Console.error(`${errors.length} errors`)));
const dir = Argument.String('dir').pipe(Argument.withDefault('.'));
const bank = Flag.String('bank').pipe(Flag.optional);
const log: Log = (line) => console.log(line);
const json = Flag.Boolean('json').pipe(
	Flag.withDescription('a job: the errors also as one JSON line on stderr'),
	Flag.withDefault(false)
);
/** A job reads a failed run's errors from the last stderr line, `{"errors":[…]}`. */
const reported = (json: boolean) => (error: AuthorErrors) =>
	json
		? print(error.errors).pipe(
				Effect.andThen(Console.error(JSON.stringify({ errors: error.errors }))),
				Effect.andThen(Effect.fail(error))
			)
		: Effect.fail(error);
const checkCommand = Command.make('check', { dir, json }, ({ dir, json }) =>
	Effect.gen(function* () {
		const { diagnose } = yield* Effect.tryPromise({
			try: () => import('./check.ts'),
			catch: (cause) => new ToolFailure({ message: 'The workspace checker could not load.', cause })
		});
		const result = yield* diagnose(resolve(dir));
		if (result.errors.length > 0)
			return yield* Effect.fail(
				new AuthorErrors({ errors: result.errors, message: `${result.errors.length} errors` })
			);
		yield* Console.log(`ok (${result.stages.join(' → ')} → types)`);
	}).pipe(Effect.catchTag('AuthorErrors', reported(json)))
);
/** `bolt sync`: the declarations evaluated, `.norbital/names.ts` written; `bolt dev` and `bolt check` run it first. */
const syncCommand = Command.make('sync', { dir, json }, ({ dir, json }) =>
	Effect.gen(function* () {
		const { sync } = yield* Effect.tryPromise({
			try: () => import('../compiler/check/index.ts'),
			catch: (cause) =>
				new ToolFailure({ message: 'The workspace compiler could not load.', cause })
		});
		const result = yield* sync(resolve(dir));
		if (result.errors.length > 0)
			return yield* Effect.fail(
				new AuthorErrors({ errors: result.errors, message: `${result.errors.length} errors` })
			);
		yield* Console.log(`synced (${result.stages.join(' → ')})`);
	}).pipe(Effect.catchTag('AuthorErrors', reported(json)))
);
/**
 * `bolt dev` tethered, the realm's per-template process (`env start`): a first build, then one per settled edit, each
 * handed to the page dev server (`tethered`); a failure never ends it.
 */
const watching = (dir: string, bank: Option.Option<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const root = resolve(dir);
			const options = { ...(Option.isNone(bank) ? {} : { bank: bank.value }), log, spaServed: true };
			const serve = yield* tethered(root, log);
			const first = yield* buildWorkspace(root, options).pipe(
				Effect.map((first): Built | undefined => first),
				Effect.catchTag('AuthorErrors', (error) => print(error.errors).pipe(Effect.as(undefined)))
			);
			if (first !== undefined) yield* serve(first);
			yield* watchWorkspace(root, options, serve, first).pipe(
				// the realm's overlay replaced this workspace's packages: exit, and the realm restarts this process on the new Bolt
				Effect.raceFirst(overlaid(root))
			);
		})
	);
const buildCommand = Command.make(
	'build',
	{
		dir,
		bank,
		json,
		squash: Flag.String('squash').pipe(
			Flag.optional,
			Flag.withDescription(
				'verify a fresh-database schema prefix baseline, retaining original archives and any procedural/data suffix'
			)
		)
	},
	({ dir, bank, json, squash }) =>
		Effect.gen(function* () {
			yield* buildWorkspace(resolve(dir), {
				...(Option.isNone(squash) ? {} : { squash: squash.value }),
				...(Option.isNone(bank) ? {} : { bank: bank.value }),
				log
			}).pipe(Effect.catchTag('AuthorErrors', reported(json)));
		})
);
/** Settles once `env link` writes `.norbital/overlay.stamp`: the installed first-party packages changed. */
const overlaid = (root: string) =>
	Effect.callback<void>((resume) => {
		const watcher = watch(join(root, '.norbital'), (_event, file) => {
			if (file === 'overlay.stamp') resume(Effect.void);
		});
		return Effect.sync(() => watcher.close());
	});
/**
 * `bolt dev`: the workspace's `norbital.host.ts` (or `--host=<file>`) serves it untethered with that file's Facilities,
 * pages hot reloaded from source. Neither, or `--tethered` (which ignores any host file): tethered, it builds on save,
 * serves its pages from source for local Colony to proxy, and Colony serves the rest of each build.
 */
const devCommand = Command.make(
	'dev',
	{
		dir,
		bank,
		port: Flag.Int('port').pipe(Flag.withDefault(5180)),
		host: Flag.String('host').pipe(
			Flag.optional,
			Flag.withDescription('serve untethered with this host file (default: the workspace’s norbital.host.ts)')
		),
		tethered: Flag.Boolean('tethered').pipe(
			Flag.withDefault(false),
			Flag.withDescription('build for local Colony, ignoring any norbital.host.ts')
		)
	},
	(options) =>
		Effect.gen(function* () {
			const root = resolve(options.dir);
			if (options.tethered) {
				if (Option.isSome(options.host))
					return yield* Effect.fail(new ToolFailure({ message: 'bolt dev: --tethered and --host exclude each other' }));
				return yield* watching(options.dir, options.bank);
			}
			const hostFile = yield* hostFileOf(root, Option.getOrUndefined(options.host));
			if (Option.isNone(hostFile)) return yield* watching(options.dir, options.bank);
			yield* Effect.scoped(
				dev(root, hostFile.value, {
					port: options.port,
					...(Option.isNone(options.bank) ? {} : { bank: options.bank.value }),
					log
				}).pipe(Effect.andThen(Effect.never))
			);
		})
);
const testCommand = Command.make(
	'test',
	{ dir, args: Argument.variadic(Argument.String('args')) },
	({ dir, args }) =>
		Effect.gen(function* () {
			// the first positional is the workspace directory, never a test file: a file there would become a build root
			if (statSync(dir, { throwIfNoEntry: false })?.isFile() === true)
				return yield* Effect.fail(
					new ToolFailure({
						message: `bolt test: ${dir} is a file. Pass the workspace first and the test filter after it, e.g. \`bolt test . tests/${dir.split('/').pop()}\``
					})
				);
			// no build: the kit checks the source and builds its test pack once per source hash, as checkpoints
			yield* testWorkspace(resolve(dir), args);
		})
);
const testArgv = (rest: readonly string[]): string[] => {
	const [first, ...more] = rest;
	return first === undefined || first.startsWith('-')
		? ['test', '.', '--', ...rest.filter((a) => a !== '--')]
		: ['test', first, '--', ...more.filter((a) => a !== '--')];
};
export const boltCommand = Command.make('bolt').pipe(
	Command.withSubcommands([
		devCommand,
		syncCommand,
		checkCommand,
		buildCommand,
		testCommand,
		templatesCommand
	])
);
export const main = (argv: readonly string[]) =>
	Command.runWith(boltCommand, { version: '1.0.0' })(
		// `bolt test [dir] [vitest args…]`: everything after the workspace directory is Vitest's
		argv[0] === 'test' ? testArgv(argv.slice(1)) : argv
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
