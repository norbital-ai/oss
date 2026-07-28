import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digestPinnedImagePattern = /^.+@sha256:[0-9a-f]{64}$/;
const positiveIntegerPattern = /^[1-9][0-9]*$/;
const packageKeyPattern = /^[0-9a-f]{16}$/;

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
	return execFileSync('docker', arguments_, {
		cwd: repositoryRoot,
		encoding: 'utf8',
		stdio: options.stdio ?? ['ignore', 'pipe', 'pipe']
	}).trim();
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
const templatePath = path.join(repositoryRoot, template.path);

const maximumBuildMilliseconds = 5000;
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
const container = `norbital-builder-benchmark-${process.pid}-${Date.now()}`;
const podBin =
	'/opt/norbital/tenant-toolchain/node_modules/@norbital-ai/pod/build/bin/invocation/index.js';
let elapsedMilliseconds;
let peakMemoryBytes;
let peakScope = 'warm-up-and-measured-build';
let buildStatus;
let packageKey;

try {
	docker([
		'create',
		'--name',
		container,
		'--network',
		'none',
		'--memory',
		'500m',
		'--memory-swap',
		'500m',
		'--env',
		'NORBITAL_POD_PLATFORM_DIR=/opt/norbital/platform-client',
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

	console.log(`Priming ${templateKey} in ${image}.`);
	docker(['exec', '-u', 'node', '-w', '/workspace', container, 'node', podBin, 'build'], {
		stdio: 'inherit'
	});
	docker([
		'exec',
		'-u',
		'node',
		'-w',
		'/workspace',
		container,
		'sh',
		'-ec',
		'rm -rf .norbital/build'
	]);

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

	console.log(`Measuring warm ${templateKey} build (limit ${maximumBuildMilliseconds} ms).`);
	const startedAt = process.hrtime.bigint();
	const build = spawnSync(
		'docker',
		['exec', '-u', 'node', '-w', '/workspace', container, 'node', podBin, 'build'],
		{ cwd: repositoryRoot, stdio: 'inherit' }
	);
	elapsedMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
	buildStatus = build.status;
	peakMemoryBytes = readPeakMemory(container);
} finally {
	spawnSync('docker', ['rm', '--force', container], {
		cwd: repositoryRoot,
		stdio: 'ignore'
	});
}

const memoryLimitBytes = 500 * 1024 * 1024;
const result = {
	$schema: '../release/builder-benchmark.schema.json',
	schemaVersion: 1,
	image,
	packageKey,
	template: templateKey,
	network: 'none',
	warm: true,
	elapsedMilliseconds: Number(elapsedMilliseconds.toFixed(3)),
	maximumBuildMilliseconds,
	memoryLimitBytes,
	memorySwapLimitBytes: memoryLimitBytes,
	peakMemoryBytes,
	peakScope,
	passed:
		buildStatus === 0 &&
		elapsedMilliseconds <= maximumBuildMilliseconds &&
		(peakMemoryBytes == null || peakMemoryBytes <= memoryLimitBytes)
};
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));

if (buildStatus !== 0) fail(`Warm tenant build exited with status ${buildStatus}.`);
if (elapsedMilliseconds > maximumBuildMilliseconds) {
	fail(
		`Warm tenant build took ${elapsedMilliseconds.toFixed(3)} ms; limit is ${maximumBuildMilliseconds} ms.`
	);
}
if (peakMemoryBytes != null && peakMemoryBytes > memoryLimitBytes) {
	fail(`Warm tenant build peaked at ${peakMemoryBytes} bytes; limit is 500 MiB.`);
}
