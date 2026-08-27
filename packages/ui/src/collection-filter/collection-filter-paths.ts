import type { CollectionField, CollectionRelationship } from '@norbital-ai/std/collection';

export interface FilterCollectionDefinition {
	readonly name: string;
	readonly fields: readonly CollectionField[];
	readonly recordLabel?: string | null;
	readonly relationships?: readonly CollectionRelationship[];
}

/** One schema-derived filter leaf, including every relationship edge needed to reach it. */
export interface CollectionFilterField {
	readonly value: string;
	readonly path: readonly string[];
	readonly field: CollectionField;
	readonly branch: readonly CollectionRelationship[];
	/** A record key is edited by the automatic relationship strategy, never as uuid text. */
	readonly lookupTarget?: string;
}

/**
 * Root attributes plus related attributes through two relationship edges.
 *
 * Depth is counted from the root collection: direct fields are depth 0, a related collection is
 * depth 1, and a relationship from that collection is depth 2. The bounded traversal is cycle-safe
 * without suppressing useful self-relations such as manager.manager.name.
 */
export function collectionFilterFields(
	definition: FilterCollectionDefinition,
	collections: Readonly<Record<string, FilterCollectionDefinition>>
): readonly CollectionFilterField[] {
	const filterFields: CollectionFilterField[] = [];

	function visit(
		current: FilterCollectionDefinition,
		branch: readonly CollectionRelationship[],
		depth: number
	): void {
		const relationshipByName = new Map(
			(current.relationships ?? []).map((relation) => [relation.name, relation] as const)
		);
		const prefix = branch.map((relation) => relation.name);
		for (const field of current.fields) {
			const fieldRelationship =
				field.relation && depth < 2
					? (relationshipByName.get(field.relation.name) ?? {
							name: field.relation.name,
							target: field.relation.target,
							cardinality: field.array ? 'many' : 'one'
						})
					: undefined;
			const fieldBranch = fieldRelationship ? [...branch, fieldRelationship] : branch;
			const path = [...prefix, field.name];
			filterFields.push({
				value: path.join('.'),
				path,
				field,
				branch: fieldBranch,
				...(field.relation
					? { lookupTarget: field.relation.target }
					: field.name === 'id'
						? { lookupTarget: current.name }
						: {})
			});
		}

		if (depth >= 2) return;
		for (const relation of current.relationships ?? []) {
			const target = collections[relation.target];
			if (target) visit(target, [...branch, relation], depth + 1);
		}
	}

	visit(definition, [], 0);
	return filterFields;
}
