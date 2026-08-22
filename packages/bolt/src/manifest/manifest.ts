import { createHash } from 'node:crypto';
import { Schema } from 'effect';
import { BundleManifest, PROTOCOL_VERSION } from '@norbital-ai/bolt-protocol';
import { manifestIntegrations } from '../authoring/integration-introspection.js';
import type { WorkspaceDefinition } from '../authoring/workspace-schema.js';

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
	fingerprint: (value: unknown): string =>
		`sha256:${createHash('sha256').update(stable(value)).digest('hex')}`
};
export const fingerprint = ManifestValues.fingerprint;

export const ManifestInput = Schema.Struct({ artifactId: Schema.NonEmptyString });
export interface ManifestInput extends Schema.Schema.Type<typeof ManifestInput> {}

export const buildManifest = (
	workspace: WorkspaceDefinition,
	input: ManifestInput
): BundleManifest => {
	const requiredFacilities = [...new Set(workspace.requiredFacilities)].sort();
	const schemaFingerprint = fingerprint({
		collections: workspace.collections,
		policies: workspace.policies,
		// The workspace's tools and skills, which used to be hashed as a property of the one
		// synthesized agent. They are the workspace's — a policy decides who reaches them — so they are
		// hashed as the workspace's.
		tools: workspace.tools,
		skills: workspace.skills,
		prompt: workspace.prompt,
		automations: workspace.automations,
		envoys: workspace.envoys,
		integrations: workspace.integrations
	});
	return BundleManifest.make({
		protocolVersion: PROTOCOL_VERSION,
		artifactId: input.artifactId,
		artifactVersion: workspace.version,
		schemaFingerprint,
		requiredFacilities,
		staticAssets: [],
		// `workspace.integrations` used to reach this function only to be hashed into the fingerprint,
		// which meant a host could tell that the integrations had *changed* and never what they were.
		integrations: manifestIntegrations(workspace.integrations)
	});
};
