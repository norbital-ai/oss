import { describe, expect, it } from 'vitest';
import { defineModel, text } from '../../src/authoring/models-schema.js';
import { compileModel, describeHooks } from '../../src/authoring/model-introspection.js';
import { renderArtifact } from '../../src/compiler/sync.js';

/**
 * What `defineModel` metadata survives the crossing into the artifact.
 *
 * `renderArtifact` rebuilds each collection descriptor key by key, so anything it does not name is
 * dropped without an error anywhere — which is how `approvalLock`, `description` and `icon` came to
 * be declared by templates and read by nothing. `approvalLock` was the worst of the three:
 * `Collections` already intercepts a write on `definition.approvalLock`, so the gate worked while
 * the only way to ask for it did nothing at all.
 *
 * The emitted mapping is executed rather than pattern-matched. A test that greps the generated text
 * passes on the spelling of a line; this one passes only if the descriptor actually comes out
 * carrying the metadata, which is the claim.
 */

const root = '/workspace';

/** The one statement in the artifact that turns declarations into collection descriptors. */
const collectionDescriptors = (
	artifact: string,
	declaredModels: Readonly<Record<string, unknown>>,
	declaredWorkspace: {
		readonly collections: ReadonlyArray<{ readonly name: string; readonly history: boolean }>;
	}
): ReadonlyArray<Record<string, unknown>> => {
	const start = artifact.indexOf('const collections = declaredWorkspace.collections.map(');
	const end = artifact.indexOf('\n// The authored module is the authority', start);
	if (start < 0 || end < 0)
		throw new Error('the artifact no longer maps collections in one statement');
	const source = `${artifact.slice(start, end)}\nreturn collections;`;
	return new Function(
		'declaredWorkspace',
		'declaredModels',
		'declaredHooks',
		'collectionSourcePaths',
		'compileModel',
		'describeHooks',
		source
	)(declaredWorkspace, declaredModels, {}, {}, compileModel, describeHooks) as ReadonlyArray<
		Record<string, unknown>
	>;
};

const artifactFor = (collections: ReadonlyArray<string>): string =>
	renderArtifact({
		metadata: { name: 'fixture', version: '1.0.0', description: 'Bolt workspace' },
		collections: collections.map((name) => ({
			name,
			path: `${root}/src/collections/${name}/+model.ts`,
			sourcePath: `src/collections/${name}/+model.ts`,
			fields: { title: { type: 'string', required: true, indexed: false } }
		})),
		relations: [],
		apps: [],
		policies: [],
		functions: [],
		toolFiles: [],
		envoyFiles: [],
		automations: [],
		automationFiles: [],
		pipelineFiles: [],
		skills: [],
		prompt: 'You are the test workspace agent.',
		root,
		assets: [],
		customTypeDefinitions: [],
		environmentFile: undefined,
		migrations: []
	});

describe('artifact collection metadata', () => {
	it('carries every declared metadata option onto the collection descriptor', () => {
		const artifact = artifactFor(['orders']);
		const [orders] = collectionDescriptors(
			artifact,
			{
				orders: defineModel(
					{ title: text() },
					{
						approvalLock: true,
						description: 'Purchase orders awaiting fulfilment',
						icon: 'lucide:package'
					}
				)
			},
			{ collections: [{ name: 'orders', history: true }] }
		);

		expect(orders?.['approvalLock']).toBe(true);
		expect(orders?.['description']).toBe('Purchase orders awaiting fulfilment');
		expect(orders?.['icon']).toBe('lucide:package');
	});

	// An undeclared option must stay absent rather than arrive as `undefined`: the manifest projection
	// tests `=== undefined` to decide whether to emit a key at all, so a present-but-empty key would
	// turn "this workspace said nothing" into "this workspace said nothing, explicitly".
	it('leaves a collection that declared none of them without the keys', () => {
		const artifact = artifactFor(['notes']);
		const [notes] = collectionDescriptors(
			artifact,
			{ notes: defineModel({ title: text() }) },
			{ collections: [{ name: 'notes', history: true }] }
		);

		expect(notes).not.toHaveProperty('approvalLock');
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
		const artifact = artifactFor(['audit_scratch']);
		const [scratch] = collectionDescriptors(
			artifact,
			{ audit_scratch: defineModel({ title: text() }, { history: false }) },
			{ collections: [{ name: 'audit_scratch', history: true }] }
		);

		expect(scratch?.['history']).toBe(false);
	});

	it('leaves a collection that declared no history preference tracked', () => {
		const artifact = artifactFor(['notes']);
		const [notes] = collectionDescriptors(
			artifact,
			{ notes: defineModel({ title: text() }) },
			{ collections: [{ name: 'notes', history: true }] }
		);

		expect(notes?.['history']).toBe(true);
	});
});
