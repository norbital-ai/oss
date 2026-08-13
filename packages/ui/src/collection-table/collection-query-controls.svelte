<script lang="ts">
	import {
		COLLECTION_SEARCH_MAX_LENGTH,
		type CollectionFilter
	} from '@norbital-ai/platform-utils/collection';
	import { debounce } from 'es-toolkit/function';
	import { onDestroy } from 'svelte';
	import { Button } from '#lib/button';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Input } from '#lib/input';
	import { Inline } from '#lib/layout';
	import CollectionTableFilter from './collection-table-filter.svelte';
	import type { FilterCollectionDefinition } from './collection-table-filter-fields.js';
	import type { CollectionTableInitialFilter } from './collection-table.types.js';
	import type { CollectionToolbarFilterDeclaration } from '../collection-toolbar/collection-toolbar.types.js';

	const { t } = useI18n<UiKeys>();

	let {
		definition,
		collections,
		disabled = false,
		searchEnabled = true,
		filterEnabled = true,
		customFilters = [],
		initialSearch = '',
		initialFilters = [],
		filterPersistenceKey,
		searchPlaceholder = t('table.searchTextFields'),
		onSearchChange,
		onFilterChange,
		onCustomFilterChange
	}: {
		definition: FilterCollectionDefinition;
		collections: Readonly<Record<string, FilterCollectionDefinition>>;
		disabled?: boolean;
		searchEnabled?: boolean;
		/** The schema-derived filter builder; declared controls are unaffected by it. */
		filterEnabled?: boolean;
		/** Controls for predicates the collection has no field for, declared by the surface. */
		customFilters?: readonly CollectionToolbarFilterDeclaration[];
		initialSearch?: string;
		/** Conditions the view opens with, seeded as removable rows in the filter builder. */
		initialFilters?: readonly CollectionTableInitialFilter[];
		/** View key a cleared seed is remembered against. */
		filterPersistenceKey?: string;
		searchPlaceholder?: string;
		onSearchChange: (search: string) => void;
		onFilterChange: (filters: readonly CollectionFilter[]) => void;
		onCustomFilterChange?: () => void;
	} = $props();

	// svelte-ignore state_referenced_locally -- the input owns its draft independently of query refreshes.
	let searchInput = $state(initialSearch);
	let searchInputElement: HTMLInputElement | null = $state(null);
	const commitSearch = debounce((value: string) => {
		onSearchChange(value.trim().normalize('NFC'));
	}, 180);

	onDestroy(() => commitSearch.cancel());

	function updateSearch(event: Event & { currentTarget: HTMLInputElement }): void {
		searchInput = event.currentTarget.value;
		commitSearch(searchInput);
	}

	function clearSearch(): void {
		searchInput = '';
		commitSearch('');
		searchInputElement?.focus();
	}
</script>

{#if searchEnabled}
	<Inline gap="sm">
		<Input
			bind:ref={searchInputElement}
			type="search"
			class="h-9 w-[min(16rem,40vw)] min-w-0 text-base md:text-sm"
			value={searchInput}
			maxlength={COLLECTION_SEARCH_MAX_LENGTH}
			placeholder={searchPlaceholder}
			aria-label={t('table.searchRecords')}
			oninput={updateSearch}
			{disabled}
		/>
		{#if searchInput}
			<Button type="button" variant="ghost" size="sm" class="h-9 shrink-0" onclick={clearSearch}
				>{t('common.clear')}</Button
			>
		{/if}
	</Inline>
{/if}
{#if filterEnabled || customFilters.length > 0}
	<CollectionTableFilter
		{definition}
		{collections}
		{disabled}
		builderEnabled={filterEnabled}
		{customFilters}
		{initialFilters}
		persistenceKey={filterPersistenceKey}
		onChange={onFilterChange}
		{onCustomFilterChange}
	/>
{/if}
