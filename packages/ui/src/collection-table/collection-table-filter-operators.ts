import type { CollectionField, CollectionFilter } from '@norbital-ai/platform-utils/collection';

export type CollectionFilterOperator = CollectionFilter['operator'] | 'contains';

export interface CollectionFilterOperatorOption {
	readonly value: CollectionFilterOperator;
	readonly label: string;
}

const equalityOperators: readonly CollectionFilterOperatorOption[] = [
	{ value: 'eq', label: 'is' },
	{ value: 'ne', label: 'is not' }
];
const orderedOperators: readonly CollectionFilterOperatorOption[] = [
	...equalityOperators,
	{ value: 'gt', label: 'is greater than' },
	{ value: 'gte', label: 'is at least' },
	{ value: 'lt', label: 'is less than' },
	{ value: 'lte', label: 'is at most' }
];
const textOperators: readonly CollectionFilterOperatorOption[] = [
	{ value: 'contains', label: 'contains' },
	...equalityOperators
];
const arrayOperators: readonly CollectionFilterOperatorOption[] = [
	{ value: 'arrayContains', label: 'contains all' },
	{ value: 'arrayOverlaps', label: 'contains any' },
	{ value: 'eq', label: 'is exactly' },
	{ value: 'ne', label: 'is not' }
];
const emptyOperators: readonly CollectionFilterOperatorOption[] = [
	{ value: 'isNull', label: 'is empty' },
	{ value: 'isNotNull', label: 'is not empty' }
];

export function collectionFilterOperatorOptions(
	field: CollectionField
): readonly CollectionFilterOperatorOption[] {
	let applicable: readonly CollectionFilterOperatorOption[];
	if (field.array) {
		applicable = arrayOperators;
	} else if (field.relation) {
		applicable = equalityOperators;
	} else {
		switch (field.kind) {
			case 'text':
			case 'string':
			case 'phone':
				applicable = textOperators;
				break;
			case 'numeric':
			case 'number':
			case 'integer':
			case 'date':
			case 'clock_time':
			case 'timestamp':
			case 'timestamptz':
				applicable = orderedOperators;
				break;
			case 'date-range':
				applicable = [
					{ value: 'contains_date', label: 'contains date' },
					{ value: 'overlaps', label: 'overlaps' }
				];
				break;
			case 'json':
				applicable = [{ value: 'contains', label: 'contains' }];
				break;
			default:
				applicable = equalityOperators;
		}
	}
	return field.nullable ? [...applicable, ...emptyOperators] : applicable;
}

export function collectionFilterOperatorNeedsValue(operator: CollectionFilterOperator): boolean {
	return operator !== 'isNull' && operator !== 'isNotNull';
}

export function collectionFilterOperandField(
	field: CollectionField,
	operator: CollectionFilterOperator
): CollectionField {
	return operator === 'contains_date' ? { name: field.name, kind: 'date', nullable: false } : field;
}

export function collectionFilterQueryOperator(
	field: CollectionField,
	operator: CollectionFilterOperator
): CollectionFilter['operator'] {
	if (operator !== 'contains') return operator;
	return ['text', 'string', 'phone'].includes(field.kind) ? 'ilike' : 'arrayContains';
}
