import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digestPinnedImagePattern = /^.+@sha256:[0-9a-f]{64}$/;
const keyPattern = /^[0-9a-f]{16}$/;
const dockerMemoryPattern = /^([1-9]\d*)([mg])$/;
const platformManifest = '/opt/norbital/platform-client/platform-manifest.json';
const podBin =
	'/opt/norbital/tenant-toolchain/node_modules/@norbital-ai/pod/build/bin/invocation/index.js';

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

function required(options, key, environmentKey) {
	const value = options[key] ?? process.env[environmentKey];
	if (!value) fail(`Pass --${key} or set ${environmentKey}.`);
	return value;
}

function memoryBytes(value) {
	const match = dockerMemoryPattern.exec(value);
	if (!match) fail(`Invalid Docker memory value: ${value}.`);
	const multiplier = match[2] === 'g' ? 1024 * 1024 * 1024 : 1024 * 1024;
	return Number(match[1]) * multiplier;
}

function docker(arguments_, options = {}) {
	const output = execFileSync('docker', arguments_, {
		cwd: repositoryRoot,
		encoding: 'utf8',
		stdio: options.stdio ?? ['ignore', 'pipe', 'pipe']
	});
	return typeof output === 'string' ? output.trim() : '';
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

const options = argumentsFrom(process.argv.slice(2));
const image = required(options, 'image', 'BUILDER_IMAGE');
const expectedPackageKey = required(
	options,
	'expected-package-key',
	'EXPECTED_PLATFORM_PACKAGE_KEY'
);
const expectedTemplateDependencyKey = required(
	options,
	'expected-template-dependency-key',
	'EXPECTED_TEMPLATE_DEPENDENCY_KEY'
);
const localBuildMemory = options['local-emulation-build-memory'];
if (localBuildMemory && !image.startsWith('localhost:') && !image.startsWith('127.0.0.1:')) {
	fail('The local emulation memory override only accepts a loopback registry image.');
}
const buildMemory = localBuildMemory ?? '500m';
const buildMemoryLimitBytes = memoryBytes(buildMemory);
if (!digestPinnedImagePattern.test(image)) fail('Verification requires a digest-pinned image.');
if (!keyPattern.test(expectedPackageKey)) fail('Expected package key must be 16 lowercase hex.');
if (!keyPattern.test(expectedTemplateDependencyKey)) {
	fail('Expected template dependency key must be 16 lowercase hex.');
}

const catalogue = JSON.parse(
	readFileSync(path.join(repositoryRoot, 'release', 'templates.json'), 'utf8')
);
const templates = [...(catalogue.templates ?? [])].sort((left, right) =>
	left.key.localeCompare(right.key)
);
if (templates.length === 0) fail('Template catalogue has no active templates.');

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'norbital-builder-verification-'));
const container = `norbital-builder-verification-${process.pid}-${Date.now()}`;
const results = [];
let packageKey;
let templateDependencyKey;

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
		'1g',
		'--memory-swap',
		'1g',
		image
	]);
	docker(['start', container]);
	const contract = JSON.parse(
		docker([
			'exec',
			'-u',
			'node',
			container,
			'node',
			'-e',
			[
				"const fs=require('node:fs');",
				`const manifest=${JSON.stringify(platformManifest)};`,
				'const env=process.env.NORBITAL_POD_PLATFORM_DIR;',
				"const platform=JSON.parse(fs.readFileSync(manifest,'utf8'));",
				"const result={env,platformKey:platform.packageKey,packageKey:fs.readFileSync('/opt/norbital/tenant-toolchain/.package-key','utf8').trim(),templateDependencyKey:fs.readFileSync('/opt/norbital/tenant-toolchain/.template-dependency-key','utf8').trim()};",
				'process.stdout.write(JSON.stringify(result));'
			].join('')
		])
	);
	if (contract.env !== '/opt/norbital/platform-client') {
		fail(`Builder platform environment is ${contract.env}.`);
	}
	packageKey = contract.packageKey;
	templateDependencyKey = contract.templateDependencyKey;
	if (packageKey !== expectedPackageKey || contract.platformKey !== expectedPackageKey) {
		fail('Builder package key and baked platform manifest do not match the release package key.');
	}
	if (templateDependencyKey !== expectedTemplateDependencyKey) {
		fail('Builder template dependency key does not match the checked-in dependency contract.');
	}

	for (const template of templates) {
		docker(['update', '--memory', '1g', '--memory-swap', '1g', container]);
		docker([
			'exec',
			'-u',
			'0',
			container,
			'sh',
			'-ec',
			"find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf '{}' +"
		]);
		const source = materializeTrackedTemplate(template, temporaryDirectory);
		docker(['cp', `${source}/.`, `${container}:/workspace`]);
		docker([
			'exec',
			'-u',
			'0',
			container,
			'sh',
			'-ec',
			'chown -R node:node /workspace; ln -s /opt/norbital/tenant-toolchain/node_modules /workspace/node_modules'
		]);
		const startedAt = process.hrtime.bigint();
		for (const command of ['sync', 'check']) {
			docker(['exec', '-u', 'node', '-w', '/workspace', container, 'node', podBin, command], {
				stdio: 'inherit'
			});
		}
		docker(['update', '--memory', buildMemory, '--memory-swap', buildMemory, container]);
		docker(
			[
				'exec',
				'-e',
				'NORBITAL_POD_SYNCED=1',
				'-e',
				'NORBITAL_POD_CHECKED=1',
				'-u',
				'node',
				'-w',
				'/workspace',
				container,
				'node',
				podBin,
				'build'
			],
			{ stdio: 'inherit' }
		);
		const elapsedMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
		results.push({
			key: template.key,
			elapsedMilliseconds: Number(elapsedMilliseconds.toFixed(3)),
			passed: true
		});
	}
} finally {
	spawnSync('docker', ['rm', '--force', container], {
		cwd: repositoryRoot,
		stdio: 'ignore'
	});
	rmSync(temporaryDirectory, { recursive: true, force: true });
}

const result = {
	$schema: '../release/builder-toolchain-verification.schema.json',
	schemaVersion: 1,
	image,
	packageKey,
	templateDependencyKey,
	platformManifest,
	network: 'none',
	staticVerificationMemoryLimitBytes: 1024 * 1024 * 1024,
	buildMemoryLimitBytes,
	templates: results,
	passed: results.length === templates.length && results.every((entry) => entry.passed)
};
const outputPath = path.resolve(
	repositoryRoot,
	options.output ??
		process.env.BUILDER_TOOLCHAIN_VERIFICATION_OUTPUT ??
		'dist/builder-toolchain-verification.json'
);
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
