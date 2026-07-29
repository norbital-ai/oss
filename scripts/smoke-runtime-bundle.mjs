import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digestPinnedImagePattern = /^.+@sha256:[0-9a-f]{64}$/;
const packageKeyPattern = /^[0-9a-f]{16}$/;
const dockerMemoryPattern = /^([1-9]\d*)([mg])$/;
const workspace = '/workspace';
const buildOutput = `${workspace}/.norbital/dist/output`;
const podBin =
	'/opt/norbital/tenant-toolchain/node_modules/@norbital-ai/pod/build/bin/invocation/index.js';
const viteBin = `${workspace}/node_modules/.bin/vite`;
const runtimeEntry = '/app/serve.mjs';
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
	const destination = path.join(temporaryDirectory, 'source');
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

function waitForRuntimeReady(arguments_, container, timeoutMilliseconds) {
	return new Promise((resolve, reject) => {
		const child = spawn('docker', arguments_, {
			cwd: repositoryRoot,
			stdio: ['pipe', 'pipe', 'pipe']
		});
		const readyFrame = Buffer.from('{"t":"ready"}');
		let stdout = Buffer.alloc(0);
		let stderr = '';
		let ready = false;
		let settled = false;
		const settle = (callback) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			callback();
		};
		const timer = setTimeout(() => {
			spawnSync('docker', ['rm', '--force', container], {
				cwd: repositoryRoot,
				stdio: 'ignore'
			});
			settle(() =>
				reject(
					new Error(
						`Runtime did not emit its ready frame within ${timeoutMilliseconds}ms: ${stderr}`
					)
				)
			);
		}, timeoutMilliseconds);
		child.stdout.on('data', (chunk) => {
			stdout = Buffer.concat([stdout, chunk]);
			if (!ready && stdout.includes(readyFrame)) {
				ready = true;
				spawnSync('docker', ['rm', '--force', container], {
					cwd: repositoryRoot,
					stdio: 'ignore'
				});
			}
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString('utf8');
		});
		child.on('error', (error) => settle(() => reject(error)));
		child.on('close', (code, signal) =>
			settle(() => {
				if (ready) resolve();
				else
					reject(
						new Error(`Runtime exited before ready (code=${code} signal=${signal}): ${stderr}`)
					);
			})
		);
	});
}

const options = argumentsFrom(process.argv.slice(2));
const builderImage = required(options, 'builder-image', 'BUILDER_IMAGE');
const runtimeImage = required(options, 'runtime-image', 'RUNTIME_IMAGE');
const expectedPackageKey = required(
	options,
	'expected-package-key',
	'EXPECTED_PLATFORM_PACKAGE_KEY'
);
if (!digestPinnedImagePattern.test(builderImage) || !digestPinnedImagePattern.test(runtimeImage)) {
	fail('Runtime smoke requires digest-pinned builder and runtime image references.');
}
if (!packageKeyPattern.test(expectedPackageKey)) {
	fail('Expected package key must be 16 lowercase hex.');
}

const localBuildMemory = options['local-emulation-build-memory'];
if (localBuildMemory && !builderImage.startsWith('localhost:')) {
	fail('The local emulation memory override only accepts a loopback registry builder image.');
}
const buildMemory = localBuildMemory ?? '500m';
const buildMemoryLimitBytes = memoryBytes(buildMemory);
const templateKey = options.template ?? process.env.RUNTIME_SMOKE_TEMPLATE ?? 'hr-payroll';
const catalogue = JSON.parse(
	readFileSync(path.join(repositoryRoot, 'release', 'templates.json'), 'utf8')
);
const template = catalogue.templates?.find((entry) => entry.key === templateKey);
if (!template) fail(`Runtime smoke template must be an active catalogue entry: ${templateKey}`);
const outputPath = path.resolve(
	repositoryRoot,
	options.output ?? process.env.RUNTIME_SMOKE_OUTPUT ?? 'dist/runtime-smoke.json'
);

mkdirSync(path.join(repositoryRoot, '.tmp'), { recursive: true });
const temporaryDirectory = mkdtempSync(path.join(repositoryRoot, '.tmp', 'runtime-smoke-'));
const source = materializeTrackedTemplate(template, temporaryDirectory);
const bundle = path.join(temporaryDirectory, 'bundle');
const builderContainer = `norbital-runtime-smoke-builder-${process.pid}-${Date.now()}`;
const runtimeContainer = `norbital-runtime-smoke-guest-${process.pid}-${Date.now()}`;
let packageKey;
let buildElapsedMilliseconds;
let serveEntrySha256;

