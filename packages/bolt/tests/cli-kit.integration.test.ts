/// <reference types="node" />
// `bolt test` (§3.7) on a workspace with no vitest config and no DOM plumbing of its own: the CLI writes the type setup
// and runs vitest with the kit preconfigured, so `@norbital-ai/bolt/test` compiles the workspace from `root` in a node
// test and in a happy-dom control interaction; a workspace's own vitest config still
// applies. The package's `bin` is the next CLI.
import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { randomUUID } from 'node:crypto';
import {
	cpSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll } from 'vitest';
import { Schema } from 'effect';
import { expect, it } from '@effect/vitest';

const PKG = join(fileURLToPath(import.meta.url), '../..');
const FIXTURE = join(PKG, 'tests/fixtures/good');
const scratch = join(tmpdir(), 'norbital-scratch', `cli-kit-${randomUUID()}`);
const root = join(scratch, 'good');
const write = (path: string, text: string) => {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, text);
};

/** The good fixture as a template checkout: its own package, type setup and installed dependencies. */
const workspace = (at: string) => {
	cpSync(FIXTURE, at, { recursive: true, filter: (p) => !p.includes('.norbital') });
	for (const f of readdirSync(join(at, 'src'), { recursive: true })
		.map(String)
		.filter((f) => f.endsWith('.ts'))) {
		const p = join(at, 'src', f);
		writeFileSync(
			p,
			readFileSync(p, 'utf8').replace(/'(\.\.\/)+src\/index\.ts'/g, "'@norbital-ai/bolt'")
		);
	}
	write(
		join(at, 'package.json'),
		JSON.stringify({
			name: 'good',
			private: true,
			type: 'module',
			// its own `bolt test`, as a template's script names it
			scripts: {
				test: `node --no-node-snapshot --no-experimental-webstorage ${join(PKG, 'src/cli/main.ts')} test`
			},
			dependencies: { '@norbital-ai/ui': 'workspace:*', svelte: '*' },
			devDependencies: { vitest: '*', 'happy-dom': '*' }
		})
	);
	write(join(at, 'tsconfig.json'), JSON.stringify({ extends: './.norbital/tsconfig.json' }));
	write(join(at, 'pnpm-workspace.yaml'), 'verifyDepsBeforeRun: false\n'); // the linked node_modules is not an install
	symlinkSync(join(PKG, 'node_modules'), join(at, 'node_modules')); // vitest, happy-dom and svelte, as a template installs them
};

