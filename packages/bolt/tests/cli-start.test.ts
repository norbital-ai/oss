/// <reference types="node" />
// `bolt start` runs bolt-server's `main` from the package root export (L-BOLT-1035): the CLI resolves
// `@norbital-ai/bolt-server` from the workspace and hands it the argv; the real package exports `.` with a `main`.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import { main } from '../src/cli/main.ts';

const scratch = join(tmpdir(), 'norbital-scratch', `cli-start-${randomUUID()}`);
const cwd = process.cwd();
afterAll(() => { process.chdir(cwd); rmSync(scratch, { recursive: true, force: true }); });

it('bolt start calls the resolved bolt-server main with the rest of the argv', async () => {
	const pkg = join(scratch, 'node_modules/@norbital-ai/bolt-server');
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'ws', private: true, type: 'module' }));
	writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@norbital-ai/bolt-server', type: 'module', exports: { '.': { default: './index.js' } } }));
	writeFileSync(join(pkg, 'index.js'), 'export async function main(argv) { return argv.length === 2 && argv[0] === "--port=1" ? 7 : 3; }');
	process.chdir(scratch);
	expect(await main(['start', '--port=1', 'x'])).toBe(7);
});

it('the real bolt-server exports `.` with a main, and nothing named /next', () => {
	const root = join(fileURLToPath(import.meta.url), '../../../bolt-server');
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { exports: Record<string, unknown> };
	expect(Object.keys(pkg.exports)).toEqual(['.']);
	expect(readFileSync(join(root, 'src/index.ts'), 'utf8')).toMatch(/export \{ main \}/);
	expect(readFileSync(join(fileURLToPath(import.meta.url), '../../src/cli/main.ts'), 'utf8')).not.toMatch(/bolt-server\/next/);
});
