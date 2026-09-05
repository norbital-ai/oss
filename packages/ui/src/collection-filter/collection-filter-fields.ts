import type {
	CollectionField,
	CollectionFilter,
	CollectionRelationship
} from '@norbital-ai/std/collection';
import { Schema } from 'effect';
import { humanize } from '@norbital-ai/std/string';
import { isSystemCollectionField } from '@norbital-ai/std/collection';
import { ENTITY_ICONS } from '#lib/icon-wrapper/entity-icons';
import type { BaseTreeItem } from '#lib/tree-select';
import { calendarDateToInstant } from '#lib/data-renderer/time_stamp/date.utils';
import type { Translate } from '#lib/data-renderer';
import {
	collectionFilterFields,
	type CollectionFilterField,
	type FilterCollectionDefinition
} from './collection-filter-paths';
export {
	collectionFilterFields,
	type CollectionFilterField,
	type FilterCollectionDefinition
} from './collection-filter-paths';

interface RelationshipBranchNode {
	readonly key: string;
	readonly relation: CollectionRelationship;
	readonly fields: CollectionFilterField[];
	readonly children: Map<string, RelationshipBranchNode>;
}

const isString = Schema.is(Schema.String);

function collectionFilterFieldIcon(field: CollectionField): string {
	switch (field.kind) {
		case 'boolean':
			return ENTITY_ICONS.datatype.bool;
		case 'instant':
			return field.precision === 'day' ? ENTITY_ICONS.ui.calendar : ENTITY_ICONS.datatype.instant;
		case 'instant_range':
			return ENTITY_ICONS.datatype['instant_range'];
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

function filterLeaf(
	filterField: CollectionFilterField
): BaseTreeItem<CollectionFilterField | null> {
	const { value, field, path, lookupTarget } = filterField;
	const title = field.label ?? humanize(field.name);
	return {
		id: value,
		title,
		icon: lookupTarget ? ENTITY_ICONS.datatype.relationship : collectionFilterFieldIcon(field),
		searchText: `${title} ${path.join(' ')} ${field.kind} ${lookupTarget ?? ''}`,
		metadata: filterField
	};
}

function relationshipTree(
	node: RelationshipBranchNode
): BaseTreeItem<CollectionFilterField | null> {
	const linked = node.fields.find(
		(filterField) => filterField.field.relation?.name === node.relation.name
	);
	const title = linked?.field.label?.replace(/\s+id$/i, '').trim() || humanize(node.relation.name);
	return {
		id: `__relationship:${node.key}`,
		title,
		icon: ENTITY_ICONS.datatype.relationship,
		searchText: `${title} ${node.relation.name} ${node.relation.target} ${node.relation.cardinality}`,
		metadata: null,
		children: [
			...[...node.fields]
				.sort((left, right) =>
					(left.field.label ?? humanize(left.field.name)).localeCompare(
						right.field.label ?? humanize(right.field.name)
					)
				)
				.map(filterLeaf),
			...[...node.children.values()]
				.sort((left, right) => left.key.localeCompare(right.key))
				.map(relationshipTree)
		]
	};
}

export function collectionFilterFieldTree(
	filterFields: readonly CollectionFilterField[],
	t?: Translate
): readonly BaseTreeItem<CollectionFilterField | null>[] {
	const directFields: CollectionFilterField[] = [];
	const systemFields: CollectionFilterField[] = [];
	const relationshipBranches = new Map<string, RelationshipBranchNode>();

	for (const filterField of filterFields) {
		if (filterField.branch.length === 0) {
			if (isSystemCollectionField(filterField.field.name)) systemFields.push(filterField);
			else directFields.push(filterField);
			continue;
		}

		let siblings = relationshipBranches;
		let node: RelationshipBranchNode | undefined;
		const path: string[] = [];
		for (const relation of filterField.branch) {
			path.push(relation.name);
			const key = path.join('.');
			node = siblings.get(relation.name) ?? {
				key,
				relation,
				fields: [],
				children: new Map<string, RelationshipBranchNode>()
			};
			siblings.set(relation.name, node);
			siblings = node.children;
		}
		node?.fields.push(filterField);
	}

	const byLabel = (left: CollectionFilterField, right: CollectionFilterField): number =>
		(left.field.label ?? humanize(left.field.name)).localeCompare(
			right.field.label ?? humanize(right.field.name)
		);
	const systemItems = [...systemFields].sort(byLabel).map(filterLeaf);

	return [
		{
			id: '__filter-fields',
			title: t ? t('table.filterFields') : 'Filter fields',
			icon: ENTITY_ICONS.ui.filter,
			metadata: null,
			children: [
				...[...directFields].sort(byLabel).map(filterLeaf),
				...[...relationshipBranches.values()]
					.sort((left, right) => left.key.localeCompare(right.key))
					.map(relationshipTree),
				...(systemItems.length > 0
					? [
							{
								id: '__system-fields',
								title: t ? t('table.systemFields') : 'System fields',
								icon: ENTITY_ICONS.ui.settings,
								searchText: t ? t('table.systemFields') : 'System fields system sys',
								metadata: null,
								children: systemItems
							} satisfies BaseTreeItem<CollectionFilterField | null>
						]
					: [])
			]
		}
	];
}

export function collectionFilterClause(
	filterField: CollectionFilterField,
	operator: CollectionFilter['operator'],
	operand: unknown
): CollectionFilter {
	const wireOperand =
		operator === 'contains_date' && isString(operand)
			? (calendarDateToInstant(operand) ?? operand)
			: operand;
	return { path: filterField.path, operator, operand: wireOperand };
}
