import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const buildScript = path.join(repositoryRoot, 'scripts/build-package.mjs');

/** Run the build wrapper and return the exit status and combined output instead of throwing. */
function runBuild(packageRoot, arguments_) {
	try {
		execFileSync(process.execPath, [buildScript, ...arguments_], {
			cwd: packageRoot,
			stdio: 'pipe'
		});
		return { status: 0, output: '' };
	} catch (cause) {
		return {
			status: cause.status,
			output: `${cause.stdout ?? ''}${cause.stderr ?? ''}`
		};
	}
}

/** A package that emits `emitted` (a map of staged path to contents) and declares `manifest`. */
function scaffoldPackage(manifest, emitted) {
	const packageRoot = mkdtempSync(path.join(tmpdir(), 'norbital-build-package-'));
	writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify(manifest));
	const emitter = path.join(packageRoot, 'emit.mjs');
	writeFileSync(
		emitter,
		`import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const output = process.argv[2];
for (const [relative, contents] of ${JSON.stringify(Object.entries(emitted))}) {
	mkdirSync(path.join(output, path.dirname(relative)), { recursive: true });
	writeFileSync(path.join(output, relative), contents);
}
`
	);
	return { packageRoot, emitter };
}

test('keeps a generated package binary executable for npm publication', () => {
	const packageRoot = mkdtempSync(path.join(tmpdir(), 'norbital-build-package-'));
	writeFileSync(
		path.join(packageRoot, 'package.json'),
		JSON.stringify({ name: 'probe', bin: { probe: './build/bin/probe.js' } })
	);
	const emitter = path.join(packageRoot, 'emit.mjs');
	writeFileSync(
		emitter,
		`import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const output = process.argv[2];
mkdirSync(path.join(output, 'bin'), { recursive: true });
writeFileSync(path.join(output, 'bin/probe.js'), '#!/usr/bin/env node\\n');
`
	);

	execFileSync(process.execPath, [buildScript, process.execPath, emitter, '{}'], {
		cwd: packageRoot,
		stdio: 'pipe'
	});

	const binary = path.join(packageRoot, 'build/bin/probe.js');
	assert.equal(readFileSync(binary, 'utf8'), '#!/usr/bin/env node\n');
	assert.notEqual(statSync(binary).mode & 0o111, 0);
});

test('refuses to compile against a workspace dependency that has not been built', () => {
	const dependencyRoot = mkdtempSync(path.join(tmpdir(), 'norbital-build-dependency-'));
	writeFileSync(
		path.join(dependencyRoot, 'package.json'),
		JSON.stringify({ name: '@probe/dep', scripts: { build: 'noop' } })
	);
	const { packageRoot, emitter } = scaffoldPackage(
		{ name: 'probe', dependencies: { '@probe/dep': 'workspace:*' } },
		{ 'index.js': 'export {};\n' }
	);
	mkdirSync(path.join(packageRoot, 'node_modules/@probe'), { recursive: true });
	symlinkSync(dependencyRoot, path.join(packageRoot, 'node_modules/@probe/dep'));

	const failed = runBuild(packageRoot, [process.execPath, emitter, '{}']);
	assert.equal(failed.status, 1);
	assert.match(failed.output, /@probe\/dep has no build output/);
	assert.equal(existsSync(path.join(packageRoot, 'build')), false);

	// The same build succeeds the moment the dependency has output to compile against.
	mkdirSync(path.join(dependencyRoot, 'build'), { recursive: true });
	writeFileSync(path.join(dependencyRoot, 'build/index.js'), 'export {};\n');
	assert.equal(runBuild(packageRoot, [process.execPath, emitter, '{}']).status, 0);
});

test('discards a build whose declarations degraded to `any`', () => {
	const { packageRoot, emitter } = scaffoldPackage(
		{ name: 'probe' },
		{ 'index.d.ts': 'export declare const schema: any;\n' }
	);

	const failed = runBuild(packageRoot, [process.execPath, emitter, '{}']);
	assert.equal(failed.status, 1);
	assert.match(failed.output, /index\.d\.ts:1/);
	// Nothing is swapped in, so a poisoned emit can never be packed or published.
	assert.equal(existsSync(path.join(packageRoot, 'build')), false);
	assert.equal(existsSync(path.join(packageRoot, 'build.staging')), false);
});

test('reads `any` in a doc comment as prose rather than a degraded type', () => {
	const { packageRoot, emitter } = scaffoldPackage(
		{ name: 'probe' },
		{
			'index.d.ts':
				'/** Rejects any payload the host did not sign. */\nexport declare const guard: (value: string) => boolean;\n'
		}
	);
	assert.equal(runBuild(packageRoot, [process.execPath, emitter, '{}']).status, 0);
});

test('accepts `any` as a declared property name while still rejecting the any type', () => {
	const valid = scaffoldPackage(
		{ name: 'probe' },
		{
			'index.d.ts':
				'export interface MatcherSet { any: ReadonlyArray<string>; }\nexport declare const set: MatcherSet;\n'
		}
	);
	assert.equal(runBuild(valid.packageRoot, [process.execPath, valid.emitter, '{}']).status, 0);

	const invalid = scaffoldPackage(
		{ name: 'probe' },
		{ 'index.d.ts': 'export interface MatcherSet { any: ReadonlyArray<any>; }\n' }
	);
	const failed = runBuild(invalid.packageRoot, [process.execPath, invalid.emitter, '{}']);
	assert.equal(failed.status, 1);
	assert.match(failed.output, /index\.d\.ts:1/);
});
