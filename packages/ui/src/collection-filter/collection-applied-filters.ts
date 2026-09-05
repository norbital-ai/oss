import { Schema } from 'effect';
import type { CollectionField, CollectionRelationship } from '@norbital-ai/std/collection';
import { humanize } from '@norbital-ai/std/string';
import type { FilterCollectionDefinition } from './collection-filter-fields.js';

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

const whereNodeSchema = Schema.Record(Schema.String, Schema.Unknown);
const decodeWhereNode = Schema.decodeUnknownResult(whereNodeSchema);
const isWhereNode = Schema.is(whereNodeSchema);

function linkedLabel(field: CollectionField): string {
	return (field.label ?? humanize(field.name)).replace(/\s+id$/i, '').trim();
}

function relationshipLabel(
	definition: FilterCollectionDefinition,
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
	definition: FilterCollectionDefinition,
	collections: Readonly<Record<string, FilterCollectionDefinition>>
): readonly CollectionAppliedFilterCondition[] {
	let nextKey = 0;

	function walk(
		value: unknown,
		current: FilterCollectionDefinition,
		path: readonly string[],
		negated: boolean,
		alternative: boolean
	): CollectionAppliedFilterCondition[] {
		if (Array.isArray(value)) {
			return value.flatMap((entry) => walk(entry, current, path, negated, alternative));
		}
		// One decode at the boundary: every node of the authored `where` tree is a plain record. The
		// relationship and field lookups below index the same definition once instead of re-searching
		// it for every condition it holds.
		const node = decodeWhereNode(value);
		if (node._tag === 'Failure') return [];
		const relationshipByName = new Map(
			(current.relationships ?? []).map((relation) => [relation.name, relation])
		);
		const fieldByName = new Map(current.fields.map((field) => [field.name, field] as const));

		return Object.entries(node.success).flatMap(([name, condition]) => {
			if (name === 'AND') return walk(condition, current, path, negated, alternative);
			if (name === 'OR') return walk(condition, current, path, negated, true);
			if (name === 'NOT') return walk(condition, current, path, !negated, alternative);

			const relation = relationshipByName.get(name);
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

			const field = fieldByName.get(name) ?? {
				name,
				kind: 'unknown',
				nullable: true
			};
			// A nested target's primary key describes the relationship itself ("Company"), not an
			// implementation detail such as "Company · Norbital" or a UUID column name.
			const label =
				name === 'id' && path.length > 0
					? path.join(' · ')
					: [...path, linkedLabel(field)].join(' · ');
			const lookupTarget = field.relation?.target ?? (name === 'id' ? current.name : undefined);
			let operators: Array<[string, unknown]> = [];
			if (isWhereNode(condition)) {
				for (const [operator, operand] of Object.entries(condition)) {
					operators.push([operator, operand]);
				}
			} else {
				operators = [['eq', condition]];
			}

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
