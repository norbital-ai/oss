#!/usr/bin/env node
/// <reference types="node" />
import { Effect, Console, Option, Predicate } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { realpathSync, statSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckDiagnostic } from '@norbital-ai/bolt/tooling';
import { dev, tethered } from './dev.ts';
import { host_file_of } from '@norbital-ai/bolt/tooling';
import { platformCommand } from './platform.ts';
import { templatesCommand } from './templates.ts';
import {
	AuthorErrors,
	authorErrors,
	buildWorkspace,
	generateMigrations,
	ToolFailure,
	watchWorkspace,
	type Built,
	type Log
} from './build.ts';
import { testWorkspace } from './test.ts';
import { seedWorkspace } from './seed.ts';

const print = (errors: readonly CheckDiagnostic[]) =>
	Effect.forEach(errors, (error) =>
		Console.error(
			`${error.code} ${error.message}${error.help === undefined ? '' : `\n${error.help}`}`
		)
	).pipe(Effect.andThen(Console.error(`${errors.length} errors`)));
/** A failure's words and those of each cause under it (a build's Vite error rides `cause`), never a blank line. */
const reason = (error: unknown): string => {
	const words: string[] = [];
	for (let at = error, depth = 0; at !== undefined && at !== null && depth < 8; depth++) {
		const message = Predicate.hasProperty(at, 'message') ? String(at.message) : String(at);
		if (message !== '' && !words.includes(message)) words.push(message);
		at = Predicate.hasProperty(at, 'cause') ? at.cause : undefined;
	}
	return words.length === 0 ? String(error) : words.join('\n  caused by: ');
};
/** An author's failure: its diagnostics, or with none its message, never a bare count. */
const failed = (error: AuthorErrors) =>
	error.errors.length === 0 ? Console.error(reason(error)) : print(error.errors);
const dir = Argument.String('dir').pipe(
	Argument.withDescription('the workspace directory (default: the current one)'),
	Argument.withDefault('.')
);
const log: Log = (line) => console.log(line);
const json = Flag.Boolean('json').pipe(
	Flag.withDescription('a job: the errors also as one JSON line on stderr'),
	Flag.withDefault(false)
);
const noTypes = Flag.Boolean('no-types').pipe(
	Flag.withDescription('skip the whole-program type check; a warm host type service answers it instead'),
	Flag.withDefault(false)
);
/** A job reads a failed run's errors from the last stderr line, `{"errors":[…]}`. */
const reported = (json: boolean) => (error: AuthorErrors) =>
	json
		? failed(error).pipe(
				Effect.andThen(Console.error(JSON.stringify({ errors: error.errors }))),
				Effect.andThen(Effect.fail(error))
			)
		: Effect.fail(error);
/**
 * `bolt check`: every author error of every stage in one run, then one type check over the workspace's own
 * `node_modules`. Runs `bolt sync`, then discover → names → bundle → evaluate → manifest → seed decode → schema and
 * migration history → types. Run it before a commit and in CI. Exit 0 ok, 1 author errors, 2 tool failure.
 */
const checkCommand = Command.make('check', { dir, json, noTypes }, ({ dir, json, noTypes }) =>
	Effect.gen(function* () {
		const { diagnose } = yield* Effect.tryPromise({
			try: () => import('./check.ts'),
			catch: (cause) => new ToolFailure({ message: 'The workspace checker could not load.', cause })
		});
		const result = yield* diagnose(resolve(dir), { types: !noTypes });
		if (result.errors.length > 0)
			return yield* Effect.fail(
				authorErrors(result.errors)
			);
		yield* Console.log(
			`ok (${result.stages.join(' → ')}${noTypes ? '' : ' → types'})`
		);
	}).pipe(Effect.catchTag('AuthorErrors', reported(json)))
);
/**
 * `bolt sync`: the declarations evaluated, `.norbital/names.ts` written; `bolt dev` and `bolt check` run it first.
 * Run it after adding or renaming a declaration so its generated names resolve. Exit 0 ok, 1 author errors, 2 tool
 * failure.
 */
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
				authorErrors(result.errors)
			);
		yield* Console.log(`synced (${result.stages.join(' → ')})`);
	}).pipe(Effect.catchTag('AuthorErrors', reported(json)))
);
/**
 * `bolt dev` tethered, the realm's per-template process (`env start`): a first build, then one per settled edit, each
 * handed to the page dev server (`tethered`); a failure never ends it.
 */
