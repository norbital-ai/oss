import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digestPinnedImagePattern = /^.+@sha256:[0-9a-f]{64}$/;
const positiveIntegerPattern = /^[1-9][0-9]*$/;
const packageKeyPattern = /^[0-9a-f]{16}$/;
const workspace = '/workspace';
const buildOutput = `${workspace}/.norbital/dist/output`;
const viteBin = `${workspace}/node_modules/.bin/vite`;
const buildCommand = 'env NORBITAL_POD_CHECKED=1 vite build /workspace';
const buildEnvironment = {
	MALLOC_ARENA_MAX: '1',
	MALLOC_TRIM_THRESHOLD_: '131072',
	NODE_OPTIONS: '--max-old-space-size=192',
	NORBITAL_BUILD_OUT: buildOutput,
	NORBITAL_POD_PLATFORM_DIR: '/opt/norbital/platform-client',
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
		const key = argument.slice(2);
		const value = argv[++index];
		if (!value || value.startsWith('--')) fail(`${argument} requires a value.`);
		options[key] = value;
	}
	return options;
}

function required(options, key, environmentKey) {
	const value = options[key] ?? process.env[environmentKey];
	if (!value) fail(`Pass --${key} or set ${environmentKey}.`);
	return value;
}

function docker(arguments_, options = {}) {
	const output = execFileSync('docker', arguments_, {
		cwd: repositoryRoot,
		encoding: 'utf8',
		stdio: options.stdio ?? ['ignore', 'pipe', 'pipe']
	});
	return typeof output === 'string' ? output.trim() : '';
}

function readPeakMemory(container) {
	const value = docker([
		'exec',
		'-u',
		'0',
		container,
		'sh',
		'-c',
		[
			'if test -r /sys/fs/cgroup/memory.peak; then',
			'  cat /sys/fs/cgroup/memory.peak;',
			'elif test -r /sys/fs/cgroup/memory/memory.max_usage_in_bytes; then',
			'  cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes;',
			'fi'
		].join(' ')
	]);
	return positiveIntegerPattern.test(value) ? Number(value) : null;
}

function materializeTrackedTemplate(template, temporaryDirectory) {
	const destination = path.join(temporaryDirectory, template.key);
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
		copyFileSync(source, target);
	}
	return destination;
}

function productionBuildArguments(container) {
	const environment = Object.entries(buildEnvironment).flatMap(([key, value]) => [
		'--env',
		`${key}=${value}`
	]);
	return [
		'exec',
		...environment,
		'-u',
		'node',
		'-w',
		workspace,
		container,
		viteBin,
		'build',
		workspace
	];
}

const options = argumentsFrom(process.argv.slice(2));
const image = required(options, 'image', 'BUILDER_IMAGE');
if (!digestPinnedImagePattern.test(image)) {
	fail('Builder benchmark requires a digest-pinned image reference.');
}

const templateKey = options.template ?? process.env.BENCHMARK_TEMPLATE ?? 'construction';
if (!/^[a-z0-9][a-z0-9-]*$/.test(templateKey)) fail(`Invalid template key: ${templateKey}`);
const catalogue = JSON.parse(
	readFileSync(path.join(repositoryRoot, 'release/templates.json'), 'utf8')
);
const template = catalogue.templates?.find((entry) => entry.key === templateKey);
if (!template) {
	fail(`Benchmark template must be an active catalogue entry: ${templateKey}`);
}

const maximumBuildMilliseconds = 5000;
const maximumPeakMemoryBytes = 450 * 1024 * 1024;
const expectedPackageKey = required(
	options,
	'expected-package-key',
	'EXPECTED_PLATFORM_PACKAGE_KEY'
);
if (!packageKeyPattern.test(expectedPackageKey)) {
	fail('expected-package-key must be a 16-character package key.');
}

const outputPath = path.resolve(
	repositoryRoot,
	options.output ?? process.env.BUILDER_BENCHMARK_OUTPUT ?? 'dist/builder-benchmark.json'
);
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'norbital-builder-benchmark-'));
const templatePath = materializeTrackedTemplate(template, temporaryDirectory);
const container = `norbital-builder-benchmark-${process.pid}-${Date.now()}`;
const podBin =
	'/opt/norbital/tenant-toolchain/node_modules/@norbital-ai/pod/build/bin/invocation/index.js';
let elapsedMilliseconds;
let peakMemoryBytes;
let peakScope = 'synchronization-and-measured-build';
let buildStatus;
let packageKey;
let requiredOutputPresent = false;
let migrationSqlCount = 0;

