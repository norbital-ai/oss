<script lang="ts">
	import type { CollectionFilter } from '@norbital-ai/platform-utils/collection';
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { Combobox } from '#lib/combobox';
	import { DataRenderer } from '../data-renderer/index.js';
	import { Indicator } from '#lib/indicator';
	import { Inline, Scroll, Stack } from '#lib/layout';
	import * as Popover from '#lib/popover';
	import { TreeCombobox } from '#lib/tree-combobox';
	import {
		collectionFilterClause,
		collectionFilterFieldTree,
		collectionFilterFields,
		type CollectionFilterField,
		type FilterCollectionDefinition
	} from './collection-table-filter-fields.js';
	import {
		collectionFilterOperandField,
		collectionFilterOperatorNeedsValue,
		collectionFilterOperatorOptions,
		collectionFilterQueryOperator,
		type CollectionFilterOperator
	} from './collection-table-filter-operators.js';

	type Filter = {
		id: number;
		field: string | null;
		operator: CollectionFilterOperator | null;
		value: unknown;
	};
	let {
		definition,
		collections,
		disabled = false,
		onChange
	}: {
		definition: FilterCollectionDefinition;
		collections: Readonly<Record<string, FilterCollectionDefinition>>;
		disabled?: boolean;
		onChange: (filters: readonly CollectionFilter[]) => void;
	} = $props();

	let filters = $state<Filter[]>([]);
	let nextId = $state(0);
	const filterFields = $derived(collectionFilterFields(definition, collections));
	const fieldTree = $derived(collectionFilterFieldTree(filterFields));
	const activeCount = $derived(filters.filter(filterIsActive).length);

	function selectedField(filter: Filter): CollectionFilterField | undefined {
		return filterFields.find((field) => field.value === filter.field);
	}

	function filterIsActive(filter: Filter): boolean {
		if (!filter.field || !filter.operator) return false;
		if (!collectionFilterOperatorNeedsValue(filter.operator)) return true;
		if (filter.value == null) return false;
		if (typeof filter.value === 'string') return filter.value.trim().length > 0;
		if (Array.isArray(filter.value)) return filter.value.length > 0;
		return true;
	}

	function publish(): void {
		const clauses = filters.flatMap((filter) => {
			if (!filterIsActive(filter)) return [];
			const field = selectedField(filter);
			if (!field || !filter.operator || !filter.field) return [];
			const operator = collectionFilterQueryOperator(field.field, filter.operator);
			if (!collectionFilterOperatorNeedsValue(filter.operator)) {
				return [collectionFilterClause(field, operator, true)];
			}
			const operand = operator === 'ilike' ? `%${String(filter.value).trim()}%` : filter.value;
			return [collectionFilterClause(field, operator, operand)];
		});
		onChange(clauses);
	}

	function addFilter(): void {
		filters = [...filters, { id: nextId++, field: null, operator: null, value: undefined }];
	}

	function setField(id: number, fieldName: string): void {
		const field = filterFields.find((candidate) => candidate.value === fieldName);
		if (!field) return;
		const operator = collectionFilterOperatorOptions(field.field)[0]?.value ?? null;
		filters = filters.map((filter) =>
			filter.id === id ? { ...filter, field: fieldName, operator, value: undefined } : filter
		);
		publish();
	}

	function setOperator(id: number, operator: CollectionFilterOperator): void {
		filters = filters.map((filter) =>
			filter.id === id ? { ...filter, operator, value: undefined } : filter
		);
		publish();
	}

	function setValue(id: number, value: unknown): void {
		filters = filters.map((filter) => (filter.id === id ? { ...filter, value } : filter));
		publish();
	}

	function removeFilter(id: number): void {
		filters = filters.filter((filter) => filter.id !== id);
		publish();
	}

	function clear(): void {
		filters = [];
		publish();
	}
</script>

