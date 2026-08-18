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
	renderArtifact(
		{ name: 'fixture', version: '1.0.0', description: 'Bolt workspace' },
		[], // collections
		[], // relations
		[], // apps
		[`${root}/src/policies/+admin.policy.ts`],
		[`${root}/src/remotes/+summary.ts`],
		[`${root}/src/tools/+summarize.tool.ts`],
		[], // channelFiles
		['nightly'], // automation names
		[`${root}/src/automations/+nightly.ts`],
		[`${root}/src/collections/invoices/+pipelines.ts`],
		[], // skills
		'fixture-agent',
		root,
		[], // assets
		[], // customTypeDefinitions
		undefined,
		[]
	);

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
			(match) => (match[2] ?? match[1] ?? '').split(',').map((name) => name.trim()).filter(Boolean)
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
		expect(artifact).toContain('"invoices": pipelines0');
		expect(artifact).toContain('[automation0]');
		expect(artifact).toContain('pipelines: declaredPipelines');
		expect(artifact).toContain('automations: declaredAutomations');
	});
});
