#!/usr/bin/env -S node --no-node-snapshot
/// <reference types="node" />
import { Effect, Console, Option, Schema } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sync, type CheckDiagnostic } from '../compiler/check/index.ts';
import { dev } from './dev.ts';
import { templatesCommand } from './templates.ts';
import { AuthorErrors, buildWorkspace, ToolFailure, type Log } from './build.ts';
import { diagnose } from './check.ts';
import { testWorkspace } from './test.ts';

const print = (errors: readonly CheckDiagnostic[]) =>
	Effect.forEach(errors, (error) =>
		Console.error(
			`${error.code} ${error.message}${error.help === undefined ? '' : `\n${error.help}`}`
		)
	).pipe(Effect.andThen(Console.error(`${errors.length} errors`)));
const dir = Argument.string('dir').pipe(Argument.withDefault('.'));
const bank = Flag.string('bank').pipe(Flag.optional);
const log: Log = (line) => console.log(line);
const json = Flag.boolean('json').pipe(
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
		const result = yield* sync(resolve(dir));
		if (result.errors.length > 0)
			return yield* Effect.fail(
				new AuthorErrors({ errors: result.errors, message: `${result.errors.length} errors` })
			);
		yield* Console.log(`synced (${result.stages.join(' → ')})`);
	}).pipe(Effect.catchTag('AuthorErrors', reported(json)))
);
const buildCommand = Command.make(
	'build',
	{
		dir,
		bank,
		json,
		squash: Flag.string('squash').pipe(
			Flag.optional,
			Flag.withDescription(
				'verify a fresh-database schema prefix baseline, retaining original archives and any procedural/data suffix'
			)
		)
	},
	({ dir, bank, json, squash }) =>
		buildWorkspace(resolve(dir), {
			...(Option.isNone(squash) ? {} : { squash: squash.value }),
			...(Option.isNone(bank) ? {} : { bank: bank.value }),
			log
		}).pipe(Effect.catchTag('AuthorErrors', reported(json)))
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
			// the first positional is the workspace directory, never a test file: a file there would become a build root
			if (statSync(dir, { throwIfNoEntry: false })?.isFile() === true)
				return yield* Effect.fail(
					new ToolFailure({
						message: `bolt test: ${dir} is a file. Pass the workspace first and the test filter after it, e.g. \`bolt test . tests/${dir.split('/').pop()}\``
					})
				);
			// the template standalone: its tests run against the build of its own source and public packs, never a bank's
			// sample or a build left from before
			const nodeEnv = process.env['NODE_ENV'];
			yield* buildWorkspace(resolve(dir));
			// Vite's build sets NODE_ENV=production when it is unset; the suite runs under Vitest's own
			if (nodeEnv === undefined) delete process.env['NODE_ENV'];
			yield* testWorkspace(resolve(dir), args);
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
		syncCommand,
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