<Popover.Root>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Indicator visible={activeCount > 0} variant="info" size="sm">
				<Button
					{...props}
					type="button"
					variant="ghost"
					size="icon"
					class="size-8"
					aria-label={activeCount > 0 ? 'Filters active' : 'Filter records'}
					aria-pressed={activeCount > 0}
					{disabled}
				>
					<Icon icon="lucide:list-filter" class="size-4" />
				</Button>
			</Indicator>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content align="start" class="w-[min(calc(100vw-1rem),42rem)] max-w-full p-0">
		<Inline justify="between" gap="sm" class="border-b px-3 py-2">
			<Stack gap="none">
				<p class="text-xs font-medium">Filters</p>
				<p class="text-micro text-muted-foreground">All conditions must match.</p>
			</Stack>
			{#if filters.length > 0}<Button
					type="button"
					variant="ghost"
					size="sm"
					class="h-7 text-xs"
					onclick={clear}>Clear all</Button
				>{/if}
		</Inline>
		<Scroll axis="y" name="Applied filters" class="max-h-80 min-w-0 p-3">
			<Stack gap="xs">
				{#if filters.length === 0}
					<p class="py-2 text-center text-xs text-muted-foreground">No filters applied.</p>
				{/if}
				{#each filters as filter (filter.id)}
					{@const field = selectedField(filter)}
					{@const operatorOptions = field ? collectionFilterOperatorOptions(field.field) : []}
					<!-- stupidity:allow UI6 -- filter-builder row grid needs explicit responsive tracks and placements the auto-fit Grid cannot express -->
					<div
						class="grid min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center gap-2 sm:grid-cols-[repeat(3,minmax(0,1fr))_2rem]"
					>
						<div class="col-start-1 min-w-0 w-full sm:col-auto">
							<TreeCombobox
								rootItems={fieldTree}
								value={filter.field ?? undefined}
								placeholder="Choose a field"
								searchPlaceholder="Search fields…"
								ariaLabel="Choose a filter field"
								allowCleared={false}
								{disabled}
								onValueChange={(nextField) => nextField && setField(filter.id, nextField)}
							/>
						</div>
						{#if field}
							<Combobox
								options={[...operatorOptions]}
								value={filter.operator}
								searchable={false}
								class="col-start-1 h-8 min-w-0 w-full text-xs sm:col-auto"
								onValueChange={(operator) => operator && setOperator(filter.id, operator)}
							/>
						{:else}
							<span class="col-start-1 min-w-0 px-2 text-xs text-muted-foreground sm:col-auto"
								>Choose a field</span
							>
						{/if}
						{#if field && filter.operator && collectionFilterOperatorNeedsValue(filter.operator)}
							{#key `${field.value}:${filter.operator}`}
								<DataRenderer
									field={collectionFilterOperandField(field.field, filter.operator)}
									value={filter.value}
									mode="edit"
									class="col-start-1 h-8 min-w-0 w-full text-xs sm:col-auto"
									onValueChange={(value) => setValue(filter.id, value)}
								/>
							{/key}
						{:else}
							<span class="col-start-1 min-w-0 px-2 text-xs text-muted-foreground sm:col-auto">
								{field && filter.operator ? 'No value needed' : 'Choose an operator'}
							</span>
						{/if}
						<Button
							type="button"
							variant="ghost"
							size="icon"
							class="col-start-2 row-start-1 size-8 sm:col-start-4"
							aria-label="Remove filter"
							onclick={() => removeFilter(filter.id)}
							><Icon icon="lucide:x" class="size-3.5" /></Button
						>
					</div>
				{/each}
			</Stack>
		</Scroll>
		<footer class="border-t p-2">
			<Button
				type="button"
				variant="ghost"
				size="sm"
				class="h-7 gap-1.5 text-xs"
				disabled={filterFields.length === 0}
				onclick={addFilter}><Icon icon="lucide:plus" class="size-3.5" /> Add filter</Button
			>
		</footer>
	</Popover.Content>
</Popover.Root>