const watching = (dir: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const root = resolve(dir);
			const options = { log, spaServed: true };
			const serve = yield* tethered(root, log);
			const first = yield* buildWorkspace(root, options).pipe(
				Effect.map((first): Built | undefined => first),
				Effect.catchTag('AuthorErrors', (error) => failed(error).pipe(Effect.as(undefined)))
			);
			if (first !== undefined) yield* serve(first);
			yield* watchWorkspace(root, options, serve, first).pipe(
				// the realm's overlay replaced this workspace's packages: exit, and the realm restarts this process on the new Bolt
				Effect.raceFirst(overlaid(root))
			);
		})
	).pipe(
		// ended by the overlay: exit, so the realm's loop restarts it; the page dev server's watchers would otherwise keep
		// this process alive, serving nothing
		Effect.andThen(Effect.sync(() => process.exit(0)))
	);
/**
 * `bolt build`: the release, built once in the template's CI and run unchanged in every environment.
 *
 * Writes `.norbital/bundle/` (manifest, guest, client and server pages, assets, migrations: what a host runs),
 * `.norbital/source/` (the authored tree without tests: a customer workspace's starting source), `.norbital/seed/<pack>/`
 * (`base` from `seed/public/`, which a release carries; `test` from `seed/test/`, never published) and, last,
 * `.norbital/release.json` naming each part's SHA-256 digest (over its file tree, `*.map` excluded), so a reader that
 * finds it finds every part. Identical source gives an identical bundle digest. An unchanged seed input reuses its
 * packs; unchanged public page graphs reuse `.norbital/cache/pages`. No type check (`bolt check` owns it).
 *
 * Schema: when the declared schema changed it generates the next editable SQL migration under `migrations/`, then
 * replays the whole history on a fresh database and compares the physical schema with the declaration. Commit the SQL,
 * `snapshot.json`, `migrations.lock.json` and `physical.json` together. A destructive step needs its acceptance line; a
 * build that would generate an unaccepted one writes nothing (`BOLT_ACCEPT_DESTRUCTIVE=1` generates it accepted). Hand
 * edits to generated SQL are kept as long as replay still equals the declaration; a `-- check: <name>` line followed
 * by one `SELECT` is a post-condition that fails the file (SQLSTATE `BM005`) when it returns a row. Each file runs in
 * one transaction under the host's lock (5 s) and statement (15 s) timeouts; `CONCURRENTLY` is refused, and a backfill
 * past that budget must be reshaped.
 *
 * Exit 0 ok, 1 author errors, 2 tool failure.
 */
