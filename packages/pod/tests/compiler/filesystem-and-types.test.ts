import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compilePodFilesystem, discoverPodFilesystem } from '../../src/lib/vite/compiler/index.js';

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
	const root = await mkdtemp(path.join(parent, 'compiler-'));
	temporaryRoots.push(root);
	await write(root, 'package.json', JSON.stringify({ name: 'compiler-conformance' }));
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
<p>Home</p>`
	);
	await write(
		root,
		'src/collections/things/+lookup.tool.ts',
		`import { defineAgentTool } from '@norbital-ai/pod/authoring';
import { z } from 'zod';
export default defineAgentTool({
	description: 'Look up a thing',
	input: z.object({ id: z.string() }),
	run: async (api, input) => api.db.query.things.findFirst({ where: { norbital_id: input.id } })
});`
	);
	await write(
		root,
		'src/apps/+summarize.tool.ts',
		`import { defineAgentTool } from '@norbital-ai/pod/authoring';
import { z } from 'zod';
export default defineAgentTool({
	description: 'Summarize text',
	input: z.object({ text: z.string() }),
	run: (_api, input) => ({ summary: input.text })
});`
	);
	await write(
		root,
		'src/automation/+triage.ts',
		`import { defineAutomation } from '@norbital-ai/pod/authoring';
export default defineAutomation(
	{ schedule: '0 6 * * *' },
	{ kind: 'agent', task: 'Triage things', collections: ['things'], access: 'write', tools: ['lookup'] }
);`
	);
	return root;
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
});

describe('Pod filesystem compiler conformance', () => {
	it('discovers agent tools anywhere under src without confusing neighboring role compilers', async () => {
		const root = await workspace();
		const structure = await discoverPodFilesystem(root);

		expect(structure.diagnostics).toEqual([]);
		expect(structure.agentTools.map((tool) => tool.id)).toEqual(['lookup', 'summarize']);
	});

	it('rejects duplicate tools and obsolete tenant capability declarations', async () => {
		const root = await workspace();
		await write(
			root,
			'src/apps/+lookup.tool.ts',
			`export { default } from '../collections/things/+lookup.tool.js';`
		);
		await write(root, 'src/+notifications.ts', `export default { channels: ['email'] as const };`);
		await write(root, 'src/+facilities.ts', `export default ['ai'] as const;`);

		const structure = await discoverPodFilesystem(root);
		const codes = structure.diagnostics.map((diagnostic) => diagnostic.code);
		expect(codes).toContain('AGENT_TOOL_DUPLICATE');
		expect(codes.filter((code) => code === 'WORKSPACE_ROLE_UNKNOWN')).toHaveLength(2);
	});

	it('generates exact collection and tool unions while notification channels stay host-owned', async () => {
		const root = await workspace();
		await write(
			root,
			'src/automation/+notify.ts',
			`import { defineAutomation } from '@norbital-ai/pod/authoring';
import type { Api } from './$types.js';
export default defineAutomation({ schedule: '0 7 * * *' }, async (api: Api) => {
	await api.sendNotification({
		recipient_user_id: '00000000-0000-4000-8000-000000000000',
		subject: 'Portable',
		message: 'The active host chooses the provider',
		channels: ['sms']
	});
	return {};
});`
		);
		const result = await compilePodFilesystem({ root });
		expect(result.valid, JSON.stringify(result.diagnostics, null, 2)).toBe(true);

		const tsc = path.join(REPO_ROOT, 'packages/pod/node_modules/.bin/tsc');
		try {
			execFileSync(tsc, ['-p', path.join(root, '.norbital/tsconfig.json')], {
				cwd: root,
				encoding: 'utf8'
			});
		} catch (cause) {
			const failure = cause as { stdout?: string; stderr?: string };
			throw new Error(`${failure.stdout ?? ''}\n${failure.stderr ?? ''}`, { cause });
		}

		await write(
			root,
			'src/automation/+triage.ts',
			`import { defineAutomation } from '@norbital-ai/pod/authoring';
export default defineAutomation(
	{ schedule: '0 6 * * *' },
	{ kind: 'agent', task: 'Invalid', collections: ['missing_collection'], tools: ['missing_tool'] }
);`
		);
		let diagnostics = '';
		try {
			execFileSync(tsc, ['-p', path.join(root, '.norbital/tsconfig.json')], {
				cwd: root,
				encoding: 'utf8'
			});
		} catch (cause) {
			const failure = cause as { stdout?: string; stderr?: string };
			diagnostics = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`;
		}
		expect(diagnostics).toContain('missing_collection');
		expect(diagnostics).toContain('missing_tool');
	});
});