try {
	docker([
		'create',
		'--platform',
		'linux/amd64',
		'--name',
		container,
		'--network',
		'none',
		'--memory',
		'500m',
		'--memory-swap',
		'500m',
		'--env',
		`NORBITAL_POD_PLATFORM_DIR=${buildEnvironment.NORBITAL_POD_PLATFORM_DIR}`,
		image
	]);
	docker(['cp', `${templatePath}/.`, `${container}:/workspace`]);
	docker(['start', container]);
	docker([
		'exec',
		'-u',
		'0',
		container,
		'sh',
		'-ec',
		[
			'chown -R node:node /workspace;',
			'rm -rf /workspace/node_modules;',
			'ln -s /opt/norbital/tenant-toolchain/node_modules /workspace/node_modules'
		].join(' ')
	]);

	packageKey = docker([
		'exec',
		'-u',
		'node',
		container,
		'sh',
		'-ec',
		'cat /opt/norbital/tenant-toolchain/.package-key'
	]);
	if (!packageKeyPattern.test(packageKey))
		fail(`Builder contains an invalid package key: ${packageKey}`);
	if (packageKey !== expectedPackageKey) {
		fail(`Builder package key ${packageKey} does not match expected ${expectedPackageKey}.`);
	}

	console.log(`Synchronizing ${templateKey} generated workspace in ${image}.`);
	docker(['exec', '-u', 'node', '-w', '/workspace', container, 'node', podBin, 'sync'], {
		stdio: 'inherit'
	});

	const reset = spawnSync(
		'docker',
		[
			'exec',
			'-u',
			'0',
			container,
			'sh',
			'-c',
			'test -w /sys/fs/cgroup/memory.peak && printf 0 > /sys/fs/cgroup/memory.peak'
		],
		{ cwd: repositoryRoot, stdio: 'ignore' }
	);
	if (reset.status === 0) peakScope = 'measured-build';

	console.log(`Measuring clean ${templateKey} build (limit ${maximumBuildMilliseconds} ms).`);
	const startedAt = process.hrtime.bigint();
	const build = spawnSync('docker', productionBuildArguments(container), {
		cwd: repositoryRoot,
		stdio: 'inherit'
	});
	elapsedMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
	buildStatus = build.status;
	peakMemoryBytes = readPeakMemory(container);
	if (buildStatus === 0) {
		const outputCheck = spawnSync(
			'docker',
			[
				'exec',
				'-u',
				'node',
				container,
				'sh',
				'-ec',
				[
					`test -s ${buildOutput}/serve.mjs`,
					`test -s ${buildOutput}/output/server/index.js`,
					`test -s ${buildOutput}/manifest.json`,
					`test -s ${buildOutput}/schema-functions.sql`,
					`test -s ${buildOutput}/schema-post-ddl.sql`
				].join(' && ')
			],
			{ cwd: repositoryRoot, stdio: 'ignore' }
		);
		requiredOutputPresent = outputCheck.status === 0;
		const migrationCount = docker([
			'exec',
			'-u',
			'node',
			container,
			'sh',
			'-ec',
			`find ${buildOutput}/.norbital/migrations -type f -name migration.sql -size +0c | wc -l`
		]);
		migrationSqlCount = Number(migrationCount);
	}
} finally {
	spawnSync('docker', ['rm', '--force', container], {
		cwd: repositoryRoot,
		stdio: 'ignore'
	});
	rmSync(temporaryDirectory, { recursive: true, force: true });
}

const memoryLimitBytes = 500 * 1024 * 1024;
const result = {
	$schema: '../release/builder-benchmark.schema.json',
	schemaVersion: 3,
	image,
	packageKey,
	template: templateKey,
	network: 'none',
	warm: false,
	cleanOutput: true,
	prevalidated: true,
	staticVerification: 'builder-toolchain-verification.json',
	buildCommand,
	buildEnvironment,
	elapsedMilliseconds: Number(elapsedMilliseconds.toFixed(3)),
	maximumBuildMilliseconds,
	memoryLimitBytes,
	memorySwapLimitBytes: memoryLimitBytes,
	maximumPeakMemoryBytes,
	peakMemoryBytes,
	peakScope,
	requiredOutputPresent,
	migrationSqlCount,
	passed:
		buildStatus === 0 &&
		elapsedMilliseconds <= maximumBuildMilliseconds &&
		peakMemoryBytes != null &&
		peakMemoryBytes <= maximumPeakMemoryBytes &&
		requiredOutputPresent &&
		migrationSqlCount > 0
};
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));

if (buildStatus !== 0) fail(`Clean tenant build exited with status ${buildStatus}.`);
if (elapsedMilliseconds > maximumBuildMilliseconds) {
	fail(
		`Clean tenant build took ${elapsedMilliseconds.toFixed(3)} ms; limit is ${maximumBuildMilliseconds} ms.`
	);
}
if (peakMemoryBytes == null) {
	fail('Clean tenant build did not expose a cgroup memory peak.');
}
if (peakMemoryBytes > maximumPeakMemoryBytes) {
	fail(`Clean tenant build peaked at ${peakMemoryBytes} bytes; release headroom limit is 450 MiB.`);
}
if (!requiredOutputPresent) fail('Clean tenant build is missing required runtime output.');
if (migrationSqlCount < 1) fail('Clean tenant build emitted no non-empty migration.sql.');