const buildCommand = Command.make(
	'build',
	{
		dir,
		json,
		squash: Flag.String('squash').pipe(
			Flag.optional,
			Flag.withDescription(
				'verify a fresh-database schema prefix baseline (name: lowercase letters, digits, _), archiving the originals under migrations/archive/ and retaining any procedural/data or checked suffix; commit migrations/archive/, migrations/squashes/ and the lock'
			)
		),
		platform: Flag.String('platform').pipe(
			Flag.optional,
			Flag.withDescription(
				'a directory `bolt platform` wrote: its layer is read, and its files are left for the host to add to the bundle'
			)
		),
		migrations: Flag.Boolean('migrations').pipe(
			Flag.withDefault(false),
			Flag.withDescription('compile only: write the next migration and prove the history')
		)
	},
	({ dir, json, squash, platform, migrations }) =>
		Effect.gen(function* () {
			yield* (
				migrations
					? generateMigrations(resolve(dir))
					: buildWorkspace(resolve(dir), {
							...(Option.isNone(squash) ? {} : { squash: squash.value }),
							...(Option.isNone(platform) ? {} : { platform: platform.value }),
							log
						})
			).pipe(Effect.catchTag('AuthorErrors', reported(json)));
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
 *
 * Tethered: one build, then one per burst of edits under `src/`, `seed/` and `migrations/*.sql` (150 ms debounce); a
 * failed rebuild prints its errors and the loop goes on. No type check. Internal-SPA pages are served by a Vite dev
 * server under `/__bolt/dev/<directory>/`, recorded in `.norbital/dev.json` (`origin`, `base`, `artifact`) after each
 * good build; a host serving that `artifact` routes the base there. A page-only `.svelte` edit hot-updates and keeps
 * the artifact hash; any other edit is a new artifact the host cuts over to, reloading open pages.
 *
 * Untethered: the host file default-exports a `Facilities` record; guest code runs on bolt-cli's `node_guests`. Each build
 * is migrated on its `database` and activated through the needs check, so a bundle needing a member left `off`
 * refuses to start, naming it. Served at `http://127.0.0.1:<port>`; the optional `serving` export adds integration
 * links, a converter, geocoder and web reader.
 *
 * Runs until stopped; exit 2 on a tool failure.
 */
const devCommand = Command.make(
	'dev',
	{
		dir,
		port: Flag.Int('port').pipe(
			Flag.withDescription('the untethered dev server’s port on 127.0.0.1'),
			Flag.withDefault(5180)
		),
		host: Flag.String('host').pipe(
			Flag.optional,
			Flag.withDescription(
				'serve untethered with this host file (default: the workspace’s norbital.host.ts)'
			)
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
					return yield* Effect.fail(
						new ToolFailure({ message: 'bolt dev: --tethered and --host exclude each other' })
					);
				return yield* watching(options.dir);
			}
			const hostFile = yield* host_file_of(root, Option.getOrUndefined(options.host));
			if (Option.isNone(hostFile)) return yield* watching(options.dir);
			yield* Effect.scoped(
				dev(root, hostFile.value, {
					port: options.port,
					log
				}).pipe(Effect.andThen(Effect.never))
			);
		})
);
/**
 * `bolt test [dir] [vitest args…]`: the workspace's own Vitest, in process, with the test kit preconfigured (Svelte
 * compiled, `@norbital-ai/bolt-cli/test`, forks without per-file isolation, one per free core and at least 4, a
 * one-minute hang guard and the test lint). Needs no prior `bolt build`. Each `TestWorkspace` seeds from the `test`
 * pack (`seed/test/`, built once per source hash), never from `base` or bank rows. Run it before a commit and in CI.
 * Exit 0 ok, 1 author errors or failing tests, 2 tool failure.
 *
 * @example bolt test . tests/payroll.test.ts
 */
const testCommand = Command.make(
	'test',
	{
		dir,
		args: Argument.variadic(Argument.String('args')).pipe(
			Argument.withDescription('passed to Vitest: test file filters and flags')
		)
	},
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
/**
 * `bolt seed --bank=<checkout>`: the seeder's bank tree read and decoded in memory; with `--target=<host url>` and
 * `--tenant=<handle>`, loaded into that demo environment, signed with `NORBITAL_OPS_SECRET` for `NORBITAL_OPS_SCOPE`
 * (default `local`).
 *
 * Decodes the public rows joined with the private ones, checks `start` names automations and every named asset
 * exists, then restores them into a scratch database before sending anything, so a seed the host would refuse fails
 * here and leaves the environment as it was. The target resets the environment to public ∪ private rows: assets go to
 * its object store, rows in the request; the host keeps neither. A host's reset runs it for every template whose
 * seeder names a bank tree. Exit 0 ok, 1 author errors, 2 tool failure.
 */
const seedCommand = Command.make(
	'seed',
	{
		dir,
		json,
		bank: Flag.String('bank').pipe(
			Flag.withDescription('the bank checkout holding the seeder’s tree')
		),
		target: Flag.String('target').pipe(Flag.optional, Flag.withDescription('the host’s origin')),
		tenant: Flag.String('tenant').pipe(
			Flag.optional,
			Flag.withDescription('the demo workspace handle')
		)
	},
	({ dir, json, bank, target, tenant }) =>
		Effect.gen(function* () {
			if (Option.isSome(target) !== Option.isSome(tenant))
				return yield* new ToolFailure({ message: 'bolt seed: --target and --tenant go together' });
			const secret = process.env['NORBITAL_OPS_SECRET'];
			if (Option.isSome(target) && (secret === undefined || secret === ''))
				return yield* new ToolFailure({ message: 'bolt seed: NORBITAL_OPS_SECRET is unset' });
			yield* seedWorkspace(
				resolve(dir),
				resolve(bank),
				Option.isNone(target) || Option.isNone(tenant)
					? undefined
					: {
							url: target.value,
							tenant: tenant.value,
							secret: secret ?? '',
							scope: process.env['NORBITAL_OPS_SCOPE'] ?? 'local'
						},
				log
			).pipe(Effect.catchTag('AuthorErrors', reported(json)));
		})
);
const testArgv = (rest: readonly string[]): string[] => {
	const [first, ...more] = rest;
	return first === undefined || first.startsWith('-')
		? ['test', '.', '--', ...rest.filter((a) => a !== '--')]
		: ['test', first, '--', ...more.filter((a) => a !== '--')];
};
/**
 * `bolt`: the workspace CLI, the workspace's own pinned `@norbital-ai/bolt-cli` (a devDependency at its Bolt's
 * release that never enters a release). Every verb runs in the workspace or takes its directory first; `templates`
 * runs from a template repository root. Exit codes: 0 ok, 1 author error, 2 tool failure.
 */
export const boltCommand = Command.make('bolt').pipe(
	Command.withSubcommands([
		devCommand,
		syncCommand,
		checkCommand,
		buildCommand,
		platformCommand,
		testCommand,
		seedCommand,
		templatesCommand
	])
);
export const main = (argv: readonly string[]) =>
	Command.runWith(boltCommand, { version: '1.0.0' })(
		// `bolt test [dir] [vitest args…]`: everything after the workspace directory is Vitest's
		argv[0] === 'test' ? testArgv(argv.slice(1)) : argv
	).pipe(
		Effect.as(0),
		Effect.catchTag('AuthorErrors', (error) => failed(error).pipe(Effect.as(1))),
		// its words: a host reads this line as the failure's reason
		Effect.catch((error) => Console.error(reason(error)).pipe(Effect.as(2)))
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
