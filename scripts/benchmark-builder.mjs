import { execFileSync, spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { prepareDepset } from './lib/depset.mjs';
import { discoverTemplates, repositoryRoot } from './lib/templates.mjs';

/**
 * The compile budget.
 *
 * This measures ONE number: how long `vite build` takes for a template whose dependencies are
 * already materialized, on a fixed runner. It is not a deploy measurement. `deployColdMs` and
 * `deployCacheHitMs` are live SLOs measured against a real tenant deploy and are not comparable
 * to this — conflating the two is what let an acceptance run report 5807 ms against a 5 s gate
 * that had never measured the same thing.
 *
 * There is no image. Dependencies come from a depset materialized out of a shared
 * content-addressed store, which is exactly what a sandbox mounts read-only at
 * `/workspace/src/node_modules`. Memory and network confinement belong to the sandbox and are
 * asserted there, not here.
 */

const workspaceEnvironment = {
	MALLOC_ARENA_MAX: '1',
	MALLOC_TRIM_THRESHOLD_: '131072',
	NODE_OPTIONS: '--max-old-space-size=192',
	NORBITAL_POD_SYNCED: '1',
	NORBITAL_POD_CHECKED: '1'
};

function fail(message) {
	throw new Error(message);
}

function argumentsFrom(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (!argument.startsWith('--')) fail(`Unknown argument: ${argument}`);
		const value = argv[++index];
		if (!value || value.startsWith('--')) fail(`${argument} requires a value.`);
		options[argument.slice(2)] = value;
	}
	return options;
}

/** The tracked tree only — the same bytes `git subtree split` projects into a tenant fork. */
function materializeTrackedTemplate(template, destination) {
	const sourceRoot = path.join(repositoryRoot, template.path);
	const tracked = execFileSync('git', ['ls-files', '--', template.path], {
		cwd: repositoryRoot,
		encoding: 'utf8'
	})
		.trim()
		.split('\n')
		.filter(Boolean);
	if (tracked.length === 0) fail(`Template ${template.key} has no tracked files.`);
	for (const trackedFile of tracked) {
		const source = path.join(repositoryRoot, trackedFile);
		const target = path.join(destination, path.relative(sourceRoot, source));
		mkdirSync(path.dirname(target), { recursive: true });
		execFileSync('cp', [source, target]);
	}
	return destination;
}

function countMigrations(root) {
	if (!existsSync(root)) return 0;
	return readdirSync(root, { recursive: true, withFileTypes: true }).filter(
		(entry) =>
			entry.isFile() &&
			entry.name === 'migration.sql' &&
			statSync(path.join(entry.parentPath, entry.name)).size > 0
	).length;
}

const options = argumentsFrom(process.argv.slice(2));
const templateKey = options.template ?? process.env.BENCHMARK_TEMPLATE ?? 'construction';
const [template] = discoverTemplates(templateKey);

const maximumBuildMilliseconds = 5000;
const outputPath = path.resolve(
	repositoryRoot,
	options.output ?? process.env.BUILDER_BENCHMARK_OUTPUT ?? 'dist/builder-benchmark.json'
);
// The store is content-addressed and immutable by hash. Reusing a caller-supplied one is the
// steady state a Core host is always in; wiping it would measure a cold fetch, not a compile.
const storeDirectory = path.resolve(
	repositoryRoot,
	options['store-dir'] ?? process.env.NORBITAL_PNPM_STORE ?? '.tmp/pnpm-store'
);

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'norbital-compile-budget-'));
const workspace = path.join(temporaryDirectory, 'src');
const depsetRoot = path.join(temporaryDirectory, 'node_modules');
let elapsedMilliseconds;
let materializeMilliseconds;
let buildStatus;
let depset;
let migrationSqlCount = 0;
let requiredOutputPresent = false;

try {
	mkdirSync(workspace, { recursive: true });
	mkdirSync(storeDirectory, { recursive: true });
	materializeTrackedTemplate(template, workspace);

	console.log(`Materializing the ${templateKey} depset from ${storeDirectory}.`);
	depset = prepareDepset({ templateDirectory: workspace, storeDirectory, depsetRoot });
	materializeMilliseconds = depset.elapsedMs;
	// The sandbox mounts the depset read-only; here a symlink stands in for the mount.
	execFileSync('ln', ['-sfn', depset.path, path.join(workspace, 'node_modules')]);

	const podBin = path.join(
		workspace,
		'node_modules',
		'@norbital-ai',
		'pod',
		'build',
		'bin',
		'invocation',
		'index.js'
	);
	console.log(`Synchronizing the ${templateKey} generated workspace.`);
	execFileSync(process.execPath, [podBin, 'sync'], { cwd: workspace, stdio: 'inherit' });

	console.log(`Measuring the ${templateKey} compile (limit ${maximumBuildMilliseconds} ms).`);
	const buildOutput = path.join(workspace, '.norbital', 'dist', 'output');
	const startedAt = process.hrtime.bigint();
	const build = spawnSync(
		path.join(workspace, 'node_modules', '.bin', 'vite'),
		['build', workspace],
		{
			cwd: workspace,
			stdio: 'inherit',
			env: { ...process.env, ...workspaceEnvironment, NORBITAL_BUILD_OUT: buildOutput }
		}
	);
	elapsedMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
	buildStatus = build.status;

	if (buildStatus === 0) {
		requiredOutputPresent = [
			'serve.mjs',
			'output/server/index.js',
			'manifest.json',
			'schema-functions.sql',
			'schema-post-ddl.sql'
		].every((relative) => {
			const file = path.join(buildOutput, relative);
			return existsSync(file) && statSync(file).size > 0;
		});
		migrationSqlCount = countMigrations(path.join(buildOutput, '.norbital', 'migrations'));
	}
} finally {
	rmSync(temporaryDirectory, { recursive: true, force: true });
}

const result = {
	$schema: '../release/builder-benchmark.schema.json',
	schemaVersion: 4,
	measures: 'compileMs',
	template: templateKey,
	lockHash: depset?.lockHash,
	depsetMaterialized: depset?.installed ?? false,
	materializeMilliseconds: Number((materializeMilliseconds ?? 0).toFixed(3)),
	buildCommand: 'vite build',
	buildEnvironment: workspaceEnvironment,
	elapsedMilliseconds: Number(elapsedMilliseconds.toFixed(3)),
	maximumBuildMilliseconds,
	requiredOutputPresent,
	migrationSqlCount,
	passed:
		buildStatus === 0 &&
		elapsedMilliseconds <= maximumBuildMilliseconds &&
		requiredOutputPresent &&
		migrationSqlCount > 0
};
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));

if (buildStatus !== 0) fail(`Clean tenant compile exited with status ${buildStatus}.`);
if (elapsedMilliseconds > maximumBuildMilliseconds) {
	fail(
		`Clean tenant compile took ${elapsedMilliseconds.toFixed(3)} ms; the compile budget is ${maximumBuildMilliseconds} ms.`
	);
}
if (!requiredOutputPresent) fail('Clean tenant compile is missing required runtime output.');
if (migrationSqlCount < 1) fail('Clean tenant compile emitted no non-empty migration.sql.');
