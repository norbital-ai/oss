import type {
	CollectionField,
	CollectionRelationship
} from '@norbital-ai/platform-utils/collection';
import { humanize } from '@norbital-ai/std/string';

export interface CollectionAppliedFilterCondition {
	readonly key: string;
	readonly field: CollectionField;
	readonly label: string;
	readonly operator: string;
	readonly operand: unknown;
	readonly negated: boolean;
	readonly alternative: boolean;
	readonly lookupTarget?: string;
}

export interface AppliedFilterCollectionDefinition {
	readonly name: string;
	readonly fields: readonly CollectionField[];
	readonly recordLabel?: string | null;
	readonly relationships?: readonly CollectionRelationship[];
}

function linkedLabel(field: CollectionField): string {
	return (field.label ?? humanize(field.name)).replace(/\s+id$/i, '').trim();
}

function relationshipLabel(
	definition: AppliedFilterCollectionDefinition,
	relation: CollectionRelationship
): string {
	const linkedField = definition.fields.find((field) => field.relation?.name === relation.name);
	return linkedField ? linkedLabel(linkedField) : humanize(relation.name);
}

/**
 * Turn an authored `where` tree into schema-bearing conditions for the table's about popover.
 *
 * Keeping the field metadata is the important difference from a string description: the value can
 * now use the same datatype renderer as the filter builder, while relationship keys can resolve to
 * their record labels instead of leaking UUIDs.
 */
export function collectionAppliedFilterConditions(
	where: unknown,
	definition: AppliedFilterCollectionDefinition,
	collections: Readonly<Record<string, AppliedFilterCollectionDefinition>>
): readonly CollectionAppliedFilterCondition[] {
	let nextKey = 0;

	function walk(
		value: unknown,
		current: AppliedFilterCollectionDefinition,
		path: readonly string[],
		negated: boolean,
		alternative: boolean
	): CollectionAppliedFilterCondition[] {
		if (Array.isArray(value)) {
			return value.flatMap((entry) => walk(entry, current, path, negated, alternative));
		}
		if (typeof value !== 'object' || value == null) return [];

		return Object.entries(value as Record<string, unknown>).flatMap(([name, condition]) => {
			if (name === 'AND') return walk(condition, current, path, negated, alternative);
			if (name === 'OR') return walk(condition, current, path, negated, true);
			if (name === 'NOT') return walk(condition, current, path, !negated, alternative);

			const relation = current.relationships?.find((candidate) => candidate.name === name);
			if (relation) {
				const target = collections[relation.target];
				if (target) {
					return walk(
						condition,
						target,
						[...path, relationshipLabel(current, relation)],
						negated,
						alternative
					);
				}
			}

			const field = current.fields.find((candidate) => candidate.name === name) ?? {
				name,
				kind: 'unknown',
				nullable: true
			};
			// A nested target's primary key describes the relationship itself ("Company"), not an
			// implementation detail such as "Company · Norbital" or a UUID column name.
			const label =
				name === 'norbital_id' && path.length > 0
					? path.join(' · ')
					: [...path, linkedLabel(field)].join(' · ');
			const lookupTarget =
				field.relation?.target ?? (name === 'norbital_id' ? current.name : undefined);
			const operators =
				typeof condition === 'object' && condition != null && !Array.isArray(condition)
					? Object.entries(condition as Record<string, unknown>)
					: [['eq', condition] as const];

			return operators.map(([operator, operand]) => ({
				key: `applied-filter-${nextKey++}`,
				field,
				label,
				operator,
				operand,
				negated,
				alternative,
				...(lookupTarget ? { lookupTarget } : {})
			}));
		});
	}

	return walk(where, definition, [], false, false);
}
