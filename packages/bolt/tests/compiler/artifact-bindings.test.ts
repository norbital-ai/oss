import { describe, expect, it } from 'vitest';
import { COMPILED_MANIFEST_VERSION } from '@norbital-ai/bolt-protocol';
import { renderArtifact } from '../../src/compiler/workspace-build.js';

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
		compiledAuthoring: {
			collections: [
				{
					name: 'invoices',
					fields: {},
					history: true,
					sourcePath: 'src/collections/invoices/+model.ts'
				}
			],
			relationships: [],
			customTypeReferences: [],
			capabilities: {
				skills: [{ name: 'payroll', description: 'Payroll workflow', digest: 'skill', files: [] }],
				mcp: [{
					name: 'search',
					digest: 'mcp',
					protocol: '2026-07-28',
					transport: { kind: 'streamable-http', endpoint: 'https://mcp.example' }
				}]
			}
		},
		collectionHooks: [
			{ name: 'invoices', path: `${root}/src/collections/invoices/+hooks.ts` }
		],
		apps: [
			{
				name: 'billing',
				label: 'Billing',
				sourcePath: 'src/apps/+billing.svelte'
			}
		],
		appGroups: [
			{
				name: 'finance',
				label: 'Finance',
				sourcePath: 'src/apps/finance/+group.ts'
			}
		],
		policies: [`${root}/src/access/policies/+admin.ts`],
		functions: [`${root}/src/functions/+summary.ts`],
		toolFiles: [`${root}/src/tools/+summarize.tool.ts`],
		envoyFiles: [`${root}/src/envoys/+support.ts`],
		automations: ['nightly'],
		automationFiles: [`${root}/src/automations/+nightly.ts`],
		pipelineFiles: [`${root}/src/collections/invoices/+pipelines.ts`],
		integrationFiles: [`${root}/src/collections/invoices/+integrations.ts`],
		prompt: 'You are the test workspace agent.',
		root,
		assetIndex: { browser: [], server: [] },
		customTypeDefinitions: [],
		environmentFile: `${root}/src/+env.ts`,
		migrations: [],
		schemaFingerprint: 'sha256:fixture'
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
		expect(artifact).not.toContain('import mcp0 from');
		expect(artifact).not.toContain('declaredMcpServers');
		expect(artifact).not.toContain('agentTools');
		expect(artifact).not.toContain('Use the approved workflow.');
		expect(artifact).toContain('"invoices": pipelines0');
		expect(artifact).toContain('name: "nightly"');
		expect(artifact).toContain('pipelines: declaredPipelines');
		expect(artifact).toContain('automations: declaredAutomations');
		expect(artifact).toContain('cron: automation0.trigger.schedule');
		expect(artifact).toContain("automation0.trigger.trigger === undefined ? { _tag: 'Manual' }");
		expect(artifact).toContain('collection: automation0.trigger.trigger.collection');
		expect(artifact).toContain('event: automation0.trigger.trigger.event');
		expect(artifact).toContain('description: automation0.spec.description');
		expect(artifact).toContain('const automations = declaredWorkspace.automations.map(');
		expect(artifact).toContain('policies: declaredAutomations[automation.name].policies');
	});

	it('embeds the current manifest version and every compiler-discovered authored source path', () => {
		const artifact = artifactWithEverything();
		for (const sourcePath of [
			'src/collections/invoices/+model.ts',
			'src/collections/invoices/+hooks.ts',
			'src/collections/invoices/+pipelines.ts',
			'src/collections/invoices/+integrations.ts',
			'src/apps/+billing.svelte',
			'src/apps/finance/+group.ts',
			'src/access/policies/+admin.ts',
			'src/envoys/+support.ts',
			'src/automations/+nightly.ts',
			'src/functions/+summary.ts',
			'src/+env.ts'
		]) {
			expect(artifact).toContain(JSON.stringify(sourcePath));
		}
		expect(artifact).toContain(
			`\"compiledManifestVersion\": ${COMPILED_MANIFEST_VERSION}`
		);
	});

	it('boots one automation descriptor with its declared policies intact', () => {
		const artifact = artifactWithEverything();
		const start = artifact.indexOf('const automations = declaredWorkspace.automations.map(');
		const end = artifact.indexOf('\nconst browserAssets =', start);
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
			'declaredEnvironment',
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
			{}
		) as { readonly automations: ReadonlyArray<{ readonly policies: ReadonlyArray<string> }> };

		// Activation mints each automation principal by spreading this exact array. The duplicate
		// projection this guards against overwrote the descriptor with { name, trigger, command }, so
		// the first real boot failed here with "automation.policies is not iterable".
		expect([...workspace.automations[0]!.policies]).toEqual(['operations']);
	});
});
