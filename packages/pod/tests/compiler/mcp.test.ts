import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineMcpServer } from '../../src/authoring/mcp/define-mcp-server.js';
import { compilePodFilesystem, discoverPodFilesystem } from '../../src/vite/compiler/index.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const temporaryRoots: string[] = [];

async function write(root: string, relative: string, source: string): Promise<void> {
	const file = path.join(root, relative);
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, source);
}

async function workspace(): Promise<string> {
	const parent = path.join(REPO_ROOT, '.test-workspaces');
	await mkdir(parent, { recursive: true });
	const root = await mkdtemp(path.join(parent, 'mcp-'));
	temporaryRoots.push(root);
	await write(root, 'package.json', JSON.stringify({ name: 'mcp-conformance' }));
	await symlink(
		path.join(REPO_ROOT, 'template_workspaces/construction/node_modules'),
		path.join(root, 'node_modules')
	);
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
	await write(
		root,
		'src/i18n/messages.en.json',
		JSON.stringify({ 'home.greeting': 'Welcome' }, null, '\t')
	);
	await write(
		root,
		'src/i18n/messages.zh.json',
		JSON.stringify({ 'home.greeting': '欢迎' }, null, '\t')
	);
	return root;
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
});

describe('workspace MCP servers', () => {
	it('carries a declared server into the generated workspace', async () => {
		const root = await workspace();
		await write(
			root,
			'src/mcp/+stripe.mcp.ts',
			`import { defineMcpServer } from '@norbital-ai/pod/authoring';
export default defineMcpServer({
	description: 'Stripe account tools for invoicing in this workspace.',
	url: 'https://mcp.stripe.com/mcp',
	tools: ['list_customers']
});`
		);

		const structure = await discoverPodFilesystem(root);
		expect(structure.diagnostics).toEqual([]);
		expect(structure.mcpServers).toEqual([
			{
				id: 'stripe',
				path: 'src/mcp/+stripe.mcp',
				source: 'src/mcp/+stripe.mcp.ts'
			}
		]);

		const compiled = await compilePodFilesystem({ root });
		expect(compiled.diagnostics).toEqual([]);
		const generated = await readFile(path.join(root, '.norbital/generated/workspace.ts'), 'utf8');
		expect(generated).toContain('mcpServers');
		expect(generated).toContain('stripe');
	});

	it('names every way a server file can fail instead of dropping it', async () => {
		const root = await workspace();
		await write(root, 'src/mcp/+Stripe.mcp.ts', 'export default {};');
		await write(root, 'src/mcp/nested/ignored.ts', 'export default {};');

		const structure = await discoverPodFilesystem(root);
		expect(
			structure.diagnostics
				.filter((diagnostic) => diagnostic.code.startsWith('MCP_'))
				.map((diagnostic) => [diagnostic.code, diagnostic.file])
		).toEqual([
			['MCP_NAME_INVALID', 'src/mcp/+Stripe.mcp.ts'],
			['MCP_UNEXPECTED_DIRECTORY', 'src/mcp/nested']
		]);
	});
});

describe('defineMcpServer', () => {
	it('refuses an empty allowlist, empty description, or a non-http url', () => {
		expect(() =>
			defineMcpServer({
				description: 'Stripe',
				url: 'https://mcp.stripe.com/mcp',
				tools: []
			})
		).toThrow(/tools cannot be empty/);
		expect(() =>
			defineMcpServer({
				description: '   ',
				url: 'https://mcp.stripe.com/mcp',
				tools: ['list_customers']
			})
		).toThrow(/description cannot be empty/);
		expect(() =>
			defineMcpServer({
				description: 'Stripe',
				url: 'ftp://mcp.stripe.com/mcp',
				tools: ['list_customers']
			})
		).toThrow(/absolute http/);
	});
});
