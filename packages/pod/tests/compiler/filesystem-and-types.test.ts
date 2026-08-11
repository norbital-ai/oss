import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compilePodFilesystem, discoverPodFilesystem } from '../../src/vite/compiler/index.js';
import { linkCurrentPodWorkspaceDependencies } from '../support/current-package-node-modules.js';

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
	{
		kind: 'agent',
		description: 'Reviews new things each morning and files the ones that need attention.',
		task: 'Triage things',
		collections: ['things'],
		access: 'write',
		tools: ['lookup']
	}
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
	it('accepts geometry only on the layout primitives that own it', async () => {
		const root = await workspace();
		await write(
			root,
			'src/apps/+home.svelte',
			`<svelte:head><title>Home</title><meta name="description" content="Home" /></svelte:head>
<Stack fill grow shrink={false}><Inline fill grow><Cluster grow /></Inline></Stack>
<Bound grow shrink={false} /><Cover grow /><Scroll name="Rows" grow />`
		);

		let structure = await discoverPodFilesystem(root);
		expect(
			structure.diagnostics.filter((diagnostic) => diagnostic.code === 'LAYOUT_PROP_UNKNOWN')
		).toEqual([]);

		await write(
			root,
			'src/apps/+home.svelte',
			`<svelte:head><title>Home</title><meta name="description" content="Home" /></svelte:head>
<Grid fill /><Center grow /><Widget shrink={false} /><Tabs contentClass="h-full" />`
		);
		structure = await discoverPodFilesystem(root);
		expect(
			structure.diagnostics
				.filter((diagnostic) => diagnostic.code === 'LAYOUT_PROP_UNKNOWN')
				.map((diagnostic) => diagnostic.message)
		).toEqual([
			'fill is not a supported layout prop; parents own geometry',
			'grow is not a supported layout prop; parents own geometry',
			'shrink is not a supported layout prop; parents own geometry',
			'contentClass is not a supported layout prop; parents own geometry'
		]);
	});

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
		expect(codes).toContain('WORKSPACE_ROLE_UNKNOWN');
		// A facility attempt gets its own code: the set is the host's contract, so "unknown role"
		// would read like a typo rather than "there is nowhere to declare this".
		expect(codes).toContain('WORKSPACE_ROLE_RESERVED');
		const facilityDiagnostic = structure.diagnostics.find(
			(diagnostic) => diagnostic.code === 'WORKSPACE_ROLE_RESERVED'
		);
		expect(facilityDiagnostic?.message).toContain('pod.host.ts');
	});

	it('generates exact collection and tool unions while notification channels stay host-owned', async () => {
		const root = await workspace();
		await write(
			root,
			'src/automation/+notify.ts',
			`import { defineAutomation } from '@norbital-ai/pod/authoring';
import type { Api } from './$types.js';
export default defineAutomation(
	{ schedule: '0 7 * * *' },
	{
		kind: 'deterministic',
		description: 'Sends the daily digest notification to the standing recipient.',
		handler: async (api: Api) => {
			await api.sendNotification({
				recipient_user_id: '00000000-0000-4000-8000-000000000000',
				subject: 'Portable',
				message: 'The active host chooses the provider',
				channels: ['sms']
			});
			return {};
		}
	}
);`
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
	{
		kind: 'agent',
		description: 'Names a collection and a tool the workspace does not have.',
		task: 'Invalid',
		collections: ['missing_collection'],
		tools: ['missing_tool']
	}
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

	it('infers the workspace schema without an api annotation and rejects an unknown trigger', async () => {
		const root = await workspace();
		// No `api: Api` annotation and no explicit schema generic: `defineAutomation` must still
		// resolve `things` and its row type from the compiler-merged authoring types.
		await write(
			root,
			'src/automation/+on_thing.ts',
			`import { defineAutomation } from '@norbital-ai/pod/authoring';
export default defineAutomation(
	{ trigger: { collection: 'things', event: 'created' } },
	{
		kind: 'deterministic',
		description: 'Counts the things sharing a name with the one just created.',
		handler: async (api, { scope }) => {
			const name: string = scope.incoming_record.name;
			await api.db.query.things.findMany({ where: { name: { eq: name } }, limit: 1 });
			return { name };
		}
	}
);`
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

		// A misspelled trigger collection is a compile error, not a runtime one.
		await write(
			root,
			'src/automation/+on_thing.ts',
			`import { defineAutomation } from '@norbital-ai/pod/authoring';
export default defineAutomation(
	{ trigger: { collection: 'thingz', event: 'created' } },
	{
		kind: 'deterministic',
		description: 'Names a collection the workspace does not have.',
		handler: async () => ({})
	}
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
		expect(diagnostics).toContain('thingz');
	});

	it('pairs each policy grant with its own collection row type', async () => {
		const root = await workspace();
		await write(
			root,
			'src/policies/+viewer.policy.ts',
			`import type { Policy } from './$types.js';
export default {
	name: 'Viewer',
	description: 'Reads every thing that has been given a name.',
	grants: [{ collection: 'things', action: 'read', where: { name: { isNotNull: true } } }]
} satisfies Policy;`
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

		// A `where` naming a column the granted collection does not have would otherwise compile and
		// then match no rows — a grant that reads as access while granting none.
		await write(
			root,
			'src/policies/+viewer.policy.ts',
			`import type { Policy } from './$types.js';
export default {
	name: 'Viewer',
	description: 'Reads every thing that has been given a name.',
	grants: [{ collection: 'things', action: 'read', where: { nope: { isNotNull: true } } }]
} satisfies Policy;`
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
		expect(diagnostics).toContain('nope');
	});

	it('emits a policy name union and rejects a badly named policy file', async () => {
		const root = await workspace();
		await write(
			root,
			'src/policies/+ok.policy.ts',
			`export default {
	name: 'Ok',
	description: 'Reads things.',
	grants: [{ collection: 'things', action: 'read' }]
};`
		);
		await write(root, 'src/policies/NotAPolicy.ts', `export default {};`);

		const structure = await discoverPodFilesystem(root);
		expect(structure.policies.map((policy) => policy.id)).toEqual(['ok']);
		expect(structure.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
			'POLICY_NAME_INVALID'
		);
	});

	it('infers the workspace schema in invoke handlers without an api annotation', async () => {
		const root = await workspace();
		await write(
			root,
			'src/remotes/+thing_count.ts',
			`import { defineQueryHandler } from '@norbital-ai/pod/authoring';
import { z } from 'zod';
export default defineQueryHandler({
	description: 'Lists the names of things whose name starts with the given prefix.',
	schema: z.object({ prefix: z.string() }),
	handler: async ({ prefix }, api) => {
		const rows = await api.db.query.things.findMany({
			where: { name: { like: prefix } },
			columns: { name: true },
			limit: 10
		});
		return { names: rows.map((row) => row.name) };
	}
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
	});

	/**
	 * Discovery is a whitelist, so a role file in an unread directory was previously registered by
	 * nothing and reported by nothing — the automation just never ran. The mixed singular/plural
	 * convention (`src/automation` but `src/remotes`) makes this the likeliest typo in the surface.
	 */
	it('refuses role declarations in a directory nothing reads', async () => {
		const root = await workspace();
		await write(root, 'src/automations/+nightly_digest.ts', `export default {};`);
		await write(root, 'src/remote/+summary.ts', `export default {};`);
		// Agent tools are discoverable anywhere by design, so this one must stay silent.
		await write(root, 'src/helpers/+lookup.tool.ts', `export default {};`);

		const structure = await discoverPodFilesystem(root);
		const orphans = structure.diagnostics.filter(
			(diagnostic) => diagnostic.code === 'WORKSPACE_ROLE_ORPHANED'
		);
		expect(orphans.map((diagnostic) => diagnostic.file).sort()).toEqual([
			'src/automations/+nightly_digest.ts',
			'src/remote/+summary.ts'
		]);
		expect(orphans[0]?.message).toContain('Did you mean src/automation?');
		expect(orphans[1]?.message).toContain('Did you mean src/remotes?');
	});

	/**
	 * The object form carries `kind` and nothing else, yet it used to be the weaker of the two: its
	 * handler fell back to `AnySchema`, collapsing `scope.incoming_record` to `Record<string, unknown>`.
	 * Two ways of declaring the same automation must not disagree about how well it is typed.
	 */
	it('infers the workspace schema in the object spec form too', async () => {
		const root = await workspace();
		await write(
			root,
			'src/automation/+on_thing_object.ts',
			`import { defineAutomation } from '@norbital-ai/pod/authoring';
export default defineAutomation(
	{ trigger: { collection: 'things', event: 'created' } },
	{
		kind: 'deterministic',
		description: 'Counts the things sharing a name with the one just created.',
		handler: async (api, { scope }) => {
			const name: string = scope.incoming_record.name;
			await api.db.query.things.findMany({ where: { name: { eq: name } }, limit: 1 });
			return { name };
		}
	}
);`
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

		// `incoming_record` is now a things row, so a wrong field type is caught.
		await write(
			root,
			'src/automation/+on_thing_object.ts',
			`import { defineAutomation } from '@norbital-ai/pod/authoring';
export default defineAutomation(
	{ trigger: { collection: 'things', event: 'created' } },
	{
		kind: 'deterministic',
		description: 'Reads the name off the thing that was just created.',
		handler: async (_api, { scope }) => {
			const name: number = scope.incoming_record.name;
			return { name };
		}
	}
);`
		);
		await compilePodFilesystem({ root });
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
		expect(diagnostics).toContain("not assignable to type 'number'");
	});

	/**
	 * A channel names the policy its agent acts under. That is a cross-reference, so it is checkable —
	 * and worth checking: a channel pointing at a policy that does not exist would be an agent whose
	 * permissions resolve to nothing, which reads as "the channel is broken" rather than "the name is
	 * wrong".
	 */
	it('binds a channel to a policy that exists', async () => {
		const root = await workspace();
		await write(
			root,
			'src/policies/+support_agent.policy.ts',
			`import type { Policy } from './$types.js';
export default {
	name: 'Support agent',
	description: 'Lets the support agent read things while answering a message.',
	grants: [{ collection: 'things', action: 'read' }]
} satisfies Policy;`
		);
		await write(
			root,
			'src/channels/+support_inbox.channel.ts',
			`import type { Channel } from './$types.js';
export default {
	transport: 'telegram',
	policy: 'support_agent',
	description: 'Customers reaching support over Telegram.'
} satisfies Channel;`
		);
		const result = await compilePodFilesystem({ root });
		expect(result.valid, JSON.stringify(result.diagnostics, null, 2)).toBe(true);

		const tsc = path.join(REPO_ROOT, 'packages/pod/node_modules/.bin/tsc');
		execFileSync(tsc, ['-p', path.join(root, '.norbital/tsconfig.json')], {
			cwd: root,
			encoding: 'utf8'
		});

		await write(
			root,
			'src/channels/+support_inbox.channel.ts',
			`import type { Channel } from './$types.js';
export default {
	transport: 'telegram',
	policy: 'support_agentt',
	description: 'Customers reaching support over Telegram.'
} satisfies Channel;`
		);
		await compilePodFilesystem({ root });
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
		expect(diagnostics).toContain('support_agentt');
	});

	it('rejects a badly named channel file', async () => {
		const root = await workspace();
		await write(root, 'src/channels/+Support Inbox.channel.ts', `export default {};`);
		const structure = await discoverPodFilesystem(root);
		expect(structure.diagnostics.map((d) => d.code)).toContain('CHANNEL_NAME_INVALID');
	});

	/**
	 * `src/` is a whitelist of two flat declarations, and everything else there is a mistake. Before
	 * `+env.ts` was one of them, a workspace declaring its private environment names was told it had
	 * an unknown workspace role — while a connection referencing one of those names was refused for
	 * being undeclared. Both ends of that had to move together.
	 */
	it('discovers src/+env.ts and compiles it into the workspace', async () => {
		const root = await workspace();
		await write(
			root,
			'src/+env.ts',
			`import { defineEnv } from '@norbital-ai/pod/authoring';
export default defineEnv({ private: { REGISTRY_KEY: { description: 'Registry API key' } } });`
		);
		const structure = await discoverPodFilesystem(root);
		expect(structure.diagnostics).toEqual([]);
		expect(structure.env).toBe('src/+env.ts');

		await compilePodFilesystem({ root });
		const generated = await readFile(path.join(root, '.norbital/generated/workspace.ts'), 'utf8');
		expect(generated).toContain('import env from "../../src/+env.js";');
		expect(generated).toContain('\tenv\n});');
	});

	it('discovers src/+agent.ts as the interactive profile instead of a scheduled automation', async () => {
		const root = await workspace();
		await write(
			root,
			'src/+agent.ts',
			`import type { AgentAutomationSpec } from '@norbital-ai/pod/authoring';
export default {
	kind: 'agent',
	description: 'The workspace assistant people talk to directly.',
	task: 'Help here.',
	access: 'write'
} satisfies AgentAutomationSpec;`
		);
		const structure = await discoverPodFilesystem(root);
		expect(structure.diagnostics).toEqual([]);
		expect(structure.agent).toBe('src/+agent.ts');
		expect(structure.automations.map((automation) => automation.id)).toEqual(['triage']);

		await compilePodFilesystem({ root });
		const generated = await readFile(path.join(root, '.norbital/generated/workspace.ts'), 'utf8');
		expect(generated).toContain('import agent from "../../src/+agent.js";');
		expect(generated).toMatch(/\tmeta: \{[^\n]+\},\n\tagent/);
	});

	it('still refuses a flat src/+<name>.ts that declares nothing', async () => {
		const root = await workspace();
		await write(root, 'src/+environment.ts', `export default {};`);
		const structure = await discoverPodFilesystem(root);
		expect(structure.diagnostics.map((d) => d.code)).toContain('WORKSPACE_ROLE_UNKNOWN');
	});

	it('carries a static pod:banner from +representation.svelte into the collection surface', async () => {
		const root = await workspace();
		await write(
			root,
			'src/collections/things/+representation.svelte',
			`<script lang="ts">
	import type { RepresentationProps } from './$types.js';
	let { record }: RepresentationProps = $props();
</script>

<svelte:head>
	<meta name="pod:banner" content="https://cdn.example.com/things-banner.webp" />
</svelte:head>

<p>{record?.name}</p>`
		);
		const structure = await discoverPodFilesystem(root);
		expect(structure.diagnostics).toEqual([]);
		const things = structure.collections.find((collection) => collection.id === 'things');
		expect(things?.representationBanner).toBe('https://cdn.example.com/things-banner.webp');

		await compilePodFilesystem({ root });
		const generated = await readFile(
			path.join(root, '.norbital/generated/collection-surfaces.ts'),
			'utf8'
		);
		expect(generated).toContain(
			'"things": { representation: representation0, banner: "https://cdn.example.com/things-banner.webp" }'
		);
	});

	it('ignores a non-static or missing pod:banner on +representation.svelte', async () => {
		const root = await workspace();
		await write(
			root,
			'src/collections/things/+representation.svelte',
			`<script lang="ts">
	import type { RepresentationProps } from './$types.js';
	let { record }: RepresentationProps = $props();
	const banner = 'https://cdn.example.com/dynamic.webp';
</script>

<svelte:head>
	<meta name="pod:banner" content={banner} />
</svelte:head>

<p>{record?.name}</p>`
		);
		const structure = await discoverPodFilesystem(root);
		expect(structure.diagnostics).toEqual([]);
		const things = structure.collections.find((collection) => collection.id === 'things');
		expect(things?.representationBanner).toBeUndefined();
	});

	it('requires i18n catalogs for every supported locale when apps exist', async () => {
		const root = await workspace();
		await write(
			root,
			'src/apps/+home.svelte',
			`<svelte:head><title>Home</title><meta name="description" content="Home" /></svelte:head>
<p>{t('home.greeting')}</p>`
		);
		await rm(path.join(root, 'src/i18n'), { recursive: true, force: true });

		const structure = await discoverPodFilesystem(root);
		const missing = structure.diagnostics.filter(
			(diagnostic) => diagnostic.code === 'I18N_CATALOG_MISSING'
		);
		expect(missing.map((diagnostic) => diagnostic.file)).toEqual(['src/i18n/messages.en.json']);
		expect(missing[0]?.message).toContain('every supported locale');

		await write(
			root,
			'src/i18n/messages.en.json',
			JSON.stringify({ 'home.greeting': 'Welcome' }, null, '\t')
		);
		const structureWithPrimary = await discoverPodFilesystem(root);
		const missingAfter = structureWithPrimary.diagnostics.filter(
			(diagnostic) => diagnostic.code === 'I18N_CATALOG_MISSING'
		);
		expect(missingAfter.map((diagnostic) => diagnostic.file)).toEqual([
			'src/i18n/messages.zh.json'
		]);
	});

	it('flags raw text nodes and raw copy props that bypass t()', async () => {
		const root = await workspace();
		await write(
			root,
			'src/apps/+home.svelte',
			`<svelte:head>
	<title>Home</title>
	<meta name="description" content="Home" />
	<meta name="pod:icon" content="lucide:home" />
</svelte:head>
<p>Track and resolve RFIs.</p>
<PageHeader title="Requests" description="Track and resolve project RFIs." />
<Column name="rfi_number" />
<Button aria-hidden="true">&nbsp;</Button>
<p>{record?.name} · Employee</p>`
		);

		const structure = await discoverPodFilesystem(root);
		const raw = structure.diagnostics.filter(
			(diagnostic) =>
				diagnostic.code === 'I18N_RAW_TEXT' || diagnostic.code === 'I18N_RAW_COPY_PROP'
		);
		expect(raw.map((diagnostic) => diagnostic.message)).toEqual([
			"User-facing text must come from t('key'); add the string to both catalogs",
			"PageHeader title expects a localized string; pass t('key') from both catalogs",
			"PageHeader description expects a localized string; pass t('key') from both catalogs",
			"User-facing text must come from t('key'); add the string to both catalogs"
		]);
		expect(
			structure.diagnostics.filter(
				(diagnostic) =>
					diagnostic.code !== 'I18N_RAW_TEXT' && diagnostic.code !== 'I18N_RAW_COPY_PROP'
			)
		).toEqual([]);
	});

	it('keeps svelte:head metadata, identifiers, and expression-driven copy exempt from the raw-copy rule', async () => {
		const root = await workspace();
		await write(
			root,
			'src/apps/+home.svelte',
			`<svelte:head>
	<title>Home</title>
	<meta name="description" content="Home" />
	<meta name="pod:icon" content="lucide:home" />
</svelte:head>
<PageHeader title={t('app.home.header_title')} description={label} />
<Column name="status" />
<a href="/docs">{t('app.home.docs_link')}</a>
<Combobox emptyPlaceholder={t('component.empty')} searchPlaceholder={t('component.search')} />
<Button disabled>{condition ? 'Yes' : 'No'}</Button>`
		);

		const structure = await discoverPodFilesystem(root);
		expect(structure.diagnostics).toEqual([]);
	});

	it('limits the raw-copy rule to app surfaces', async () => {
		const root = await workspace();
		await write(
			root,
			'src/collections/items/+representation.svelte',
			'<p>Collection representations retain their existing localization contract.</p>'
		);

		const structure = await discoverPodFilesystem(root);
		expect(
			structure.diagnostics.filter(
				(diagnostic) =>
					diagnostic.code === 'I18N_RAW_TEXT' || diagnostic.code === 'I18N_RAW_COPY_PROP'
			)
		).toEqual([]);
	});

	it('enforces key parity across all supported locale catalogs', async () => {
		const root = await workspace();
		await write(
			root,
			'src/i18n/messages.zh.json',
			JSON.stringify({ 'home.extra': '额外' }, null, '\t')
		);

		const structure = await discoverPodFilesystem(root);
		const codes = structure.diagnostics.map((diagnostic) => diagnostic.code);
		expect(codes).toContain('I18N_CATALOG_MISSING_KEY');
		expect(codes).toContain('I18N_CATALOG_EXTRA_KEY');
	});
});
