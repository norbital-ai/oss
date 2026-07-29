import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { prepareDepset } from './lib/depset.mjs';
import { discoverTemplates, repositoryRoot } from './lib/templates.mjs';

/**
 * Proves the bundle contract: a build against a materialized depset produces a bundle that
 * boots and emits its ready frame.
 *
 * The bundle format is the only cross-version contract left now that there are no images, so
 * this gate exists to catch a bundle a newer runtime cannot serve. There is nothing to pull
 * and nothing digest-pinned; dependencies come from a depset linked out of the shared
 * content-addressed store.
 */

const requiredBundlePaths = [
	'manifest.json',
	'dist/index.html',
	'serve.mjs',
	'output/server/index.js',
	'schema-functions.sql',
	'schema-post-ddl.sql'
];
const buildEnvironment = {
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

/**
 * Boot the bundle and wait for its ready frame. The runtime speaks the framed wire protocol,
 * so a bundle that boots but never frames is a failure, not a timeout to be tolerated.
 */
function waitForRuntimeReady(entry, bundle, timeoutMilliseconds) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [entry], {
			cwd: bundle,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env, NODE_ENV: 'production' }
		});
		const readyFrame = Buffer.from('{"t":"ready"}');
		let stdout = Buffer.alloc(0);
		let stderr = '';
		let settled = false;
		const settle = (callback) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill('SIGKILL');
			callback();
		};
		const timer = setTimeout(
			() =>
				settle(() =>
					reject(
						new Error(
							`Runtime did not emit its ready frame within ${timeoutMilliseconds}ms: ${stderr}`
						)
					)
				),
			timeoutMilliseconds
		);
		child.stdout.on('data', (chunk) => {
			stdout = Buffer.concat([stdout, chunk]);
			if (stdout.includes(readyFrame)) settle(resolve);
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString('utf8');
		});
		child.on('error', (error) => settle(() => reject(error)));
		child.on('close', (code, signal) =>
			settle(() =>
				reject(new Error(`Runtime exited before ready (code=${code} signal=${signal}): ${stderr}`))
			)
		);
	});
}

const options = argumentsFrom(process.argv.slice(2));
const templateKey = options.template ?? process.env.RUNTIME_SMOKE_TEMPLATE ?? 'hr-payroll';
const [template] = discoverTemplates(templateKey);
const outputPath = path.resolve(
	repositoryRoot,
	options.output ?? process.env.RUNTIME_SMOKE_OUTPUT ?? 'dist/runtime-smoke.json'
);
const storeDirectory = path.resolve(
	repositoryRoot,
	options['store-dir'] ?? process.env.NORBITAL_PNPM_STORE ?? '.tmp/pnpm-store'
);

mkdirSync(path.join(repositoryRoot, '.tmp'), { recursive: true });
const temporaryDirectory = mkdtempSync(path.join(repositoryRoot, '.tmp', 'runtime-smoke-'));
const workspace = path.join(temporaryDirectory, 'src');
const depsetRoot = path.join(temporaryDirectory, 'node_modules');
const bundle = path.join(workspace, '.norbital', 'dist', 'output');
let depset;
let buildElapsedMilliseconds;
let serveEntrySha256;
let migrationSqlCount;

try {
	mkdirSync(workspace, { recursive: true });
	mkdirSync(storeDirectory, { recursive: true });
	materializeTrackedTemplate(template, workspace);

	depset = prepareDepset({ templateDirectory: workspace, storeDirectory, depsetRoot });
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
	execFileSync(process.execPath, [podBin, 'sync'], { cwd: workspace, stdio: 'inherit' });

	const buildStartedAt = process.hrtime.bigint();
	const build = spawnSync(
		path.join(workspace, 'node_modules', '.bin', 'vite'),
		['build', workspace],
		{
			cwd: workspace,
			stdio: 'inherit',
			env: { ...process.env, ...buildEnvironment, NORBITAL_BUILD_OUT: bundle }
		}
	);
	buildElapsedMilliseconds = Number(process.hrtime.bigint() - buildStartedAt) / 1_000_000;
	if (build.status !== 0) fail(`Tenant build exited with status ${build.status}.`);

	for (const requiredPath of requiredBundlePaths) {
		const file = path.join(bundle, requiredPath);
		if (!statSync(file).isFile() || statSync(file).size === 0) {
			fail(`Published build output is missing non-empty ${requiredPath}.`);
		}
	}
	migrationSqlCount = readdirSync(path.join(bundle, '.norbital', 'migrations'), {
		recursive: true,
		withFileTypes: true
	}).filter(
		(entry) =>
			entry.isFile() &&
			entry.name === 'migration.sql' &&
			statSync(path.join(entry.parentPath, entry.name)).size > 0
	).length;
	if (migrationSqlCount < 1) fail('Published build output contains no non-empty migration.sql.');
	serveEntrySha256 = createHash('sha256')
		.update(readFileSync(path.join(bundle, 'serve.mjs')))
		.digest('hex');

	console.log('Booting serve.mjs from the clean bundle.');
	await waitForRuntimeReady(path.join(bundle, 'serve.mjs'), bundle, 20_000);
} finally {
	rmSync(temporaryDirectory, { recursive: true, force: true });
}

const result = {
	$schema: '../release/runtime-smoke.schema.json',
	schemaVersion: 3,
	template: templateKey,
	lockHash: depset.lockHash,
	buildCommand: 'vite build',
	buildElapsedMilliseconds: Number(buildElapsedMilliseconds.toFixed(3)),
	requiredBundlePaths,
	migrationSqlCount,
	runtimeEntry: 'serve.mjs',
	serveEntrySha256,
	readyFrame: { t: 'ready' },
	passed: true
};
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
