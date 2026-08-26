import { describe, expect, it } from 'vitest';
import { renderArtifact } from '../../src/compiler/sync.js';

/**
 * Every name the emitted artifact uses must be a name the emitted artifact declares.
 *
 * This is the defect that got through: the renderer gained
 * `const authoredRuntime = { …, pipelines: declaredPipelines, automations: declaredAutomations }`
 * while neither binding was ever emitted and the imports that would feed them were built but never
 * interpolated. Every unit test passed, because no test imported the generated module — the failure
 * only appeared when `bolt-server` tried to load a real bundle and died on
 * `ReferenceError: declaredPipelines is not defined`, which is to say: after a full sync, in a
 * running stack, with nothing in the suite pointing at the cause.
 *
 * Parsing the artifact as a module is what makes this cheap to check. `new Function` compiles the
 * body without executing it, so an undeclared reference is caught here rather than three hops later.
 */
const root = '/workspace';

/** An artifact with one of everything the renderer knows how to emit. */
const artifactWithEverything = (): string =>
	renderArtifact({
		metadata: { name: 'fixture', version: '1.0.0', description: 'Bolt workspace' },
		collections: [],
		relations: [],
		apps: [],
		policies: [`${root}/src/policies/+admin.policy.ts`],
		functions: [`${root}/src/remotes/+summary.ts`],
		toolFiles: [`${root}/src/tools/+summarize.tool.ts`],
		mcpFiles: [`${root}/src/capabilities/mcp/+search.ts`],
		envoyFiles: [],
		automations: ['nightly'],
		automationFiles: [`${root}/src/automations/+nightly.ts`],
		pipelineFiles: [`${root}/src/collections/invoices/+pipelines.ts`],
		skills: [{ name: 'payroll', body: '# Payroll\n\nUse the approved workflow.' }],
		prompt: 'You are the test workspace agent.',
		root,
		assetIndex: { browser: [], server: [] },
		customTypeDefinitions: [],
		environmentFile: undefined,
		migrations: []
	});

describe('emitted artifact bindings', () => {
	it('declares every name it references', () => {
		const artifact = artifactWithEverything();
		// The import statements name modules that do not exist here, so they are stripped: what is
		// under test is the body's own bindings, not module resolution.
		const body = artifact
			.split('\n')
			.filter((line) => !line.startsWith('import '))
			// `export default bundle;` re-states a name already bound above, so it is dropped rather
			// than rewritten; `export const` just loses its modifier.
			.filter((line) => !line.startsWith('export default'))
			.join('\n')
			.replaceAll(/^export const /gm, 'const ');
		const imported = [...artifact.matchAll(/^import (?:\{([^}]*)\}|(\w+)) from/gm)].flatMap(
			(match) =>
				(match[2] ?? match[1] ?? '')
					.split(',')
					.map((name) => name.trim())
					.filter(Boolean)
		);
		// Declaring the stripped imports as parameters is what lets the body compile; an undeclared
		// name that is *not* an import is exactly the bug this test exists for.
		expect(() => new Function(...imported, `${body}\nreturn true;`)).not.toThrow();
	});

	it('emits the imports and declarations the authored runtime is built from', () => {
		const artifact = artifactWithEverything();
		// Named explicitly because the compile check above passes if a binding is declared *empty*,
		// and an authored runtime that silently carries nothing is the quieter version of this bug:
		// pipelines and automations would simply never run.
		expect(artifact).toContain('import pipelines0 from');
		expect(artifact).toContain('import automation0 from');
		expect(artifact).toContain('import mcp0 from');
		expect(artifact).toContain('const declaredMcpServers = {"search": mcp0};');
		expect(artifact).toContain('tools: agentTools(declaredWorkspace.tools, declaredMcpServers)');
		expect(artifact).toContain('"body": "# Payroll\\n\\nUse the approved workflow."');
		expect(artifact).toContain('"invoices": pipelines0');
		expect(artifact).toContain('name: "nightly"');
		expect(artifact).toContain('pipelines: declaredPipelines');
		expect(artifact).toContain('automations: declaredAutomations');
		expect(artifact).toContain('cron: automation0.trigger.schedule');
		expect(artifact).toContain("automation0.trigger.trigger === undefined ? { _tag: 'Manual' }");
		expect(artifact).toContain('collection: automation0.trigger.trigger.collection');
		expect(artifact).toContain('event: automation0.trigger.trigger.event');
		expect(artifact).toContain('const automations = declaredWorkspace.automations.map(');
		expect(artifact).toContain('policies: declaredAutomations[automation.name].policies');
	});

	it('boots one automation descriptor with its declared policies intact', () => {
		const artifact = artifactWithEverything();
		const start = artifact.indexOf('const automations = declaredWorkspace.automations.map(');
		const end = artifact.indexOf('\n// The index of what this release ships', start);
		if (start < 0 || end < 0) {
			throw new Error('the artifact no longer builds its runtime workspace in one emitted block');
		}

		const workspace = new Function(
			'declaredWorkspace',
			'declaredAutomations',
			'collections',
			'envoys',
			'policies',
			'declaredCustomTypes',
			'describedIntegrations',
			'agentTools',
			'declaredMcpServers',
			`${artifact.slice(start, end)}\nreturn workspace;`
		)(
			{
				automations: [{ name: 'nightly', trigger: { _tag: 'Schedule', cron: '0 0 * * *' } }],
				collections: [],
				envoys: []
			},
			{
				nightly: {
					name: 'nightly',
					trigger: { _tag: 'Schedule', cron: '0 0 * * *' },
					policies: ['operations']
				}
			},
			[],
			[],
			[],
			{},
			{ declarations: [] },
			(tools: unknown) => tools,
			{}
		) as { readonly automations: ReadonlyArray<{ readonly policies: ReadonlyArray<string> }> };

		// Activation mints each automation principal by spreading this exact array. The duplicate
		// projection this guards against overwrote the descriptor with { name, trigger, command }, so
		// the first real boot failed here with "automation.policies is not iterable".
		expect([...workspace.automations[0]!.policies]).toEqual(['operations']);
	});
});