beforeAll(() => {
	workspace(root);
	write(join(root, 'src/lib/cache.bin'), 'bytes\u0000!');
	write(
		join(root, 'src/+workspace.ts'),
		`import cacheBytes from './lib/cache.bin?bytes';
if (cacheBytes.length !== 7) throw new Error('The cached asset changed.');
${readFileSync(join(root, 'src/+workspace.ts'), 'utf8')}`
	);
	write(
		join(root, 'tests/node.test.ts'),
		`import { Effect } from 'effect';
import { check, expect, layer, TestWorkspace } from '@norbital-ai/bolt/test';
layer(TestWorkspace.layer({ root: process.cwd() }))('workspace', (it) => {
	it.effect('compiles the workspace from root', () => Effect.gen(function* () {
		const t = yield* TestWorkspace;
		expect(Object.keys(t.manifest.models)).toContain('customers');
		const compiled = yield* check(process.cwd());
		expect(Object.values(compiled.guest?.assets ?? {}).map((bytes) => [...bytes])).toEqual([[98, 121, 116, 101, 115, 0, 33]]);
		expect(compiled.guest?.sourceMap).toContain('"version":3');
	}));
});
`
	);
	write(
		join(root, 'tests/control.svelte'),
		`<script lang="ts">
import { Button } from '@norbital-ai/ui';
let count = $state(0);
</script>
<Button onclick={() => count++}>Save</Button><output>{count}</output>
`
	);
	write(
		join(root, 'tests/dom.test.ts'),
		`// @vitest-environment happy-dom
import { Effect } from 'effect';
import { check, expect, layer, TestWorkspace } from '@norbital-ai/bolt/test';
import { flushSync, mount, unmount } from 'svelte';
import Control from './control.svelte';
layer(TestWorkspace.layer({ root: process.cwd() }), { excludeTestServices: true })('workspace DOM', (it) => {
it.effect('compiles from root and runs a current control interaction', () => Effect.gen(function* () {
	const t = yield* TestWorkspace;
	expect(Object.keys(t.manifest.models)).toContain('customers');
	const compiled = yield* check(process.cwd());
	expect(Object.values(compiled.guest?.assets ?? {}).map((bytes) => [...bytes])).toEqual([[98, 121, 116, 101, 115, 0, 33]]);
	expect(compiled.guest?.sourceMap).toContain('"version":3');
	const target = document.body.appendChild(document.createElement('div'));
	const app = flushSync(() => mount(Control, { target }));
	try {
		const button = target.querySelector('button');
		if (button === null) throw new Error('Missing Save control');
		button.click();
		flushSync();
		expect(target.querySelector('output')?.textContent).toBe('1');
	} finally {
		yield* Effect.promise(() => unmount(app));
		target.remove();
	}
}));
});
`
	);
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// one `bolt test` run (a vitest start is ~25 s): a workspace config with an inline project (the node suite) and a
// config-file project bringing its own svelte plugin (the DOM suite); the kit reaches both, and svelte compiles once
it("bolt test runs a template's node and DOM suites through its own vitest projects, the kit in each", () => {
	write(
		join(root, 'vitest.dom.config.ts'),
		`import { svelte } from '@sveltejs/vite-plugin-svelte';
export default { plugins: [svelte()], test: { name: 'file', include: ['tests/dom.test.ts'], execArgv: ['--no-node-snapshot', '--no-experimental-webstorage'] } };
`
	);
	write(
		join(root, 'vitest.config.ts'),
		`export default { test: { projects: [{ test: { name: 'inline', include: ['tests/node.test.ts'], execArgv: ['--no-node-snapshot', '--no-experimental-webstorage'] } }, 'vitest.dom.config.ts'] } };\n`
	);
	const r = spawnSync(
		process.execPath,
		[
			'--no-node-snapshot',
			'--no-experimental-webstorage',
			join(PKG, 'src/cli/main.ts'),
			'test',
			root,
			'--',
			'--maxWorkers=1'
		],
		{
			encoding: 'utf8',
			timeout: 240_000
		}
	);
	const output = stripVTControlCharacters(`${r.stdout}\n${r.stderr}`);
	expect(output).toMatch(/Tests\s+2 passed/);
	expect(r.status, output).toBe(0);
}, 250_000);

// one `bolt templates test` run from a repository root: each template through its own `bolt test`, in its own root,
// compiling its own workspace
it('bolt templates test runs every template through its own bolt test', () => {
	const repository = join(scratch, 'repository');
	for (const slug of ['alpha', 'beta']) {
		const at = join(repository, slug);
		workspace(at);
		write(
			join(at, 'norbital.template.json'),
			JSON.stringify({
				schemaVersion: 1,
				key: `norbital_${slug}`,
				name: slug,
				industry: 'Operations',
				description: 'Fixture workspace',
				visibility: 'public',
				counts: { models: 0, apps: 0, automations: 0 },
				tags: []
			})
		);
		write(
			join(at, 'tests/node.test.ts'),
			`import { Effect } from 'effect';
import { expect, layer, TestWorkspace } from '@norbital-ai/bolt/test';
const root = process.cwd();
layer(TestWorkspace.layer({ root }))('workspace', (it) => {
	it.effect('starts in its own template and compiles it', () => Effect.gen(function* () {
		expect(root.endsWith('/${slug}')).toBe(true);
		const t = yield* TestWorkspace;
		expect(Object.keys(t.manifest.models)).toContain('customers');
	}));
});
`
		);
	}
	const r = spawnSync(
		process.execPath,
		[
			'--no-node-snapshot',
			'--no-experimental-webstorage',
			join(PKG, 'src/cli/main.ts'),
			'templates',
			'test'
		],
		{ cwd: repository, encoding: 'utf8', timeout: 240_000 }
	);
	const output = stripVTControlCharacters(`${r.stdout}\n${r.stderr}`);
	expect(output).toMatch(/alpha: Test Files\s+1 passed.*Tests\s+1 passed/);
	expect(output).toMatch(/beta: Test Files\s+1 passed.*Tests\s+1 passed/);
	expect(r.status, output).toBe(0);
}, 250_000);

it('installs the next CLI as `bolt`', () => {
	const { bin } = Schema.decodeUnknownSync(
		Schema.fromJsonString(Schema.Struct({ bin: Schema.Struct({ bolt: Schema.String }) }))
	)(readFileSync(join(PKG, 'package.json'), 'utf8'));
	expect(bin.bolt).toBe('./build/cli/main.js');
	expect(readFileSync(join(PKG, 'src/cli/main.ts'), 'utf8')).toMatch(
		/^#!\/usr\/bin\/env -S node --no-node-snapshot\n/
	);
});
