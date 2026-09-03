import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { custom, defineModel } from '../src/authoring/models-schema.js';
import { compileWorkspaceAuthoring } from '../src/authoring/model-introspection.js';
import {
	compileTenantCapabilities,
	discoverAuthoredSource
} from '../src/compiler/workspace-build.js';

/**
 * What the compiler finds, and — the half that is new — what it refuses to find.
 *
 * Every authored path is `src/<kind>/+<name>.<ext>`: the directory says the kind, the filename says
 * the name, and a `+` prefix says the compiler reads it. Nothing is discovered by suffix from
 * anywhere any more. A policy used to be `/\+[^/]+\.policy\.ts$/` matched at *any* depth, so the
 * file could sit wherever it liked and the suffix carried the kind — a name spelled twice and a kind
 * spelled twice.
 */
const roots: Array<string> = [];

const dynamicCustomTypeDoesNotCompile = (name: string): void => {
	// @ts-expect-error — custom types are a generated closed union, not a dynamic string.
	custom(name);
};
void dynamicCustomTypeDoesNotCompile;
const customByRuntimeName = custom as unknown as (
	name: string
) => ReturnType<typeof custom>;

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A workspace with the two files every workspace must have, and nothing else. */
const workspaceRoot = async (): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), 'bolt-authored-'));
	roots.push(root);
	await mkdir(join(root, 'src', 'collections', 'tickets'), { recursive: true });
	await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'desk', version: '1.0.0' }));
	await writeFile(join(root, 'src', 'collections', 'tickets', '+model.ts'), 'export default {}');
	await writeFile(join(root, 'src', '+agents.md'), '# The desk\n\nAnswer from tickets.\n');
	return root;
};

