/**
 * Config lives under `.norbital/config/doctor/`. YAML extensions beside it join
 * automatically; generated trees under `.norbital` do not.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DOCTOR_CONFIG_DIRECTORY, findConfig, loadConfig } from '../build/index.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

function repository(name: string, files: Readonly<Record<string, string>>): string {
	const root = mkdtempSync(join(tmpdir(), `probe-${name}-`));
	for (const [file, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), contents);
	}
	execFileSync('git', ['init', '-q'], { cwd: root });
	execFileSync('git', ['add', '-A'], { cwd: root });
	return root;
}

const YAML_RULE = [
	'id: HOUSE1',
	'summary: raw fetch bypasses the http client',
	'severity: error',
	'principles: [straightforwardness]',
	'rule:',
	'  pattern: fetch($...ARGS)',
	''
].join('\n');

const CONFIG = `import { defineConfig } from '${packageRoot}build/index.js';
export default defineConfig({ packs: ['norbital'] });
`;

const REACTIVE_CONFIG = `import { defineConfig } from '${packageRoot}build/index.js';
export default defineConfig({ packs: ['norbital/reactive'] });
`;

test('findConfig prefers .norbital/config/doctor over a root-level file', () => {
	const root = repository('prefer-nested', {
		'doctor.config.mts': CONFIG,
		[`${DOCTOR_CONFIG_DIRECTORY}/doctor.config.mts`]: CONFIG
	});
	try {
		assert.equal(findConfig(root), join(root, DOCTOR_CONFIG_DIRECTORY, 'doctor.config.mts'));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('findConfig still loads a root-level config when the conventional directory is empty', () => {
	const root = repository('root-fallback', {
		'doctor.config.ts': CONFIG
	});
	try {
		assert.equal(findConfig(root), join(root, 'doctor.config.ts'));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('YAML beside the nested config joins without an explicit patterns glob', async () => {
	const root = repository('nested-yaml', {
		[`${DOCTOR_CONFIG_DIRECTORY}/doctor.config.mts`]: CONFIG,
		[`${DOCTOR_CONFIG_DIRECTORY}/no-raw-fetch.yaml`]: YAML_RULE,
		'src/a.ts': 'export const load = () => fetch("/api");\n'
	});
	try {
		const loaded = await loadConfig(root);
		assert.equal(loaded.configPath, join(root, DOCTOR_CONFIG_DIRECTORY, 'doctor.config.mts'));
		assert.equal(
			loaded.rules.some((rule) => rule.id === 'HOUSE1'),
			true,
			`expected HOUSE1 from ${DOCTOR_CONFIG_DIRECTORY}, got ${loaded.rules.map((rule) => rule.id).join(',')}`
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('loads the reactive product pack by name without a config-side package import', async () => {
	const root = repository('named-reactive-pack', {
		[`${DOCTOR_CONFIG_DIRECTORY}/doctor.config.mts`]: REACTIVE_CONFIG
	});
	try {
		const loaded = await loadConfig(root);
		assert.deepEqual(loaded.packs, ['norbital/reactive']);
		assert.equal(
			loaded.rules.some((rule) => rule.id.startsWith('REACT')),
			true
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('YAML under .norbital/diagnosis is generated output and is not loaded', async () => {
	const root = repository('skip-diagnosis', {
		[`${DOCTOR_CONFIG_DIRECTORY}/doctor.config.mts`]: CONFIG,
		'.norbital/diagnosis/noise.yaml': YAML_RULE
	});
	try {
		const loaded = await loadConfig(root);
		assert.equal(
			loaded.rules.some((rule) => rule.id === 'HOUSE1'),
			false
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
