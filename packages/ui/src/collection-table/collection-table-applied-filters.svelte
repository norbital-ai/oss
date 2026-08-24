<script lang="ts">
	import type { CollectionField } from '@norbital-ai/std/collection';
	import Icon from '@iconify/svelte';
	import { DataRenderer } from '#lib/data-renderer';
	import RelationshipRenderer from '../data-renderer/relationship/relationship.renderer.svelte';
	import { Inline, Stack } from '#lib/layout';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import {
		collectionAppliedFilterConditions,
		type CollectionAppliedFilterCondition
	} from '#lib/collection-table/collection-table-applied-filters';
	import {
		relationLabelOptions,
		type FilterCollectionDefinition
	} from '#lib/collection-table/collection-table-filter-fields';

	let {
		where,
		definition,
		collections
	}: {
		where: unknown;
		definition: FilterCollectionDefinition;
		collections: Readonly<Record<string, FilterCollectionDefinition>>;
	} = $props();

	const { t } = useI18n<UiKeys>();
	const conditions = $derived(collectionAppliedFilterConditions(where, definition, collections));
	const VALUE_TOKEN = '__norbital_filter_value__';

	function valueField(condition: CollectionAppliedFilterCondition): CollectionField {
		if (condition.operator === 'contains_date') {
			return { name: condition.field.name, kind: 'instant', nullable: false, precision: 'day' };
		}
		return { ...condition.field, array: false };
	}

	function displayOperand(condition: CollectionAppliedFilterCondition): unknown {
		return condition.operator === 'ilike' && typeof condition.operand === 'string'
			? condition.operand.replace(/^%|%$/g, '')
			: condition.operand;
	}

	function message(condition: CollectionAppliedFilterCondition): string {
		let rendered: string;
		switch (condition.operator) {
			case 'ilike':
			case 'contains_date':
			case 'arrayContains':
			case 'arrayOverlaps':
				rendered = t('table.filterContains', { label: condition.label, value: VALUE_TOKEN });
				break;
			case 'ne':
			case 'notIn':
				rendered = t('table.filterIsNot', { label: condition.label, value: VALUE_TOKEN });
				break;
			case 'gt':
				rendered = t('table.filterGreaterThan', { label: condition.label, value: VALUE_TOKEN });
				break;
			case 'gte':
				rendered = t('table.filterAtLeast', { label: condition.label, value: VALUE_TOKEN });
				break;
			case 'lt':
				rendered = t('table.filterLessThan', { label: condition.label, value: VALUE_TOKEN });
				break;
			case 'lte':
				rendered = t('table.filterAtMost', { label: condition.label, value: VALUE_TOKEN });
				break;
			case 'isNull':
				rendered = t('table.filterIsEmpty', { label: condition.label });
				break;
			case 'isNotNull':
				rendered = t('table.filterIsNotEmpty', { label: condition.label });
				break;
			default:
				rendered = t('table.filterIs', { label: condition.label, value: VALUE_TOKEN });
		}
		if (condition.negated) rendered = t('table.filterNot', { label: rendered });
		if (condition.alternative) {
			rendered = t('table.filterAnyOf', { values: rendered });
		}
		return rendered;
	}

	function messageParts(condition: CollectionAppliedFilterCondition): readonly [string, string] {
		const [before = '', after = ''] = message(condition).split(VALUE_TOKEN, 2);
		return [before, after];
	}
</script>

{#snippet conditionValue(condition: CollectionAppliedFilterCondition)}
	{#if condition.operator !== 'isNull' && condition.operator !== 'isNotNull'}
		{@const operand = displayOperand(condition)}
		{#if condition.lookupTarget}
			<RelationshipRenderer
				target={condition.lookupTarget}
				value={Array.isArray(condition.operand)
					? condition.operand.map(String)
					: condition.operand == null
						? null
						: String(condition.operand)}
				multiple={Array.isArray(condition.operand)}
				options={relationLabelOptions(collections[condition.lookupTarget], condition.lookupTarget)}
				displayOnly
				class="inline font-medium"
			/>
		{:else if Array.isArray(operand)}
			{#each operand as item, index}
				{#if index > 0},
				{/if}<DataRenderer
					field={valueField(condition)}
					value={item}
					mode="display"
					class="inline font-medium"
				/>
			{/each}
		{:else}
			<DataRenderer
				field={valueField(condition)}
				value={operand}
				mode="display"
				class="inline font-medium"
			/>
		{/if}
	{/if}
{/snippet}

<Stack as="ul" gap="xs">
	{#each conditions as condition (condition.key)}
		{@const parts = messageParts(condition)}
		<Inline as="li" align="start" gap="xs" class="min-w-0 text-xs">
			<Icon icon="lucide:filter" class="mt-0.5 size-3 shrink-0 opacity-70" />
			<span class="min-w-0 leading-5">
				{parts[0]}{@render conditionValue(condition)}{parts[1]}
			</span>
		</Inline>
	{/each}
</Stack>
