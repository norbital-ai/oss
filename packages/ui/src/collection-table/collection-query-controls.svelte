<script lang="ts">
	import {
		COLLECTION_SEARCH_MAX_LENGTH,
		type CollectionFilter
	} from '@norbital-ai/platform-utils/collection';
	import Icon from '@iconify/svelte';
	import { debounce } from 'es-toolkit/function';
	import { onDestroy } from 'svelte';
	import { Button, buttonVariants } from '#lib/button';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Input } from '#lib/input';
	import { Inline } from '#lib/layout';
	import * as Popover from '#lib/popover';
	import { cn } from '#lib/utils';
	import CollectionTableFilter from './collection-table-filter.svelte';
	import type { FilterCollectionDefinition } from './collection-table-filter-fields.js';
	import type { CollectionTableInitialFilter } from './collection-table.types.js';

	const { t } = useI18n<UiKeys>();

	let {
		definition,
		collections,
		disabled = false,
		searchEnabled = true,
		filterEnabled = true,
		initialSearch = '',
		initialFilters = [],
		filterPersistenceKey,
		searchPlaceholder = t('table.searchTextFields'),
		align = 'start',
		onSearchChange,
		onFilterChange
	}: {
		definition: FilterCollectionDefinition;
		collections: Readonly<Record<string, FilterCollectionDefinition>>;
		disabled?: boolean;
		searchEnabled?: boolean;
		filterEnabled?: boolean;
		initialSearch?: string;
		/** Conditions the view opens with, seeded as removable rows in the filter builder. */
		initialFilters?: readonly CollectionTableInitialFilter[];
		/** View key a cleared seed is remembered against. */
		filterPersistenceKey?: string;
		searchPlaceholder?: string;
		align?: 'start' | 'center' | 'end';
		onSearchChange: (search: string) => void;
		onFilterChange: (filters: readonly CollectionFilter[]) => void;
	} = $props();

	// svelte-ignore state_referenced_locally -- the input owns its draft independently of query refreshes.
	let searchInput = $state(initialSearch);
	let searchInputElement: HTMLInputElement | null = $state(null);
	const searchActive = $derived(searchInput.trim().length > 0);
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
	<Popover.Root>
		<Popover.Trigger
			class={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), searchActive && 'bg-accent')}
			aria-label={t('table.searchRecords')}
			aria-pressed={searchActive}
			{disabled}
		>
			<Icon icon="lucide:search" class="size-4" />
		</Popover.Trigger>
		<Popover.Content
			{align}
			class="w-[min(24rem,calc(100vw-1rem))] p-2"
			onOpenAutoFocus={(event) => {
				event.preventDefault();
				searchInputElement?.focus();
			}}
		>
			<Inline gap="sm">
				<Input
					bind:ref={searchInputElement}
					type="search"
					class="h-9 text-base md:text-sm"
					value={searchInput}
					maxlength={COLLECTION_SEARCH_MAX_LENGTH}
					placeholder={searchPlaceholder}
					oninput={updateSearch}
					{disabled}
				/>
				{#if searchInput}
					<Button type="button" variant="ghost" size="sm" class="h-9 shrink-0" onclick={clearSearch}
						>{t('common.clear')}</Button
					>
				{/if}
			</Inline>
		</Popover.Content>
	</Popover.Root>
{/if}
{#if filterEnabled}
	<CollectionTableFilter
		{definition}
		{collections}
		{disabled}
		{initialFilters}
		persistenceKey={filterPersistenceKey}
		onChange={onFilterChange}
	/>
{/if}
