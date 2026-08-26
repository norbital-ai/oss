import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Cause, Effect } from 'effect';
import { syncWorkspace, type SyncResult } from './sync.js';

const { positionals, values: options } = parseArgs({
	options: {
		root: { type: 'string' },
		name: { type: 'string' },
		json: { type: 'boolean' },
		watch: { type: 'boolean' }
	},
	allowPositionals: true,
	strict: true
});
const command = positionals.length === 1 ? (positionals[0] ?? 'help') : 'help';
const rootValue = options.root;
const workspaceRoot = resolve(rootValue ?? process.cwd());
const nameValue = options.name;
const json = options.json ?? false;
const watch = options.watch ?? false;

const report = (commandName: string, result: SyncResult): void => {
	if (json) {
		process.stdout.write(`${JSON.stringify(result)}\n`);
		return;
	}
	process.stdout.write(
		[
			`Bolt ${commandName} complete: ${result.collectionNames.length} collections, ${result.appNames.length} apps, ${result.browserAssetCount} browser assets, ${result.serverAssetCount} server assets`,
			`Artifact: ${result.artifactPath}`,
			''
		].join('\n')
	);
};

const fail = (commandName: string, error: unknown): void => {
	const message =
		error instanceof Error && error.message.trim() !== ''
			? error.message
			: String(error).trim() || `Unknown ${commandName} failure`;
	process.stderr.write(
		json
			? `${JSON.stringify({ error: message, command, workspaceRoot })}\n`
			: `Bolt ${commandName} failed: ${message}\n`
	);
	process.exitCode = 1;
};

/**
 * The command's owned lifetime, awaited by the tiny executable entry module.
 *
 * One function that answers with the run it started, rather than a module-scoped binding each
 * branch overwrites: the entry then has no window in which it can observe a placeholder, and the
 * synchronous paths — help, and an unknown command — say so by answering with a settled promise.
 */
/**
 * The neutral lifetime: the synchronous branches have already written everything they will write.
 */
const settled = Effect.runPromise(Effect.void);

