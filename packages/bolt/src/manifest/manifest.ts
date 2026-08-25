import { Schema } from 'effect';
import { BundleManifest, PROTOCOL_VERSION } from '@norbital-ai/bolt-protocol';
import { sha256Text } from '@norbital-ai/std/reckon/hash';
import { manifestIntegrations } from '../authoring/integration-introspection.js';
import type { WorkspaceDefinition } from '../authoring/workspace-schema.js';
import { buildSchemaPlan } from '../compiler/schema-plan.js';

/** Owns stable behavior at the manifest boundary so validation and typed semantics stay consistent for every caller. */
const stable = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
};

/** Owns fingerprint behavior at the manifest boundary so validation and typed semantics stay consistent for every caller. */
const ManifestValues = {
	fingerprint: (value: unknown): string => `sha256:${sha256Text(stable(value))}`
};
export const fingerprint = ManifestValues.fingerprint;

const ManifestInput = Schema.Struct({ artifactId: Schema.NonEmptyString });
interface ManifestInput extends Schema.Schema.Type<typeof ManifestInput> {}

export const buildManifest = (
	workspace: WorkspaceDefinition,
	input: ManifestInput
): BundleManifest => {
	const requiredFacilities = [...new Set(workspace.requiredFacilities)].sort();
	const schemaPlan = buildSchemaPlan(workspace);
	return BundleManifest.make({
		protocolVersion: PROTOCOL_VERSION,
		artifactId: input.artifactId,
		artifactVersion: workspace.version,
		schemaFingerprint: schemaPlan.fingerprint,
		schemaPlan,
		requiredFacilities,
		staticAssets: [],
		// `workspace.integrations` used to reach this function only to be hashed into the fingerprint,
		// which meant a host could tell that the integrations had *changed* and never what they were.
		integrations: manifestIntegrations(workspace.integrations)
	});
};
