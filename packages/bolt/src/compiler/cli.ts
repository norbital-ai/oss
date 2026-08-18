#!/usr/bin/env node
import { resolve } from 'node:path';
import { Effect } from 'effect';
import { syncWorkspace, type SyncResult } from './sync.js';

const arguments_ = process.argv.slice(2);
const command = arguments_.find((argument) => !argument.startsWith('-')) ?? 'help';
const rootIndex = arguments_.findIndex((argument) => argument === '--root');
const rootValue = rootIndex < 0 ? undefined : arguments_[rootIndex + 1];
const workspaceRoot = resolve(rootValue ?? process.cwd());
const nameIndex = arguments_.findIndex((argument) => argument === '--name');
const nameValue = nameIndex < 0 ? undefined : arguments_[nameIndex + 1];
const json = arguments_.includes('--json');
const watch = arguments_.includes('--watch');

const report = (commandName: string, result: SyncResult): void => {
	if (json) {
		process.stdout.write(`${JSON.stringify(result)}\n`);
		return;
	}
	process.stdout.write([
		`Bolt ${commandName} complete: ${result.collectionNames.length} collections, ${result.appNames.length} apps, ${result.staticAssetCount} static assets`,
		`Artifact: ${result.artifactPath}`,
		''
	].join('\n'));
};

const fail = (commandName: string, error: unknown): void => {
	const message = error instanceof Error && error.message.trim() !== '' ? error.message : String(error).trim() || `Unknown ${commandName} failure`;
	process.stderr.write(json ? `${JSON.stringify({ error: message, command, workspaceRoot })}\n` : `Bolt ${commandName} failed: ${message}\n`);
	process.exitCode = 1;
};

if (command === 'help') {
	process.stdout.write([
		'bolt <command> [options]',
		'',
		'Commands:',
		'  sync     regenerate workspace types and emit a portable artifact',
		'  build    perform the same deterministic production artifact build',
		'  check    validate discovery by completing an isolated deterministic build',
		'  migrate  diff the authored models against the migration lineage and write the next entry',
		'',
		'Options:',
		'  --root <path>  workspace root (defaults to the current directory)',
		'  --name <name>  migration name (defaults to "auto")',
		'  --json         emit the result as JSON',
		'  --watch        rerun sync when authored source changes',
		''
	].join('\n'));
} else if (command === 'migrate') {
	// Its own command rather than a step inside `sync`. `sync` is idempotent — run it twice and the
	// workspace is unchanged — while generating a migration appends a timestamped entry to a lineage
	// that is then applied to real databases. Folding it into the command a dev server runs on every
	// save is what forced the legacy path to carry a fingerprint cache to suppress its own output.
	const program = Effect.gen(function* () {
		// Imported here rather than at the top: the diff engine is a large module only this command
		// needs, and `sync` runs on every save.
		const { generateWorkspaceMigration } = yield* Effect.promise(() => import('./schema-migrations.js'));
		const result = yield* generateWorkspaceMigration(workspaceRoot, nameValue);
		if (json) {
			process.stdout.write(`${JSON.stringify(result)}\n`);
		} else if (result.tag === undefined) {
			process.stdout.write('Bolt migrate: the authored models and the migration lineage already agree; nothing written.\n');
		} else {
			process.stdout.write([
				`Bolt migrate wrote ${result.tag} (${result.statements.length} statements)`,
				`Lineage: ${result.migrationsRoot}`,
				...result.statements.map((statement) => `  ${statement}`),
				''
			].join('\n'));
		}
	});
	await Effect.runPromise(program).catch((error) => fail('migrate', error));
} else if (command === 'sync' || command === 'build' || command === 'check') {
	const program = Effect.gen(function* () {
		const result = yield* syncWorkspace(workspaceRoot);
		report(command, result);
		if (!(watch && command === 'sync')) return;
		const { watch: watchDirectory } = yield* Effect.promise(() => import('node:fs'));
		const watcher = watchDirectory(resolve(workspaceRoot, 'src'), { recursive: true }, () => {
			Effect.runPromise(syncWorkspace(workspaceRoot))
				.then((next) => report('sync', next))
				.catch((error: unknown) => fail('sync', error));
		});
		yield* Effect.addFinalizer(() => Effect.sync(() => watcher.close()));
		yield* Effect.never;
	});
	await Effect.runPromise(Effect.scoped(program)).catch((error) => fail(command, error));
} else {
	process.stderr.write(`Unknown Bolt command: ${command}. Run "bolt help" for usage.\n`);
	process.exitCode = 1;
}
