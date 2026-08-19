<script lang="ts">
	import type {
		CollectionFilter,
		CollectionRecord,
		CollectionRelationOptions
	} from '@norbital-ai/std/collection';
	import { resolveRecordLabel } from '@norbital-ai/std/collection';
	import { humanize } from '@norbital-ai/std/string';
	import Icon from '@iconify/svelte';
	import { PersistedState } from 'runed';
	import { Button } from '#lib/button';
	import { Combobox } from '#lib/combobox';
	import { DataRenderer } from '../data-renderer/index.js';
	import RelationshipRenderer from '../data-renderer/relationship/relationship.renderer.svelte';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Indicator } from '#lib/indicator';
	import { Inline, Scroll, Stack } from '#lib/layout';
	import * as Popover from '#lib/popover';
	import { TreeCombobox } from '#lib/tree-combobox';
	import { cn } from '#lib/utils';
	import {
		collectionFilterClause,
		collectionFilterFieldTree,
		collectionFilterFields,
		type CollectionFilterField,
		type FilterCollectionDefinition
	} from './collection-table-filter-fields.js';
	import { type Translate } from '../data-renderer/index.js';
	import {
		collectionFilterOperandField,
		collectionFilterOperatorNeedsValue,
		collectionFilterOperatorOptions,
		collectionFilterQueryOperator,
		type CollectionFilterOperator
	} from './collection-table-filter-operators.js';
	import type { CollectionTableInitialFilter } from './collection-table.types.js';
	import type { CollectionToolbarFilterDeclaration } from '../collection-toolbar/collection-toolbar.types.js';

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
		builderEnabled = true,
		customFilters = [],
		initialFilters = [],
		persistenceKey,
		onChange,
		onCustomFilterChange
	}: {
		definition: FilterCollectionDefinition;
		collections: Readonly<Record<string, FilterCollectionDefinition>>;
		disabled?: boolean;
		/**
		 * The schema-derived builder. A surface whose conditions are all derived turns it off and
		 * still gets this popover for its declared controls.
		 */
		builderEnabled?: boolean;
		/** Controls for predicates the collection has no field for, declared by the surface. */
		customFilters?: readonly CollectionToolbarFilterDeclaration[];
		/** Conditions this view opens with, seeded as ordinary removable rows. */
		initialFilters?: readonly CollectionTableInitialFilter[];
		/** View key the "operator cleared the seed" decision is remembered against. */
		persistenceKey?: string;
		onChange: (filters: readonly CollectionFilter[]) => void;
		/** Fired after a declared control changes, so the surface can drop back to the first page. */
		onCustomFilterChange?: () => void;
	} = $props();

	const { t } = useI18n<UiKeys>();

	let filters = $state<Filter[]>([]);
	let nextId = $state(0);
	const filterFields = $derived(collectionFilterFields(definition, collections));
	const fieldTree = $derived(collectionFilterFieldTree(filterFields, t as Translate));
	// One count for both kinds. A derived predicate narrows the set exactly as a field condition
	// does, so leaving it out of the badge would let an operator stare at a filtered board that
	// claims to be unfiltered.
	const activeCustomCount = $derived(customFilters.filter((filter) => filter.value != null).length);
	const activeCount = $derived(filters.filter(filterIsActive).length + activeCustomCount);
	const builderRows = $derived(builderEnabled ? filters : []);

	/**
	 * The seed, and whether this operator has already thrown it away.
	 *
	 * Interactive filters are deliberately not persisted — every mount starts from an empty builder —
	 * so a seed would otherwise reappear on each reload no matter how many times it was dismissed.
	 * What *is* remembered is the signature of the seed the operator cleared. Comparing signatures
	 * rather than storing a bare boolean means an author who later changes the default gets it
	 * applied again, instead of it staying invisible forever because of a decision taken about a
	 * different condition.
	 */
	const seedSignature = $derived(
		initialFilters.length === 0
			? null
			: JSON.stringify(
					initialFilters.map((seed) => [seed.field, seed.operator, seed.value ?? null])
				)
	);
	// svelte-ignore state_referenced_locally -- the view a builder belongs to is fixed for its lifetime.
	const clearedSeed = new PersistedState<string | null>(
		`${persistenceKey ?? 'unkeyed'}.filterSeed.cleared`,
		null
	);
	/** Rows that arrived from the seed, so clearing one can be told apart from clearing your own. */
	let seededIds = $state(new Set<number>());
	let seedSettled = false;

	$effect(() => {
		if (seedSettled) return;
		if (!builderEnabled) return;
		if (seedSignature === null) return;
		// The field picker is derived from the collection definition, which may not have arrived yet;
		// seeding against an empty field list would silently drop every row.
		if (filterFields.length === 0) return;
		if (clearedSeed.current === seedSignature) {
			seedSettled = true;
			return;
		}
		const seeded = initialFilters.flatMap((seed) => {
			if (!filterFields.some((field) => field.value === seed.field)) return [];
			return [{ id: nextId++, field: seed.field, operator: seed.operator, value: seed.value }];
		});
		seedSettled = true;
		if (seeded.length === 0) return;
		seededIds = new Set(seeded.map((row) => row.id));
		filters = seeded;
		publish();
	});

	function markSeedCleared(): void {
		if (seedSignature !== null) clearedSeed.current = seedSignature;
	}

	function selectedField(filter: Filter): CollectionFilterField | undefined {
		return filterFields.find((field) => field.value === filter.field);
	}

	/** Record keys need the target collection's record-label contract, not a UUID text input. */
	function lookupTarget(field: CollectionFilterField): string | undefined {
		if (field.field.relation) return field.field.relation.target;
		if (field.field.name === 'norbital_id') return field.relation?.target ?? definition.name;
		return undefined;
	}

	function relationOptions(targetName: string): CollectionRelationOptions {
		const target = collections[targetName];
		return {
			label: (record: CollectionRecord) =>
				resolveRecordLabel(target?.recordLabel ?? null, record) ?? humanize(targetName)
		};
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
		if (seededIds.has(id)) markSeedCleared();
		filters = filters.filter((filter) => filter.id !== id);
		publish();
	}

	function clear(): void {
		if (filters.some((filter) => seededIds.has(filter.id))) markSeedCleared();
		filters = [];
		publish();
		clearCustomFilters();
	}

	function clearCustomFilters(): void {
		let cleared = false;
		for (const filter of customFilters) {
			if (filter.value == null) continue;
			filter.change(null);
			cleared = true;
		}
		if (cleared) onCustomFilterChange?.();
	}

	function setCustomFilter(filter: CollectionToolbarFilterDeclaration, value: unknown): void {
		filter.change(typeof value === 'string' && value.length > 0 ? value : null);
		onCustomFilterChange?.();
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
					aria-label={activeCount > 0 ? t('table.filterActive') : t('table.filterRecords')}
					aria-pressed={activeCount > 0}
					{disabled}
				>
					<Icon icon="lucide:list-filter" class="size-4" />
				</Button>
			</Indicator>
		{/snippet}
	</Popover.Trigger>
	<!-- The builder needs three columns of controls per row; declared controls are one each. -->
	<Popover.Content
		align="start"
		class={cn(
			'max-w-full p-0',
			builderEnabled ? 'w-[min(calc(100vw-1rem),42rem)]' : 'w-[min(calc(100vw-1rem),22rem)]'
		)}
	>
		<Inline justify="between" gap="sm" class="border-b px-3 py-2">
			<Stack gap="none">
				<p class="text-xs font-medium">{t('table.filters')}</p>
				<p class="text-micro text-muted-foreground">{t('table.filtersAllMatch')}</p>
			</Stack>
			{#if filters.length > 0 || activeCustomCount > 0}<Button
					type="button"
					variant="ghost"
					size="sm"
					class="h-7 text-xs"
					onclick={clear}>{t('table.clearAll')}</Button
				>{/if}
		</Inline>
		<Scroll axis="y" name={t('table.appliedFilters')} class="max-h-80 min-w-0 p-3">
			<Stack gap="xs">
				{#each customFilters as customFilter (customFilter.id)}
					<label class="grid gap-1.5 text-sm">
						<span class="font-medium text-muted-foreground">{customFilter.label}</span>
						<Combobox
							ariaLabel={customFilter.label}
							options={[...customFilter.options]}
							value={customFilter.value}
							allowClear
							searchable={customFilter.searchable ?? customFilter.options.length > 8}
							emptyPlaceholder={customFilter.placeholder}
							searchPlaceholder={customFilter.searchPlaceholder}
							{disabled}
							onValueChange={(value) => setCustomFilter(customFilter, value)}
						/>
					</label>
				{/each}
				{#if builderEnabled && filters.length === 0}
					<p class="py-2 text-center text-meta">
						{t('table.noFiltersApplied')}
					</p>
				{/if}
				{#each builderRows as filter (filter.id)}
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
								placeholder={t('table.chooseField')}
								searchPlaceholder={t('table.searchFields')}
								ariaLabel={t('table.chooseFilterField')}
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
							<span class="col-start-1 min-w-0 px-2 text-meta sm:col-auto"
								>{t('table.chooseField')}</span
							>
						{/if}
						{#if field && filter.operator && collectionFilterOperatorNeedsValue(filter.operator)}
							{@const target = lookupTarget(field)}
							{#key `${field.value}:${filter.operator}`}
								{#if target}
									<RelationshipRenderer
										{target}
										value={typeof filter.value === 'string' ? filter.value : null}
										options={relationOptions(target)}
										class="col-start-1 h-8 min-w-0 w-full text-xs sm:col-auto"
										onValueChange={(value) => setValue(filter.id, value)}
									/>
								{:else}
									<DataRenderer
										field={collectionFilterOperandField(field.field, filter.operator)}
										value={filter.value}
										mode="edit"
										class="col-start-1 h-8 min-w-0 w-full text-xs sm:col-auto"
										onValueChange={(value) => setValue(filter.id, value)}
									/>
								{/if}
							{/key}
						{:else}
							<span class="col-start-1 min-w-0 px-2 text-meta sm:col-auto">
								{field && filter.operator ? t('table.noValueNeeded') : t('table.chooseOperator')}
							</span>
						{/if}
						<Button
							type="button"
							variant="ghost"
							size="icon"
							class="col-start-2 row-start-1 size-8 sm:col-start-4"
							aria-label={t('table.filterRemove')}
							onclick={() => removeFilter(filter.id)}
							><Icon icon="lucide:x" class="size-3.5" /></Button
						>
					</div>
				{/each}
			</Stack>
		</Scroll>
		{#if builderEnabled}
			<footer class="border-t p-2">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					class="h-7 gap-1.5 text-xs"
					disabled={filterFields.length === 0}
					onclick={addFilter}
					><Icon icon="lucide:plus" class="size-3.5" /> {t('table.filterAdd')}</Button
				>
			</footer>
		{/if}
	</Popover.Content>
</Popover.Root>
