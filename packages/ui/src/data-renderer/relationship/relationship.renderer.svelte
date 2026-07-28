<script lang="ts">
	import type {
		CollectionRecord,
		CollectionRelationOptions,
		RemoteQuery
	} from '@norbital-ai/platform-utils/collection';
	import { humanize } from '@norbital-ai/std/string';
	import { Combobox } from '#lib/combobox';
	import { cn } from '#lib/utils';
	import { watch } from 'runed';
	import { getCollectionClientContext } from '#lib/collection-runtime';

	interface Props {
		target: string;
		value: string | string[] | null;
		multiple?: boolean;
		/**
		 * The option set: how an option reads, and which records are offered. Declared inline by
		 * the caller because it is contextual — the stored value is only the key that picks one out.
		 * Without it there is nothing to show but the id.
		 */
		options?: CollectionRelationOptions;
		/**
		 * Display text the caller already resolved for the current value. A collection table
		 * resolves all its relationship columns in one query and labels them per row, so cells pass
		 * this and issue nothing. A lone field passes nothing and this renderer resolves its own
		 * single value — one query for one field, not one per row.
		 */
		label?: string | string[] | null;
		placeholder?: string;
		disabled?: boolean;
		readonly?: boolean;
		displayOnly?: boolean;
		class?: string;
		onValueChange?: (value: string | string[] | null) => void;
	}

	let {
		target,
		value,
		multiple = false,
		options: relationOptions,
		label = null,
		placeholder = 'Select record…',
		disabled = false,
		readonly = false,
		displayOnly = false,
		class: className,
		onValueChange
	}: Props = $props();
	const records = getCollectionClientContext().records;

	const selectedIds = $derived(
		(Array.isArray(value) ? value : value ? [value] : []).filter((id) => id.length > 0)
	);
	let searchQuery = $state('');
	let activeFilters = $state<Record<string, string>>({});

	/** The option set, scoped by the caller's declaration plus whatever the picker has narrowed to. */
	const optionsQueryInput = $derived.by(() => {
		if (displayOnly) return null;
		const declaredWhere = (relationOptions?.where ?? {}) as Record<string, unknown>;
		const narrowed = Object.entries(activeFilters).filter(([, v]) => v !== '');
		return {
			records,
			target,
			query: {
				where: narrowed.length
					? { ...declaredWhere, ...Object.fromEntries(narrowed.map(([k, v]) => [k, { eq: v }])) }
					: declaredWhere,
				...(relationOptions?.orderBy ? { orderBy: relationOptions.orderBy } : {}),
				...(searchQuery.trim() ? { search: searchQuery.trim() } : {}),
				limit: relationOptions?.limit ?? 100
			}
		};
	});
	let optionsQuery = $state<RemoteQuery<CollectionRecord[]> | null>(null);
	watch(
		() => optionsQueryInput,
		(input) => {
			optionsQuery = input ? input.records.findMany(input.target, input.query) : null;
		},
		{ lazy: false }
	);

	/**
	 * Resolve the current value only when nobody resolved it for us. This is the lone-field case;
	 * a table hands labels down instead, so its cells never reach here.
	 */
	const valueQueryInput = $derived.by(() => {
		if (label != null || selectedIds.length === 0 || !relationOptions) return null;
		return {
			records,
			target,
			query: { where: { norbital_id: { in: selectedIds } }, limit: selectedIds.length }
		};
	});
	let valueQuery = $state<RemoteQuery<CollectionRecord[]> | null>(null);
	watch(
		() => valueQueryInput,
		(input) => {
			valueQuery = input ? input.records.findMany(input.target, input.query) : null;
		},
		{ lazy: false }
	);

	/** Label per selected id: the caller's, else one we resolved, else the id itself. */
	const labelById = $derived.by(() => {
		const byId = new Map<string, string>();
		const supplied = Array.isArray(label) ? label : label == null ? [] : [label];
		selectedIds.forEach((id, index) => {
			if (supplied[index] != null) byId.set(id, supplied[index]!);
		});
		for (const record of valueQuery?.current ?? []) {
			const id = record.norbital_id;
			if (typeof id === 'string' && relationOptions) byId.set(id, relationOptions.label(record));
		}
		return byId;
	});

	const options = $derived.by(() => {
		const byId = new Map<string, string>();
		for (const record of optionsQuery?.current ?? []) {
			const id = record.norbital_id;
			if (typeof id !== 'string') continue;
			byId.set(id, relationOptions ? relationOptions.label(record) : id);
		}
		// Keep the current selection visible even when it falls outside the option query.
		for (const id of selectedIds) if (!byId.has(id)) byId.set(id, labelById.get(id) ?? id);
		return [...byId].map(([optionValue, text]) => ({ value: optionValue, label: text }));
	});

	/** Filter controls the picker offers, so a long option list stays navigable. */
	const filterFields = $derived(relationOptions?.filters ?? []);

	// Never "loading" once something is displayable: a value already labelled must not flash.
	const loading = $derived(
		Boolean(optionsQuery?.loading || (label == null && selectedIds.length > 0 && valueQuery?.loading))
	);
	const error = $derived(optionsQuery?.error?.message ?? valueQuery?.error?.message ?? null);

	/**
	 * With no declared option set there is nothing honest to show but the id — inventing a label
	 * from whatever field looks name-ish is how a column silently renders the wrong thing.
	 */
	const displayLabel = $derived(
		selectedIds.length === 0 ? '—' : selectedIds.map((id) => labelById.get(id) ?? id).join(', ')
	);
</script>

{#snippet optionFilters()}
	{#if filterFields.length > 0}
		<div class="flex flex-wrap gap-1.5 border-b border-border px-2 pb-2">
			{#each filterFields as field (field)}
				<input
					class="h-7 min-w-24 flex-1 rounded-md border border-border bg-background px-2 text-xs"
					placeholder={humanize(field)}
					value={activeFilters[field] ?? ''}
					oninput={(event) =>
						(activeFilters = { ...activeFilters, [field]: event.currentTarget.value })}
				/>
			{/each}
		</div>
	{/if}
{/snippet}

{#if displayOnly}
	<!-- No loading state: the label arrives with the row, so there is nothing to wait for. -->
	<span class={cn('block truncate', className)} title={displayLabel}>
		{displayLabel}
	</span>
{:else if multiple}
	<Combobox
		{options}
		multiple={true}
		value={Array.isArray(value) ? value : []}
		emptyPlaceholder={placeholder}
		searchPlaceholder={`Search ${humanize(target)}…`}
		type="server"
		serverConfig={{ onSearch: (query) => (searchQuery = query), isLoading: loading, error }}
		header={optionFilters}
		allowClear={true}
		{disabled}
		{readonly}
		class={className}
		onValueChange={(next) => onValueChange?.(next ?? [])}
	/>
{:else}
	<Combobox
		{options}
		value={typeof value === 'string' ? value : null}
		emptyPlaceholder={placeholder}
		searchPlaceholder={`Search ${humanize(target)}…`}
		type="server"
		serverConfig={{ onSearch: (query) => (searchQuery = query), isLoading: loading, error }}
		header={optionFilters}
		allowClear={true}
		{disabled}
		{readonly}
		class={className}
		onValueChange={(next) => onValueChange?.(next)}
	/>
{/if}
