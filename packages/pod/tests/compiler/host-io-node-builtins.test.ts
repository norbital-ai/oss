import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBuilder } from 'vite';
import { pod } from '../../src/vite/index.js';
import { linkCurrentPodWorkspaceDependencies } from '../support/current-package-node-modules.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const roots: string[] = [];

async function write(root: string, relative: string, source: string): Promise<void> {
	const file = path.join(root, relative);
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, source);
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('server compile leaves node builtins external', () => {
	it('does not ship unenv, guest-compat, or a nodeless alias map', async () => {
		const source = await readFile(new URL('../../src/vite/index.ts', import.meta.url), 'utf8');
		expect(source).toContain('HOST_IO_NODE_BUILTINS');
		expect(source).not.toContain('unenv');
		expect(source).not.toContain('guest-compat');
		expect(source).not.toContain("external: (id: string) => id.startsWith('node:')");
	});

	it('builds a server artifact that still imports host-resolved node builtins', async () => {
		const parent = path.join(REPO_ROOT, '.test-workspaces');
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(path.join(parent, 'node-externals-'));
		roots.push(root);
		await write(root, 'package.json', JSON.stringify({ name: 'node-externals', type: 'module' }));
		await linkCurrentPodWorkspaceDependencies(REPO_ROOT, root);
		await write(
			root,
			'src/collections/things/+model.ts',
			`import { defineModel, text } from '@norbital-ai/pod/authoring';
export default defineModel({ name: text().notNull() });`
		);
		await write(root, 'src/collections/+relationship.ts', `export default () => ({});`);
		await write(
			root,
			'src/apps/+home.svelte',
			`<svelte:head>
	<title>Home</title>
	<meta name="description" content="Home" />
	<meta name="pod:icon" content="lucide:home" />
</svelte:head>
<p>{t('home.greeting')}</p>`
		);
		await write(root, 'src/i18n/messages.en.json', JSON.stringify({ 'home.greeting': 'Welcome' }));
		await write(root, 'src/i18n/messages.zh.json', JSON.stringify({ 'home.greeting': '欢迎' }));

		const previous = {
			target: process.env.NORBITAL_POD_BUILD_TARGET,
			checked: process.env.NORBITAL_POD_CHECKED
		};
		process.env.NORBITAL_POD_BUILD_TARGET = 'server';
		process.env.NORBITAL_POD_CHECKED = '1';
		const started = Date.now();
		try {
			const builder = await createBuilder({
				root,
				configFile: false,
				logLevel: 'error',
				plugins: pod()
			});
			await builder.buildApp();
		} finally {
			if (previous.target == null) delete process.env.NORBITAL_POD_BUILD_TARGET;
			else process.env.NORBITAL_POD_BUILD_TARGET = previous.target;
			if (previous.checked == null) delete process.env.NORBITAL_POD_CHECKED;
			else process.env.NORBITAL_POD_CHECKED = previous.checked;
		}
		const elapsedMs = Date.now() - started;
		const artifact = await readFile(path.join(root, '.norbital/dist/output/server/index.js'), 'utf8');
		expect(elapsedMs).toBeLessThan(5000);
		expect(artifact.length).toBeLessThan(2_000_000);
		expect(artifact).toMatch(/from ["']node:async_hooks["']/);
		expect(artifact).toMatch(/from ["']node:crypto["']/);
		expect(artifact).toMatch(/from ["']node:buffer["']/);
		expect(artifact).not.toContain('@neondatabase/serverless');
		expect(artifact).not.toContain('neon-serverless');
		expect(artifact).not.toContain('unenv');
	}, 20_000);
});
