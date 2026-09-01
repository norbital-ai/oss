import { describe, expect, it } from 'vitest';
import {
	defineModel,
	text,
	type ModelDeclaration
} from '../../src/authoring/models-schema.js';
import { compileWorkspaceAuthoring } from '../../src/authoring/model-introspection.js';
import { renderArtifact } from '../../src/compiler/workspace-build.js';

/**
 * What `defineModel` metadata survives the crossing into the artifact.
 *
 * `renderArtifact` embeds the collection descriptors from `CompiledAuthoring` without rebuilding
 * model semantics in the runtime bundle.
 *
 * The emitted mapping is executed rather than pattern-matched. A test that greps the generated text
 * passes on the spelling of a line; this one passes only if the descriptor actually comes out
 * carrying the metadata, which is the claim.
 */

const root = '/workspace';

/** Reads the already-compiled collection descriptors embedded in the artifact. */
const collectionDescriptors = (artifact: string): ReadonlyArray<Record<string, unknown>> => {
	const start = artifact.indexOf('const declaredWorkspace = ');
	const end = artifact.indexOf('\n};\n', start) + '\n};'.length;
	if (start < 0 || end < '\n};'.length)
		throw new Error('the artifact no longer declares a workspace literal');
	return (
		new Function(`${artifact.slice(start, end)}\nreturn declaredWorkspace;`)() as {
			readonly collections: ReadonlyArray<Record<string, unknown>>;
		}
	).collections;
};

const artifactFor = (
	models: Readonly<Record<string, ModelDeclaration>>
): string => {
	const compiledAuthoring = compileWorkspaceAuthoring({
		models,
		sourcePaths: Object.fromEntries(
			Object.keys(models).map((name) => [name, `src/collections/${name}/+model.ts`])
		)
	});
	return renderArtifact({
		metadata: { name: 'fixture', version: '1.0.0', description: 'Bolt workspace' },
		compiledAuthoring,
		collectionHooks: [],
		apps: [],
		policies: [],
		functions: [],
		toolFiles: [],
		envoyFiles: [],
		automations: [],
		automationFiles: [],
		pipelineFiles: [],
		prompt: 'You are the test workspace agent.',
		root,
		assetIndex: { browser: [], server: [] },
		customTypeDefinitions: [],
		environmentFile: undefined,
		migrations: [],
		schemaFingerprint: 'sha256:fixture'
	});
};

describe('artifact collection metadata', () => {
	it('embeds compiled model semantics without importing model declarations', () => {
		const artifact = artifactFor({ notes: defineModel({ title: text() }) });

		expect(artifact).toContain('src/collections/notes/+model.ts');
		expect(artifact).not.toMatch(/^import model\d+ from /m);
		expect(artifact).not.toContain('compileModel');
		expect(artifact).not.toContain('declaredModels');
	});

	it('carries every declared metadata option onto the collection descriptor', () => {
		const artifact = artifactFor({
			orders: defineModel(
				{ title: text() },
				{
					description: 'Purchase orders awaiting fulfilment',
					icon: 'lucide:package'
				}
			)
		});
		const [orders] = collectionDescriptors(artifact);

		expect(orders?.['description']).toBe('Purchase orders awaiting fulfilment');
		expect(orders?.['icon']).toBe('lucide:package');
	});

	// An undeclared option must stay absent rather than arrive as `undefined`: the manifest projection
	// tests `=== undefined` to decide whether to emit a key at all, so a present-but-empty key would
	// turn "this workspace said nothing" into "this workspace said nothing, explicitly".
	it('leaves a collection that declared none of them without the keys', () => {
		const artifact = artifactFor({ notes: defineModel({ title: text() }) });
		const [notes] = collectionDescriptors(artifact);

		expect(notes).not.toHaveProperty('description');
		expect(notes).not.toHaveProperty('icon');
	});

	/**
	 * `history` decides whether `Collections` writes a `bolt_collection_history` row per mutation, and
	 * the descriptor the compiler builds hardcodes it true. So opting out was accepted and dropped —
	 * the collection kept the full revision trail the author had just declined — and the option was
	 * only reachable at all because the migration generator read it for an unrelated purpose.
	 */
	it('carries a declared history opt-out onto the collection descriptor', () => {
		const artifact = artifactFor({
			audit_scratch: defineModel({ title: text() }, { history: false })
		});
		const [scratch] = collectionDescriptors(artifact);

		expect(scratch?.['history']).toBe(false);
	});

	it('leaves a collection that declared no history preference tracked', () => {
		const artifact = artifactFor({ notes: defineModel({ title: text() }) });
		const [notes] = collectionDescriptors(artifact);

		expect(notes?.['history']).toBe(true);
	});
});
