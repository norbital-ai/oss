import { Schema } from 'effect';
import {
	BundleManifest,
	COMPILED_MANIFEST_VERSION,
	PROTOCOL_VERSION
} from '@norbital-ai/bolt-protocol';
import { sha256Text } from '@norbital-ai/std/reckon/hash';
import { canonicalJson } from '../canonical-json.js';
import { manifestIntegrations } from '../authoring/integration-introspection.js';
import type { WorkspaceDefinition } from '../authoring/workspace-schema.js';
import { policyIndexRequirements } from '../runtime/access/effective-plan.js';
import { buildSchemaPlan } from '../runtime/schema/schema-plan.js';
import { withSystemCollections } from '../runtime/schema/system-collections.js';

/** Owns fingerprint behavior at the manifest boundary so validation and typed semantics stay consistent for every caller. */
const ManifestValues = {
	fingerprint: (value: unknown): string => `sha256:${sha256Text(canonicalJson(value))}`
};
export const fingerprint = ManifestValues.fingerprint;

const ManifestInput = Schema.Struct({ artifactId: Schema.NonEmptyString });
interface ManifestInput extends Schema.Schema.Type<typeof ManifestInput> {}

export const buildManifest = (
	workspace: WorkspaceDefinition,
	input: ManifestInput
): BundleManifest => {
	const requiredFacilities = [...new Set(workspace.requiredFacilities)].sort();
	const effectiveWorkspace = withSystemCollections(workspace);
	const schemaPlan = buildSchemaPlan(workspace, policyIndexRequirements(effectiveWorkspace));
	const schemaFingerprint = workspace.schemaFingerprint;
	if (schemaFingerprint === undefined)
		throw new TypeError('Compiled workspace is missing its schema fingerprint.');
	return BundleManifest.make({
		protocolVersion: PROTOCOL_VERSION,
		compiledManifestVersion: COMPILED_MANIFEST_VERSION,
		artifactId: input.artifactId,
		artifactVersion: workspace.version,
		schemaFingerprint,
		schemaPlan,
		requiredFacilities,
		// Empty here and filled by `bolt sync`, which is the only party that has seen a build: this
		// function describes a workspace definition, and a definition ships no files.
		browserAssets: [],
		serverAssets: [],
		// `workspace.integrations` used to reach this function only to be hashed into the fingerprint,
		// which meant a host could tell that the integrations had *changed* and never what they were.
		integrations: manifestIntegrations(workspace.integrations)
	});
};
