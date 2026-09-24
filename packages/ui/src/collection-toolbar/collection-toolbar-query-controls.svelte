<script lang="ts">
	import {
		isSearchableCollectionField,
		type CollectionFilter,
		type CollectionSearch
	} from '@norbital-ai/std/collection';
	import { humanize } from '@norbital-ai/std/string';
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Indicator } from '#lib/indicator';
	import * as Popover from '#lib/popover';
	import CollectionSearchCommand from './collection-search-command.svelte';
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
		initialSearch = null,
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
		initialSearch?: CollectionSearch | null;
		/** Conditions the view opens with, seeded as removable rows in the filter builder. */
		initialFilters?: readonly CollectionInitialFilter[];
		/** View key a cleared seed is remembered against. */
		filterPersistenceKey?: string;
		/** The command the box captured; `null` when it holds nothing worth sending. */
		onSearchChange: (search: CollectionSearch | null) => void;
		onFilterChange: (filters: readonly CollectionFilter[]) => void;
	} = $props();

	/**
	 * Free-text search matches exactly the fields the author opted in with `search: true`, so a
	 * collection that opted none in cannot match anything. Offering a box there is an inert control
	 * that returns nothing however it is typed into, so the affordance is not rendered at all.
	 */
	const searchableFields = $derived(definition.fields.filter(isSearchableCollectionField));
	const similarity = $derived(definition.similarity ?? []);
	const semantic = $derived(definition.semantic === true);
	/** A collection with a similarity index is searchable through it even with no text field. */
	const searchVisible = $derived(
		searchEnabled && (searchableFields.length > 0 || semantic || similarity.length > 0)
	);

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

	// svelte-ignore state_referenced_locally -- the seed only opens the box; the box owns the draft.
	let searchActive = $state(initialSearch !== null);
	let modeLabel = $state<string | null>(null);
	let box: { active: () => boolean; modeLabel: () => string | null } | undefined = $state();
	const changed = (command: CollectionSearch | null): void => {
		searchActive = command !== null;
		modeLabel = box?.modeLabel() ?? null;
		onSearchChange(command);
	};
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
						aria-label={searchActive
							? `${t('table.searchActive')}${modeLabel === null ? '' : ` ${modeLabel}`}`
							: t('table.searchRecords')}
						aria-pressed={searchActive}
						{disabled}
					>
						<Icon icon="lucide:search" class="size-4" />
					</Button>
				</Indicator>
			{/snippet}
		</Popover.Trigger>
		<!-- Wide enough for a capture form on one line: a chip, two selectors, three numbers, Clear. -->
		<!-- repository-health:allow UI21 -- popover width on the bits-ui Popover.Content, which floating-ui measures for collision; Bound's sizes are heights and no primitive names a width, so a nested primitive would size the content but not the positioned box -->
		<Popover.Content align="start" class="w-[min(calc(100vw-1rem),46rem)] p-2">
			<CollectionSearchCommand
				bind:this={box}
				{placeholder}
				{semantic}
				{similarity}
				{collections}
				initial={initialSearch}
				{disabled}
				onChange={changed}
			/>
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