describe('Bolt authored source discovery', () => {
	it('discovers every kind by the directory it lives in', async () => {
		const root = await workspaceRoot();
		for (const directory of [
			['src', 'apps', 'desk'],
			['src', 'access', 'policies'],
			['src', 'automations'],
			['src', 'envoys'],
			['src', 'functions'],
			['src', 'datatypes', 'risk_score'],
			['src', 'capabilities', 'tools'],
			['src', 'capabilities', 'mcp']
		])
			await mkdir(join(root, ...directory), { recursive: true });

		await writeFile(join(root, 'src', 'apps', '+desk.svelte'), '<script></script>');
		await writeFile(
			join(root, 'src', '+env.ts'),
			"export default { MAPS_API_KEY: { visibility: 'private' } }"
		);
		await writeFile(
			join(root, 'src', 'apps', 'desk', '+group.ts'),
			"export default group({ label: 'Desk', icon: 'lucide:ticket', defaultChild: 'inbox' });"
		);
		await writeFile(join(root, 'src', 'access', 'policies', '+agent.ts'), 'export default {}');
		await writeFile(join(root, 'src', 'access', '+teams.ts'), 'export default {}');
		await writeFile(
			join(root, 'src', 'access', '+anonymous_limits.ts'),
			'export default { rules: {} }'
		);
		await writeFile(
			join(root, 'src', 'capabilities', 'tools', '+summarize.ts'),
			'export default { description: "Summarize" }'
		);
		await writeFile(join(root, 'src', 'envoys', '+inbox.ts'), 'export default {}');
		await writeFile(join(root, 'src', 'automations', '+ticket-opened.ts'), 'export default {}');
		await writeFile(join(root, 'src', 'functions', '+desk_dashboard.ts'), 'export default {}');
		await writeFile(
			join(root, 'src', 'datatypes', 'risk_score', '+definition.ts'),
			'export default {}'
		);
		await writeFile(
			join(root, 'src', 'datatypes', 'risk_score', '+renderer.svelte'),
			'<script></script>'
		);
		await writeFile(
			join(root, 'src', 'capabilities', 'mcp', '+search.ts'),
			'export default { endpoint: "https://mcp.example" }'
		);

		const discovered = await Effect.runPromise(discoverAuthoredSource(root));
		expect(discovered.collectionNames).toEqual(['tickets']);
		expect(discovered.appNames).toEqual(['desk']);
		expect(discovered.groupNames).toEqual(['desk']);
		expect(discovered.toolNames).toEqual(['summarize']);
		expect(discovered.envoyNames).toEqual(['inbox']);
		expect(discovered.automationNames).toEqual(['ticket-opened']);
		expect(discovered.functions).toEqual(['desk_dashboard']);
		expect(discovered.datatypeNames).toEqual(['risk_score']);
		expect(discovered.mcpServerNames).toEqual(['search']);
		expect(discovered.mcpFiles).toEqual([join(root, 'src', 'capabilities', 'mcp', '+search.ts')]);
		// A policy is named by its file and nothing else, so a file called `+agent.ts` under
		// `access/policies/` is a policy called `agent`. There is no suffix left to carry the kind.
		expect(discovered.policies).toEqual(['agent']);
		expect(discovered.teamsFile).toBe(join(root, 'src', 'access', '+teams.ts'));
		expect(discovered.anonymousLimitFile).toBe(join(root, 'src', 'access', '+anonymous_limits.ts'));
		expect(discovered.environmentFile).toBe(join(root, 'src', '+env.ts'));
		expect(discovered.prompt).toContain('Answer from tickets.');
	});

	it('compiles tenant skill packages and data-only MCP registrations', async () => {
		const root = await workspaceRoot();
		const skill = join(root, 'src', 'capabilities', 'skills', 'triage');
		const personal = join(root, '.norbital', 'personal', 'skills', 'private-triage');
		const mcp = join(root, 'src', 'capabilities', 'mcp', '+search.ts');
		await mkdir(join(skill, 'references'), { recursive: true });
		await mkdir(personal, { recursive: true });
		await mkdir(join(root, 'src', 'capabilities', 'mcp'), { recursive: true });
		await writeFile(
			join(skill, 'SKILL.md'),
			'---\nname: triage\ndescription: Resolve incoming tickets\n---\n\n# Triage\n'
		);
		await writeFile(join(skill, 'references', 'routing.md'), '# Routing\n');
		await writeFile(
			join(personal, 'SKILL.md'),
			'---\nname: private-triage\ndescription: Personal instructions\n---\n'
		);
		await writeFile(
			mcp,
			'export default { endpoint: { env: "SEARCH_MCP_URL" }, authentication: { personalSecret: "search-token" } };\n'
		);

		const capabilities = await Effect.runPromise(compileTenantCapabilities(root, [mcp]));
		expect(capabilities.skills[0]).toMatchObject({
			name: 'triage',
			description: 'Resolve incoming tickets',
			body: '---\nname: triage\ndescription: Resolve incoming tickets\n---\n\n# Triage\n',
			files: [{ path: 'SKILL.md' }, { path: 'references/routing.md' }]
		});
		expect(capabilities.skills.map(({ name }) => name)).toEqual(['triage']);
		expect(capabilities.mcp[0]).toMatchObject({
			name: 'search',
			protocol: '2026-07-28',
			transport: { kind: 'streamable-http', endpoint: { env: 'SEARCH_MCP_URL' } },
			authentication: { personalSecret: 'search-token' }
		});
	});

	it('compiles an absent skills root as an empty tenant capability set', async () => {
		const root = await workspaceRoot();

		await expect(Effect.runPromise(compileTenantCapabilities(root, []))).resolves.toEqual({
			skills: [],
			mcp: []
		});
	});

	it('refuses a +skill.md under capabilities/skills — the package is SKILL.md', async () => {
		const root = await workspaceRoot();
		const legacy = join(root, 'src', 'capabilities', 'skills', 'triage');
		await mkdir(legacy, { recursive: true });
		await writeFile(join(legacy, '+skill.md'), '# Triage\n');
		await expect(Effect.runPromise(discoverAuthoredSource(root))).rejects.toThrow(
			/src\/capabilities\/skills\/triage\/\+skill\.md/
		);
	});

	/**
	 * A `+` file the compiler has no rule for is a build failure naming where it belongs.
	 *
	 * The prefix means "the compiler reads this", so a file carrying one and reached by nothing is a
	 * promise the tree does not keep — which is exactly what shipped: `+agent.ts` sat in five
	 * workspaces matching no glob, `+integrations.ts` in four, and both compiled, typechecked and
	 * reached nothing at all.
	 */
	it('refuses a + file it has no rule for, and says where it belongs', async () => {
		const root = await workspaceRoot();
		await mkdir(join(root, 'src', 'channels'), { recursive: true });
		await writeFile(join(root, 'src', 'channels', '+inbox.channel.ts'), 'export default {}');
		await expect(Effect.runPromise(discoverAuthoredSource(root))).rejects.toThrow(
			/src\/channels\/\+inbox\.channel\.ts/
		);
		await expect(Effect.runPromise(discoverAuthoredSource(root))).rejects.toThrow(
			/envoys\/\+<name>\.ts/
		);
	});

	/** A helper without a `+` is the author's, and the compiler steps over it. */
	it('ignores a file with no + prefix, wherever it sits', async () => {
		const root = await workspaceRoot();
		await mkdir(join(root, 'src', 'lib'), { recursive: true });
		await writeFile(join(root, 'src', 'lib', 'workspace-client.ts'), 'export const x = 1;');
		await mkdir(join(root, 'src', 'envoys'), { recursive: true });
		await writeFile(join(root, 'src', 'envoys', 'helpers.ts'), 'export const y = 1;');
		const discovered = await Effect.runPromise(discoverAuthoredSource(root));
		expect(discovered.envoyNames).toEqual([]);
	});

	it('seals executed custom() names to platform and discovered tenant datatypes', () => {
		const compile = (name: string) =>
			compileWorkspaceAuthoring({
				models: { tickets: defineModel({ risk: customByRuntimeName(name) }) },
				sourcePaths: { tickets: 'src/collections/tickets/+model.ts' },
				customTypeNames: ['risk_score']
			});

		expect(compile('risk_score').customTypeReferences).toEqual([
			{ collection: 'tickets', field: 'risk', name: 'risk_score' }
		]);
		expect(() => compile('missing_score')).toThrow(
			'undeclared datatype "missing_score"'
		);
	});

	/**
	 * A tool in the wrong directory is not a tool, and the refusal is what says so.
	 *
	 * Under the suffix rule this compiled: `+summarize.tool.ts` anywhere at all was discovered, so a
	 * misfiled tool worked and taught the author the wrong layout. Under the directory rule it is a
	 * `+` file with no home, which is the error above.
	 */
	it('refuses a tool filed outside capabilities/tools', async () => {
		const root = await workspaceRoot();
		await mkdir(join(root, 'src', 'tools'), { recursive: true });
		await writeFile(join(root, 'src', 'tools', '+summarize.ts'), 'export default {}');
		await expect(Effect.runPromise(discoverAuthoredSource(root))).rejects.toThrow(
			/capabilities\/tools/
		);
	});
});
