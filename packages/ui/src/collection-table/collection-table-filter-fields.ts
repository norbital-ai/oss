import type {
	CollectionField,
	CollectionFilter,
	CollectionRelationship
} from '@norbital-ai/platform-utils/collection';
import { isSystemColumnName } from '@norbital-ai/platform-utils/system/column_names';
import { humanize } from '@norbital-ai/std/string';
import { ENTITY_ICONS } from '../icon-wrapper/entity-icons.js';
import type { BaseTreeItem } from '#lib/tree-select';
import { calendarDateToInstant } from '../data-renderer/time_stamp/date.utils.js';

export interface FilterCollectionDefinition {
	readonly name: string;
	readonly fields: readonly CollectionField[];
	readonly relationships?: readonly CollectionRelationship[];
}

export interface CollectionFilterField {
	readonly value: string;
	readonly field: CollectionField;
	readonly relation?: {
		readonly name: string;
		readonly target: string;
		readonly cardinality: 'one' | 'many';
	};
}

interface CollectionFilterRelationshipBranch {
	name: string;
	target: string;
	cardinality: 'one' | 'many';
	linkedFields: CollectionFilterField[];
	relatedFields: CollectionFilterField[];
}

function collectionFilterFieldIcon(field: CollectionField): string {
	switch (field.kind) {
		case 'boolean':
			return ENTITY_ICONS.datatype.bool;
		case 'date':
			return ENTITY_ICONS.ui.calendar;
		case 'clock_time':
			return ENTITY_ICONS.datatype.timestamptz;
		case 'date-range':
			return ENTITY_ICONS.datatype['date-range'];
		case 'enum':
			return ENTITY_ICONS.datatype.enum;
		case 'file':
			return ENTITY_ICONS.datatype.file;
		case 'geolocation':
			return ENTITY_ICONS.datatype.geolocation;
		case 'money':
			return ENTITY_ICONS.datatype.money;
		case 'numeric':
		case 'number':
		case 'integer':
			return ENTITY_ICONS.datatype.numeric;
		case 'timestamp':
		case 'timestamptz':
		case 'tstzrange':
			return ENTITY_ICONS.datatype.timestamptz;
		case 'uuid':
			return ENTITY_ICONS.datatype.uuid;
		case 'text':
		case 'string':
		case 'phone':
			return ENTITY_ICONS.datatype.text;
		default:
			return ENTITY_ICONS.ui.variable;
	}
}

export function collectionFilterFieldTree(
	filterFields: readonly CollectionFilterField[]
): readonly BaseTreeItem<CollectionFilterField | null>[] {
	const directFields: CollectionFilterField[] = [];
	const systemFields: CollectionFilterField[] = [];
	const relationshipBranches = new Map<string, CollectionFilterRelationshipBranch>();

	for (const filterField of filterFields) {
		const { field, relation } = filterField;
		if (relation) {
			const branch = relationshipBranches.get(relation.name) ?? {
				name: relation.name,
				target: relation.target,
				cardinality: relation.cardinality,
				linkedFields: [],
				relatedFields: []
			};
			branch.target = relation.target;
			branch.cardinality = relation.cardinality;
			branch.relatedFields.push(filterField);
			relationshipBranches.set(relation.name, branch);
			continue;
		}

		if (field.relation) {
			const branch = relationshipBranches.get(field.relation.name) ?? {
				name: field.relation.name,
				target: field.relation.target,
				cardinality: field.array ? 'many' : 'one',
				linkedFields: [],
				relatedFields: []
			};
			branch.linkedFields.push(filterField);
			relationshipBranches.set(field.relation.name, branch);
			continue;
		}

		if (isSystemColumnName(field.name)) systemFields.push(filterField);
		else directFields.push(filterField);
	}

	const targetCounts = new Map<string, number>();
	for (const branch of relationshipBranches.values()) {
		targetCounts.set(branch.target, (targetCounts.get(branch.target) ?? 0) + 1);
	}

	const toLeaf = (
		filterField: CollectionFilterField
	): BaseTreeItem<CollectionFilterField | null> => {
		const { value, field, relation } = filterField;
		const title = field.label ?? humanize(field.name);
		return {
			id: value,
			title,
			icon: collectionFilterFieldIcon(field),
			searchText: `${title} ${field.name} ${field.kind} ${field.relation?.name ?? ''} ${field.relation?.target ?? ''} ${relation?.name ?? ''} ${relation?.target ?? ''}`,
			metadata: filterField
		};
	};

	const relationshipItems = [...relationshipBranches.values()]
		.map((branch): BaseTreeItem<CollectionFilterField | null> => {
			const linkedTitle =
				branch.linkedFields[0]?.field.label ??
				(branch.linkedFields[0] ? humanize(branch.linkedFields[0].field.name) : null);
			const titleFromLink = linkedTitle?.replace(/\s+id$/i, '').trim();
			const title =
				titleFromLink ||
				((targetCounts.get(branch.target) ?? 0) > 1
					? humanize(branch.name)
					: humanize(branch.target));
			const relatedFields = [...branch.relatedFields].sort((left, right) =>
				(left.field.label ?? humanize(left.field.name)).localeCompare(
					right.field.label ?? humanize(right.field.name)
				)
			);
			return {
				id: `__relationship:${branch.name}`,
				title,
				icon: ENTITY_ICONS.datatype.relationship,
				searchText: `${title} ${branch.name} ${branch.target} ${branch.cardinality}`,
				metadata: null,
				children: [...branch.linkedFields.map(toLeaf), ...relatedFields.map(toLeaf)]
			};
		})
		.sort((left, right) => left.title.localeCompare(right.title));

	const directItems = [...directFields]
		.sort((left, right) =>
			(left.field.label ?? humanize(left.field.name)).localeCompare(
				right.field.label ?? humanize(right.field.name)
			)
		)
		.map(toLeaf);
	const systemItems = [...systemFields]
		.sort((left, right) =>
			(left.field.label ?? humanize(left.field.name)).localeCompare(
				right.field.label ?? humanize(right.field.name)
			)
		)
		.map(toLeaf);

	return [
		{
			id: '__filter-fields',
			title: 'Filter fields',
			icon: ENTITY_ICONS.ui.filter,
			metadata: null,
			children: [
				...directItems,
				...relationshipItems,
				...(systemItems.length > 0
					? [
							{
								id: '__system-fields',
								title: 'System fields',
								icon: ENTITY_ICONS.ui.settings,
								searchText: 'System fields system sys',
								metadata: null,
								children: systemItems
							} satisfies BaseTreeItem<CollectionFilterField | null>
						]
					: [])
			]
		}
	];
}

export function collectionFilterFields(
	definition: FilterCollectionDefinition,
	collections: Readonly<Record<string, FilterCollectionDefinition>>
): readonly CollectionFilterField[] {
	const direct = definition.fields.map((field) => ({ value: field.name, field }));
	const related = (definition.relationships ?? []).flatMap((relation) => {
		const target = collections[relation.target];
		if (!target) return [];
		return target.fields.map((field) => ({
			value: `${relation.name}.${field.name}`,
			field,
			relation
		}));
	});
	return [...direct, ...related];
}

export function collectionFilterClause(
	filterField: CollectionFilterField,
	operator: CollectionFilter['operator'],
	operand: unknown
): CollectionFilter {
	const wireOperand =
		operator === 'contains_date' && typeof operand === 'string'
			? (calendarDateToInstant(operand) ?? operand)
			: operand;
	return {
		path: filterField.relation
			? [filterField.relation.name, filterField.field.name]
			: [filterField.field.name],
		operator,
		operand: wireOperand
	};
}
