import { Schema } from 'effect';
import type { WorkspaceDefinition } from '#lib/authoring/workspace-schema.js';
import type { AuthoredRuntime } from '#lib/runtime/collections/authored.js';

const jsonObject = (
	entry: Readonly<Record<string, Schema.Json | undefined>>
): Readonly<Record<string, Schema.Json>> => {
	const value: Record<string, Schema.Json> = {};
	for (const [key, field] of Object.entries(entry)) {
		if (field !== undefined) value[key] = field;
	}
	return value;
};

/** Projects the authored declarations whose complete wire shape is richer than name-only metadata. */
export const authoredManifestDeclarations = (
	definition: WorkspaceDefinition,
	authoredRuntime: AuthoredRuntime
) => ({
	apps: definition.apps.map(({ name, label, icon, description, banner, thumbnail }) =>
		jsonObject({ name, label, icon, description, banner, thumbnail })
	),
	policies: definition.policies.map((policy) => ({
		name: policy.name,
		description: policy.description ?? '',
		grants: (policy.grants ?? []).map((grant) =>
			jsonObject({
				collection: grant.collection,
				action: grant.action,
				fields: grant.fields === undefined ? undefined : [...grant.fields],
				dependencies: grant.dependencies === undefined ? undefined : [...grant.dependencies],
				where:
					grant.where === undefined
						? undefined
						: Schema.decodeUnknownSync(Schema.Json)(grant.where),
				approval: grant.approval === undefined ? undefined : true,
				authorization: grant.authorization === undefined ? undefined : true
			})
		),
		capabilities: {
			apps: [...(policy.capabilities?.apps ?? [])],
			tools: [...(policy.capabilities?.tools ?? [])],
			mcp: [...(policy.capabilities?.mcp ?? [])],
			skills: [...(policy.capabilities?.skills ?? [])]
		}
	})),
	automations: definition.automations.map(({ name, trigger, policies }) =>
		jsonObject({
			name,
			description: authoredRuntime.automations[name]?.description,
			trigger: Schema.decodeUnknownSync(Schema.Json)(trigger),
			policies: [...policies]
		})
	)
});
