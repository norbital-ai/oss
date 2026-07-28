<script lang="ts">
	import {
		COLLECTION_SEARCH_MAX_LENGTH,
		type CollectionFilter
	} from '@norbital-ai/platform-utils/collection';
	import Icon from '@iconify/svelte';
	import { debounce } from 'es-toolkit/function';
	import { onDestroy } from 'svelte';
	import { Button, buttonVariants } from '#lib/button';
	import { Input } from '#lib/input';
	import * as Popover from '#lib/popover';
	import { cn } from '#lib/utils';
	import CollectionTableFilter from './collection-table-filter.svelte';
	import type { FilterCollectionDefinition } from './collection-table-filter-fields.js';

	let {
		definition,
		collections,
		disabled = false,
		searchEnabled = true,
		filterEnabled = true,
		initialSearch = '',
		searchPlaceholder = 'Search text fields…',
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
			aria-label="Search records"
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
			<div class="flex items-center gap-2">
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
						>Clear</Button
					>
				{/if}
			</div>
		</Popover.Content>
	</Popover.Root>
{/if}
{#if filterEnabled}
	<CollectionTableFilter {definition} {collections} {disabled} onChange={onFilterChange} />
{/if}
