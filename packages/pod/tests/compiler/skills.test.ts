import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
	const root = await mkdtemp(path.join(parent, 'skills-'));
	temporaryRoots.push(root);
	await write(root, 'package.json', JSON.stringify({ name: 'skills-conformance' }));
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

describe('workspace skills', () => {
	it('carries a skill and everything beneath it into the generated workspace', async () => {
		const root = await workspace();
		// Backticks, an interpolation and a backslash, because markdown contains all three and the
		// generated module is TypeScript source: unescaped, any of them ends the string early.
		await write(
			root,
			'.agents/skills/site-handover/SKILL.md',
			`---
name: site-handover
description: How handover packs are assembled. Load before touching \`handover\` records.
license: MIT
metadata:
  owner: ops
---

Use \`${'$'}{pack}\` templates and a backslash \\ somewhere.
`
		);
		await write(root, '.agents/skills/site-handover/references/checklist.md', '# Checklist\n');

		const structure = await discoverPodFilesystem(root);
		expect(structure.diagnostics).toEqual([]);
		expect(structure.skills).toEqual([
			{
				name: 'site-handover',
				source: '.agents/skills/site-handover/SKILL.md',
				description: 'How handover packs are assembled. Load before touching `handover` records.',
				license: 'MIT',
				metadata: { owner: 'ops' },
				body: 'Use `${pack}` templates and a backslash \\ somewhere.\n',
				files: [{ path: 'references/checklist.md', text: '# Checklist\n' }]
			}
		]);

		const compiled = await compilePodFilesystem({ root });
		expect(compiled.diagnostics).toEqual([]);
		const generated = await readFile(path.join(root, '.norbital/generated/workspace.ts'), 'utf8');
		expect(generated).toContain(`origin: 'workspace'`);
		expect(generated).toContain(
			JSON.stringify('Use `${pack}` templates and a backslash \\ somewhere.\n')
		);
	});

	it('refuses src/skills with SKILL_LOCATION_MOVED and does not compile the legacy tree', async () => {
		const root = await workspace();
		await write(root, 'src/skills/legacy/SKILL.md', '---\nname: legacy\ndescription: Old path\n---\n');

		const structure = await discoverPodFilesystem(root);
		expect(structure.skills).toEqual([]);
		expect(
			structure.diagnostics
				.filter((diagnostic) => diagnostic.code === 'SKILL_LOCATION_MOVED')
				.map((diagnostic) => [diagnostic.code, diagnostic.file])
		).toEqual([['SKILL_LOCATION_MOVED', 'src/skills']]);
	});

	it('names every way a skill can fail instead of dropping it', async () => {
		const root = await workspace();
		await write(root, '.agents/skills/Bad_Name/SKILL.md', '---\nname: x\ndescription: y\n---\n');
		await write(
			root,
			'.agents/skills/norbital-platform/SKILL.md',
			'---\nname: norbital-platform\ndescription: Shadows a host skill\n---\n'
		);
		await write(root, '.agents/skills/no-frontmatter/SKILL.md', '# Straight into prose\n');
		await write(root, '.agents/skills/mismatch/SKILL.md', '---\nname: other\ndescription: y\n---\n');
		await write(root, '.agents/skills/no-description/SKILL.md', '---\nname: no-description\n---\n');
		await write(root, '.agents/skills/outer/SKILL.md', '---\nname: outer\ndescription: y\n---\n');
		await write(root, '.agents/skills/outer/outer/SKILL.md', '---\nname: outer\ndescription: y\n---\n');

		const structure = await discoverPodFilesystem(root);
		expect(
			structure.diagnostics
				.filter((diagnostic) => diagnostic.code.startsWith('SKILL_'))
				.map((diagnostic) => [diagnostic.code, diagnostic.file])
		).toEqual([
			['SKILL_NAME_INVALID', '.agents/skills/Bad_Name/SKILL.md'],
			['SKILL_NAME_INVALID', '.agents/skills/mismatch/SKILL.md'],
			['SKILL_FRONTMATTER_INVALID', '.agents/skills/no-description/SKILL.md'],
			['SKILL_FRONTMATTER_INVALID', '.agents/skills/no-frontmatter/SKILL.md'],
			['SKILL_NAME_RESERVED', '.agents/skills/norbital-platform/SKILL.md'],
			['SKILL_DUPLICATE', '.agents/skills/outer/outer/SKILL.md']
		]);
	});

	it('leaves a nested skill out of its parent, so one skill never quotes another', async () => {
		const root = await workspace();
		await write(root, '.agents/skills/outer/SKILL.md', '---\nname: outer\ndescription: y\n---\n');
		await write(root, '.agents/skills/outer/notes.md', 'outer note\n');
		await write(root, '.agents/skills/outer/inner/SKILL.md', '---\nname: inner\ndescription: y\n---\n');
		await write(root, '.agents/skills/outer/inner/notes.md', 'inner note\n');

		const structure = await discoverPodFilesystem(root);
		expect(structure.diagnostics).toEqual([]);
		expect(
			structure.skills.map((skill) => [skill.name, skill.files.map((file) => file.path)])
		).toEqual([
			['inner', ['notes.md']],
			['outer', ['notes.md']]
		]);
	});
});
