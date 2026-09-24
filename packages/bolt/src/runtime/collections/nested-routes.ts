import type { WorkspaceDefinition } from '#lib/authoring/workspace-schema.js';

/** One parent input that files `collection` through a nested create, and the columns it accepts. */
export interface NestedCreateRoute {
	readonly parent: string;
	readonly mode: 'create' | 'update';
	readonly relation: string;
	readonly columns: ReadonlyArray<string>;
}

/**
 * Every declared parent input that creates `collection` nested under it.
 *
 * A column a collection's own contract refuses — a channel photo's `source` — is often accepted only
 * this way. The agent snapshot lists these routes and a refusal names them, because a writer told
 * only "not part of the declared input" drops the column to get through.
 */
export const nestedCreateRoutes = (
	definition: Pick<WorkspaceDefinition, 'collections' | 'relations'>,
	collection: string
): ReadonlyArray<NestedCreateRoute> =>
	definition.collections.flatMap((parent) =>
		(['create', 'update'] as const).flatMap((mode) =>
			Object.entries(parent.write?.[mode]?.with ?? {}).flatMap(([relation, actions]) => {
				const declared = definition.relations.find(
					(candidate) => candidate.source === parent.name && candidate.name === relation
				);
				return declared?.target === collection && actions.create !== undefined
					? [
							{
								parent: parent.name,
								mode,
								relation,
								columns: Object.keys(actions.create.columns ?? {})
							}
						]
					: [];
			})
		)
	);
