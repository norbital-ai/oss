// @vitest-environment happy-dom
// `/test/browser`'s Chromium (L-BOLT-1011): the workspace's own playwright, headless unless PLAYWRIGHT_HEADED=1 (or
// `{ headed }`), loopback only; a workspace without playwright gets a message that says what to install.
import './setup-happy-dom.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { chromium, headed } from '../src/test/browser.ts';

const scratch = join(tmpdir(), 'norbital-scratch', `kit-browser-${randomUUID()}`);
const cwd = process.cwd();
afterEach(() => { process.chdir(cwd); vi.unstubAllEnvs(); });
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

it('launches the workspace playwright headless by default and headed on PLAYWRIGHT_HEADED=1, loopback only', async () => {
	const pkg = join(scratch, 'ws/node_modules/playwright');
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(scratch, 'ws/package.json'), JSON.stringify({ name: 'ws', private: true, type: 'module' }));
	writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'playwright', type: 'module', exports: { '.': './index.js' } }));
	writeFileSync(join(pkg, 'index.js'), 'export const chromium = { launch: async (o) => o };');
	process.chdir(join(scratch, 'ws'));
	vi.stubEnv('PLAYWRIGHT_HEADED', '');
	expect(headed()).toBe(false);
	const quiet = await chromium<{ headless: boolean; args: string[] }>();
	expect(quiet.headless).toBe(true);
	expect(quiet.args.join(' ')).toContain('MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1');
	vi.stubEnv('PLAYWRIGHT_HEADED', '1');
	expect((await chromium<{ headless: boolean }>()).headless).toBe(false);
	expect((await chromium<{ headless: boolean }>({ headed: false })).headless).toBe(true);
});

it('names what to install when the workspace has no playwright', async () => {
	mkdirSync(join(scratch, 'bare'), { recursive: true });
	writeFileSync(join(scratch, 'bare/package.json'), '{}');
	process.chdir(join(scratch, 'bare'));
	await expect(chromium()).rejects.toThrow(/playwright is not installed/);
});
