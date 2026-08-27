<script lang="ts">
	import {
		COLLECTION_SEARCH_MAX_LENGTH,
		isSearchableCollectionField,
		type CollectionFilter
	} from '@norbital-ai/std/collection';
	import { humanize } from '@norbital-ai/std/string';
	import Icon from '@iconify/svelte';
	import { debounce } from 'es-toolkit/function';
	import { onDestroy } from 'svelte';
	import { Button } from '#lib/button';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Indicator } from '#lib/indicator';
	import { Input } from '#lib/input';
	import { Inline } from '#lib/layout';
	import * as Popover from '#lib/popover';
	import {
		CollectionFilter as CollectionFilterBuilder,
		type FilterCollectionDefinition
	} from '#lib/collection-filter';
	import type { CollectionInitialFilter } from '#lib/collection-surface';

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
		onSearchChange,
		onFilterChange
	}: {
		definition: FilterCollectionDefinition;
		collections: Readonly<Record<string, FilterCollectionDefinition>>;
		disabled?: boolean;
		/** Caller opt-out. Searchability itself comes from the schema, never from this flag. */
		searchEnabled?: boolean;
		/** Caller opt-out for the schema-derived filter builder. */
		filterEnabled?: boolean;
		initialSearch?: string;
		/** Conditions the view opens with, seeded as removable rows in the filter builder. */
		initialFilters?: readonly CollectionInitialFilter[];
		/** View key a cleared seed is remembered against. */
		filterPersistenceKey?: string;
		onSearchChange: (search: string) => void;
		onFilterChange: (filters: readonly CollectionFilter[]) => void;
	} = $props();

	/**
	 * Free-text search matches exactly the fields the author opted in with `search: true`, so a
	 * collection that opted none in cannot match anything. Offering a box there is an inert control
	 * that returns nothing however it is typed into, so the affordance is not rendered at all.
	 */
	const searchableFields = $derived(definition.fields.filter(isSearchableCollectionField));
	const searchVisible = $derived(searchEnabled && searchableFields.length > 0);

	/** Beyond this the names stop being a hint and become a wall of text in a 16rem input. */
	const SEARCH_FIELDS_SHOWN = 3;
	/**
	 * Which columns the term is matched against, named in the box itself.
	 *
	 * There is no caller override. A hand-written placeholder ("Search leave requests…") names the
	 * collection rather than the searchable columns, so an operator who types an employee number
	 * they can see in the table gets nothing back and no explanation — the exact confusion naming
	 * the columns exists to prevent. Only the schema knows which fields opted in, so only the schema
	 * writes this line.
	 */
	const placeholder = $derived.by(() => {
		const labels = searchableFields.map((field) => field.label ?? humanize(field.name));
		const shown = labels.slice(0, SEARCH_FIELDS_SHOWN).join(', ');
		const overflow = labels.length - SEARCH_FIELDS_SHOWN;
		return t('table.searchIn', {
			fields:
				overflow > 0 ? t('table.searchFieldsOverflow', { fields: shown, count: overflow }) : shown
		});
	});

	// svelte-ignore state_referenced_locally -- the input owns its draft independently of query refreshes.
	let searchInput = $state(initialSearch);
	let searchInputElement: HTMLInputElement | null = $state(null);
	const commitSearch = debounce((value: string) => {
		onSearchChange(value.trim().normalize('NFC'));
	}, 180);

	// A collapsed popover hides the term, so the trigger has to carry it: without this an active
	// search reads as an unfiltered collection whose row count is inexplicably short.
	const searchActive = $derived(searchInput.trim().length > 0);

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

{#if searchVisible}
	<Popover.Root>
		<Popover.Trigger>
			{#snippet child({ props })}
				<Indicator visible={searchActive} variant="info" size="sm">
					<Button
						{...props}
						type="button"
						variant="ghost"
						size="icon"
						class="size-8"
						aria-label={searchActive ? t('table.searchActive') : t('table.searchRecords')}
						aria-pressed={searchActive}
						{disabled}
					>
						<Icon icon="lucide:search" class="size-4" />
					</Button>
				</Indicator>
			{/snippet}
		</Popover.Trigger>
		<Popover.Content align="start" class="w-[min(calc(100vw-1rem),20rem)] p-2">
			<Inline gap="sm">
				<Input
					bind:ref={searchInputElement}
					type="search"
					class="h-9 min-w-0 flex-1 text-base md:text-sm"
					value={searchInput}
					maxlength={COLLECTION_SEARCH_MAX_LENGTH}
					{placeholder}
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
		</Popover.Content>
	</Popover.Root>
{/if}
{#if filterEnabled}
	<CollectionFilterBuilder
		{definition}
		{collections}
		{disabled}
		{initialFilters}
		persistenceKey={filterPersistenceKey}
		onChange={onFilterChange}
	/>
{/if}