const run = (): Promise<void> => {
	if (command === 'help') {
		process.stdout.write(
			[
				'bolt <command> [options]',
				'',
				'Commands:',
				'  sync     regenerate workspace types, build the client, and emit a portable artifact',
				'  migrate  diff the authored models against the migration lineage and write the next entry',
				'  audit    run the static code-quality audit over this workspace',
				'',
				'Options:',
				'  --root <path>  workspace root (defaults to the current directory)',
				'  --name <name>  migration name (defaults to "auto")',
				'  --json         emit the result as JSON',
				'  --watch        rerun sync when authored source changes',
				''
			].join('\n')
		);
		return settled;
	}

	if (command === 'audit') {
		/*
		 * The engine is an optional peer, not a dependency.
		 *
		 * Bolt is installed into every tenant workspace and runs there; a code-quality engine and its
		 * TypeScript compiler have no business riding along in that install. So the import is lazy, and
		 * its absence is a message rather than a stack trace.
		 */
		const program = Effect.gen(function* () {
			/*
			 * Absence is detected by letting the import reject, not by resolving the manifest first:
			 * `findPackageJSON` throws ERR_MODULE_NOT_FOUND for a package it cannot find rather than
			 * returning undefined, so a presence check written against undefined never fires and the
			 * missing-package path produces the stack trace this branch exists to avoid.
			 */
			const probe = yield* Effect.promise(() =>
				import('@norbital-ai/doctor').then(
					(module): typeof import('@norbital-ai/doctor') | undefined => module,
					() => undefined
				)
			);
			if (probe === undefined) {
				process.stderr.write(
					[
						'Bolt audit needs @norbital-ai/doctor, which is not installed.',
						'',
						'  pnpm add -D @norbital-ai/doctor',
						''
					].join('\n')
				);
				process.exitCode = 1;
				return;
			}
			const result = yield* Effect.promise(() => probe.audit({ root: workspaceRoot }));
			if (json) {
				process.stdout.write(`${JSON.stringify(result)}\n`);
			} else {
				const tiers = (['syntactic', 'graph', 'typeAware'] as const)
					.filter((tier) => result.receipt.tiers[tier])
					.map((tier) => (tier === 'typeAware' ? 'type-aware' : tier))
					.join(' + ');
				process.stdout.write(
					[
						`Bolt audit complete: ${result.counts.error} errors, ${result.counts.hint} hints across ${result.receipt.files} files`,
						`Tiers: ${tiers}`,
						...(result.packs.length > 0 ? [`Packs: ${result.packs.join(', ')}`] : []),
						`Catalogue: ${result.cataloguePath}`,
						''
					].join('\n')
				);
			}
			process.exitCode = result.counts.error > 0 ? 1 : 0;
		});
		return Effect.runPromise(
			program.pipe(
				Effect.catchCause((cause) => Effect.sync(() => fail('audit', Cause.squash(cause))))
			)
		);
	}

	if (command === 'migrate') {
		// Its own command rather than a step inside `sync`. `sync` is idempotent — run it twice and the
		// workspace is unchanged — while generating a migration appends a timestamped entry to a lineage
		// that is then applied to real databases. Folding it into the command a dev server runs on every
		// save is what forced the legacy path to carry a fingerprint cache to suppress its own output.
		const program = Effect.gen(function* () {
			// Imported here rather than at the top: the diff engine is a large module only this command
			// needs, and `sync` runs on every save.
			const { generateWorkspaceMigration } = yield* Effect.promise(
				() => import('./schema-migrations.js')
			);
			const result = yield* generateWorkspaceMigration(workspaceRoot, nameValue);
			if (json) {
				process.stdout.write(`${JSON.stringify(result)}\n`);
			} else if (result.tag === undefined) {
				process.stdout.write(
					'Bolt migrate: the authored models and the migration lineage already agree; nothing written.\n'
				);
			} else {
				process.stdout.write(
					[
						`Bolt migrate wrote ${result.tag} (${result.statements.length} statements)`,
						`Lineage: ${result.migrationsRoot}`,
						...result.statements.map((statement) => `  ${statement}`),
						''
					].join('\n')
				);
			}
		});
		return Effect.runPromise(
			program.pipe(
				Effect.catchCause((cause) => Effect.sync(() => fail('migrate', Cause.squash(cause))))
			)
		);
		/**
		 * One command, because there was only ever one thing to run.
		 *
		 * `build` and `check` were spellings of `sync` — the same call, the same output, three names for
		 * it. `build` in particular read as the thing that produced the browser client and did not; the
		 * template `package.json` script called `build` was a *different* build again, `vite build`, that
		 * nothing in any pipeline ran. `sync` does all of it and answers to one name.
		 */
	}

	if (command === 'sync') {
		const program = Effect.gen(function* () {
			const result = yield* syncWorkspace(workspaceRoot);
			report(command, result);
			if (!watch) return;
			const { watch: watchDirectory } = yield* Effect.promise(() => import('node:fs'));
			const watcher = watchDirectory(resolve(workspaceRoot, 'src'), { recursive: true }, () => {
				void Effect.runPromise(
					syncWorkspace(workspaceRoot).pipe(
						Effect.tap((next) => Effect.sync(() => report('sync', next))),
						Effect.catchCause((cause) => Effect.sync(() => fail('sync', Cause.squash(cause))))
					)
				);
			});
			yield* Effect.addFinalizer(() => Effect.sync(() => watcher.close()));
			yield* Effect.never;
		});
		return Effect.runPromise(
			Effect.scoped(program).pipe(
				Effect.catchCause((cause) => Effect.sync(() => fail(command, Cause.squash(cause))))
			)
		);
	}

	process.stderr.write(`Unknown Bolt command: ${command}. Run "bolt help" for usage.\n`);
	process.exitCode = 1;
	return settled;
};

export const completion = run();
