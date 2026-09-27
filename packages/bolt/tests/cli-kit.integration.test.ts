/// <reference types="node" />
// `bolt test` (§3.7) on a workspace with no vitest config and no DOM plumbing of its own: the CLI writes the type setup
// and runs vitest with the kit preconfigured, so `@norbital-ai/bolt/test` compiles the workspace from `root` in a node
// test and in a happy-dom test, and `/test/browser`'s sweep mounts the shell there; a workspace's own vitest config still
// applies. The package's `bin` is the next CLI.
import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';

const PKG = join(fileURLToPath(import.meta.url), '../..');
const FIXTURE = join(PKG, 'tests/fixtures/good');
const scratch = join(tmpdir(), 'norbital-scratch', `cli-kit-${randomUUID()}`);
const root = join(scratch, 'good');
const write = (path: string, text: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };

beforeAll(() => {
	cpSync(FIXTURE, root, { recursive: true, filter: (p) => !p.includes('.norbital') });
	for (const f of readdirSync(join(root, 'src'), { recursive: true }).map(String).filter((f) => f.endsWith('.ts'))) {
		const p = join(root, 'src', f);
		writeFileSync(p, readFileSync(p, 'utf8').replace(/'(\.\.\/)+src\/index\.ts'/g, "'@norbital-ai/bolt'"));
	}
	write(join(root, 'package.json'), JSON.stringify({ name: 'good', private: true, type: 'module',
		dependencies: { '@norbital-ai/ui': 'workspace:*', svelte: '*' }, devDependencies: { vitest: '*', 'happy-dom': '*' } }));
	write(join(root, 'tsconfig.json'), JSON.stringify({ extends: './.norbital/tsconfig.json' }));
	symlinkSync(join(PKG, 'node_modules'), join(root, 'node_modules'));   // vitest, happy-dom and svelte, as a template installs them
	write(join(root, 'tests/node.test.ts'), `import { expect, it } from 'vitest';
import { testWorkspace } from '@norbital-ai/bolt/test';
it('compiles the workspace from root', async () => {
	const t = await testWorkspace({ root: process.cwd() });
	expect(Object.keys(t.manifest.models)).toContain('customers');
});
`);
	write(join(root, 'tests/dom.test.ts'), `// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { testWorkspace } from '@norbital-ai/bolt/test';
import { sweep } from '@norbital-ai/bolt/test/browser';
it('compiles from root and sweeps in a DOM environment', async () => {
	const t = await testWorkspace({ root: process.cwd() });
	localStorage.setItem('k', 'v');
	expect(localStorage.getItem('k')).toBe('v');
	const report = await sweep(t, { as: [{ admin: true }] });
	expect(report.visited.length).toBeGreaterThan(0);
});
`);
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// one `bolt test` run (a vitest start is ~25 s): a workspace config with an inline project (the node suite) and a
// config-file project bringing its own svelte plugin (the DOM suite); the kit reaches both, and svelte compiles once
it('bolt test runs a template\'s node and DOM suites through its own vitest projects, the kit in each', () => {
	write(join(root, 'vitest.dom.config.ts'), `import { svelte } from '@sveltejs/vite-plugin-svelte';
export default { plugins: [svelte()], test: { name: 'file', include: ['tests/dom.test.ts'] } };
`);
	write(join(root, 'vitest.config.ts'), `export default { test: { projects: [{ test: { name: 'inline', include: ['tests/node.test.ts'] } }, 'vitest.dom.config.ts'] } };\n`);
	const r = spawnSync(process.execPath, [join(PKG, 'src/cli/main.ts'), 'test', root], { encoding: 'utf8', timeout: 240_000 });
	expect(stripVTControlCharacters(`${r.stdout}\n${r.stderr}`)).toMatch(/Tests\s+2 passed/);
	expect(r.status).toBe(0);
}, 250_000);

it('installs the next CLI as `bolt`', () => {
	const { bin } = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as { bin: { bolt: string } };
	expect(bin.bolt).toBe('./build/cli/main.js');
	expect(readFileSync(join(PKG, 'src/cli/main.ts'), 'utf8')).toMatch(/^#!\/usr\/bin\/env node/);
});
