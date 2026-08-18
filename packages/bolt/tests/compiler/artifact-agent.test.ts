import { describe, expect, it } from 'vitest';
import { describeAgent } from '../../src/authoring/model-introspection.js';
import { renderArtifact } from '../../src/compiler/sync.js';

/**
 * What `src/+agent.ts` carries into the artifact.
 *
 * The compiler synthesized `{ name, prompt: 'You are the <workspace> workspace agent.', tools,
 * skills }` and discovered no `+agent.ts` at all, so a workspace that authored a scoped,
 * write-capable agent with a real operating prompt and a raised token budget shipped an unscoped one
 * that had read none of it. Nothing failed anywhere, which is why it stood.
 *
 * The emitted mapping is executed rather than grepped, for the same reason `artifact-metadata`
 * executes its own: a test that matches the spelling of a line passes on the spelling.
 */

const root = '/workspace';

const artifactFor = (agentFile: string | undefined): string =>
	renderArtifact(
		{ name: 'fixture', version: '1.0.0', description: 'Bolt workspace' },
		[
			{
				name: 'orders',
				path: `${root}/src/collections/orders/+model.ts`,
				sourcePath: 'src/collections/orders/+model.ts',
				fields: { title: { type: 'string', required: true, indexed: false } }
			}
		],
		[],
		[],
		[],
		[],
		[],
		[],
		[],
		[],
		[],
		[],
		'fixture-agent',
		root,
		[],
		[],
		undefined,
		[],
		[],
		agentFile
	);

/** The one statement in the artifact that folds `+agent.ts` into the declared agents. */
const agentDescriptors = (
	artifact: string,
	declaredWorkspace: { readonly agents: ReadonlyArray<Record<string, unknown>> },
	declaredAgentSpec: unknown
): ReadonlyArray<Record<string, unknown>> => {
	const start = artifact.indexOf('const agents = declaredWorkspace.agents.map(');
	const end = artifact.indexOf('\n', start);
	if (start < 0 || end < 0) throw new Error('the artifact no longer maps agents in one statement');
	const source = `${artifact.slice(start, end)}\nreturn agents;`;
	return new Function('declaredWorkspace', 'declaredAgentSpec', 'describeAgent', source)(
		declaredWorkspace,
		declaredAgentSpec,
		describeAgent
	) as ReadonlyArray<Record<string, unknown>>;
};

const compilerSupplied = {
	agents: [
		{
			name: 'fixture-agent',
			prompt: 'You are the fixture workspace agent.',
			tools: [{ name: 'quote', description: 'Quote', command: 'workspace:quote' }],
			skills: ['payroll']
		}
	]
};

describe('artifact agent configuration', () => {
	it('imports src/+agent.ts when the workspace has one', () => {
		expect(artifactFor(`${root}/src/+agent.ts`)).toContain(
			'import declaredAgentSpec from "../../src/+agent.js";'
		);
	});

	it('leaves the synthesized declaration alone when the workspace authors no +agent.ts', () => {
		const artifact = artifactFor(undefined);
		expect(artifact).not.toContain('declaredAgentSpec');
		expect(agentDescriptors(artifact, compilerSupplied, undefined)).toEqual(
			compilerSupplied.agents
		);
	});

	it('carries every authored field onto the agent and keeps the compiler-owned three', () => {
		const artifact = artifactFor(`${root}/src/+agent.ts`);
		const [agent] = agentDescriptors(artifact, compilerSupplied, {
			description: 'The in-workspace assistant.',
			kind: 'agent',
			task: 'Assist with this payroll workspace.',
			systemPrompt: 'Follow explicit tool-use instructions exactly.',
			collections: ['companies'],
			access: 'write',
			denyTools: ['read_skill'],
			mcpServers: ['search'],
			hostTools: ['send_email'],
			model: 'gpt-5',
			maxTokens: 64_000
		});
		// The task is joined onto the system prompt: one says how to behave, the other says what for,
		// and a turn opening with either alone is missing half its brief.
		expect(agent?.['prompt']).toBe(
			'Follow explicit tool-use instructions exactly.\n\nAssist with this payroll workspace.'
		);
		expect(agent?.['collections']).toEqual(['companies']);
		expect(agent?.['access']).toBe('write');
		expect(agent?.['denyTools']).toEqual(['read_skill']);
		expect(agent?.['mcpServers']).toEqual(['search']);
		expect(agent?.['hostTools']).toEqual(['send_email']);
		expect(agent?.['model']).toBe('gpt-5');
		expect(agent?.['maxTokens']).toBe(64_000);
		expect(agent?.['description']).toBe('The in-workspace assistant.');
		// The three the module cannot state about itself survive it.
		expect(agent?.['name']).toBe('fixture-agent');
		expect(agent?.['skills']).toEqual(['payroll']);
		expect(agent?.['tools']).toEqual([
			{ name: 'quote', description: 'Quote', command: 'workspace:quote' }
		]);
	});

	it('refuses a malformed field rather than carrying it', () => {
		const artifact = artifactFor(`${root}/src/+agent.ts`);
		const [agent] = agentDescriptors(artifact, compilerSupplied, {
			systemPrompt: 'Be exact.',
			maxTokens: 0,
			access: 'admin',
			collections: ['companies', 7]
		});
		expect(agent?.['prompt']).toBe('Be exact.');
		expect(agent?.['maxTokens']).toBeUndefined();
		expect(agent?.['access']).toBeUndefined();
		expect(agent?.['collections']).toBeUndefined();
	});
});
