import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const buildScript = path.join(repositoryRoot, 'scripts/build-package.mjs');

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