try {
	console.log(`Clean-pulling ${builderImage}.`);
	docker(['pull', '--platform', 'linux/amd64', builderImage], { stdio: 'inherit' });
	console.log(`Clean-pulling ${runtimeImage}.`);
	docker(['pull', '--platform', 'linux/amd64', runtimeImage], { stdio: 'inherit' });

	docker([
		'create',
		'--platform',
		'linux/amd64',
		'--name',
		builderContainer,
		'--network',
		'none',
		'--memory',
		buildMemory,
		'--memory-swap',
		buildMemory,
		builderImage
	]);
	docker(['cp', `${source}/.`, `${builderContainer}:${workspace}`]);
	docker(['start', builderContainer]);
	docker([
		'exec',
		'-u',
		'0',
		builderContainer,
		'sh',
		'-ec',
		`chown -R node:node ${workspace}; rm -rf ${workspace}/node_modules; ln -s /opt/norbital/tenant-toolchain/node_modules ${workspace}/node_modules`
	]);
	packageKey = docker([
		'exec',
		'-u',
		'node',
		builderContainer,
		'cat',
		'/opt/norbital/tenant-toolchain/.package-key'
	]);
	if (packageKey !== expectedPackageKey) {
		fail(`Builder package key ${packageKey} does not match expected ${expectedPackageKey}.`);
	}
	docker(['exec', '-u', 'node', '-w', workspace, builderContainer, 'node', podBin, 'sync'], {
		stdio: 'inherit'
	});
	const buildStartedAt = process.hrtime.bigint();
	docker(productionBuildArguments(builderContainer), { stdio: 'inherit' });
	buildElapsedMilliseconds = Number(process.hrtime.bigint() - buildStartedAt) / 1_000_000;
	mkdirSync(bundle, { recursive: true });
	docker(['cp', `${builderContainer}:${buildOutput}/.`, bundle]);

	for (const requiredPath of requiredBundlePaths) {
		const file = path.join(bundle, requiredPath);
		if (!statSync(file).isFile() || statSync(file).size === 0) {
			fail(`Published builder output is missing non-empty ${requiredPath}.`);
		}
	}
	serveEntrySha256 = createHash('sha256')
		.update(readFileSync(path.join(bundle, 'serve.mjs')))
		.digest('hex');

	console.log(`Booting ${runtimeEntry} from the clean builder bundle in ${runtimeImage}.`);
	await waitForRuntimeReady(
		[
			'run',
			'-i',
			'--rm',
			'--platform',
			'linux/amd64',
			'--name',
			runtimeContainer,
			'--network',
			'none',
			'--read-only',
			'--tmpfs',
			'/tmp:rw,size=64m,mode=1777',
			'--memory',
			'500m',
			'--memory-swap',
			'500m',
			'--cpus',
			'1',
			'--pids-limit',
			'256',
			'--cap-drop',
			'ALL',
			'--security-opt',
			'no-new-privileges',
			'--mount',
			`type=bind,src=${bundle},dst=/app,readonly`,
			runtimeImage,
			'node',
			runtimeEntry
		],
		runtimeContainer,
		20_000
	);
} finally {
	for (const container of [runtimeContainer, builderContainer]) {
		spawnSync('docker', ['rm', '--force', container], {
			cwd: repositoryRoot,
			stdio: 'ignore'
		});
	}
	rmSync(temporaryDirectory, { recursive: true, force: true });
}

const result = {
	$schema: '../release/runtime-smoke.schema.json',
	schemaVersion: 1,
	builderImage,
	runtimeImage,
	packageKey,
	template: templateKey,
	network: 'none',
	buildMemoryLimitBytes,
	runtimeMemoryLimitBytes: 500 * 1024 * 1024,
	buildCommand: 'env NORBITAL_POD_CHECKED=1 vite build /workspace',
	buildElapsedMilliseconds: Number(buildElapsedMilliseconds.toFixed(3)),
	requiredBundlePaths,
	runtimeEntry,
	serveEntrySha256,
	readyFrame: { t: 'ready' },
	passed: true
};
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
