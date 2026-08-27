<script lang="ts">
	import type { CollectionRecord, CollectionRelationOptions } from '@norbital-ai/std/collection';
	import { humanize } from '@norbital-ai/std/string';
	import { Combobox } from '#lib/combobox';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Cluster } from '#lib/layout';
	import { cn } from '#lib/utils';
	import { getCollectionClientContext } from '#lib/collection-runtime';
	import type { DataRendererProps } from '#lib/data-renderer/data-renderer.types';

	interface Props extends DataRendererProps {
		/**
		 * An explicit contextual option set. Automatic routing supplies the target collection's
		 * record-label strategy when this is omitted.
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
	}

	const { t } = useI18n<UiKeys>();

	let {
		field,
		value,
		mode = 'display',
		options: relationOptions,
		label = null,
		placeholder = t('dataRenderer.selectRecord'),
		disabled = false,
		class: className,
		onValueChange
	}: Props = $props();
	const records = getCollectionClientContext().records;
	const target = $derived.by(() => {
		if (!field.relation) {
			throw new Error(`RelationshipRenderer requires relation metadata for field "${field.name}".`);
		}
		return field.relation.target;
	});
	const multiple = $derived(field.array ?? false);
	const readonly = $derived(mode === 'display');

	const selectedIds = $derived(
		(Array.isArray(value) ? value : value ? [value] : []).filter((id) => id.length > 0)
	);
	let searchQuery = $state('');
	let activeFilters = $state<Record<string, string>>({});

	/** The option set, scoped by the caller's declaration plus whatever the picker has narrowed to. */
	const optionsQueryInput = $derived.by(() => {
		if (readonly) return null;
		const declaredWhere = relationOptions?.where ?? {};
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
	const optionsQuery = $derived(
		optionsQueryInput
			? optionsQueryInput.records.findMany(optionsQueryInput.target, optionsQueryInput.query)
			: null
	);

	/**
	 * Resolve the current value only when nobody resolved it for us. Tables and boards join their
	 * declared relationship fields and hand labels down; a lone form/filter field performs one
	 * focused lookup for its current selection.
	 */
	const valueQueryInput = $derived.by(() => {
		if (label != null || selectedIds.length === 0 || !relationOptions) return null;
		return {
			records,
			target,
			query: { where: { id: { in: selectedIds } }, limit: selectedIds.length }
		};
	});
	const valueQuery = $derived(
		valueQueryInput
			? valueQueryInput.records.findMany(valueQueryInput.target, valueQueryInput.query)
			: null
	);

	/** Label per selected id: the caller's, else one resolved from the target record. */
	const labelById = $derived.by(() => {
		const byId = new Map<string, string>();
		const supplied = Array.isArray(label) ? label : label == null ? [] : [label];
		selectedIds.forEach((id, index) => {
			if (supplied[index] != null) byId.set(id, supplied[index]!);
		});
		for (const record of valueQuery?.current ?? []) {
			const id = record.id;
			if (typeof id === 'string' && relationOptions) byId.set(id, relationOptions.label(record));
		}
		return byId;
	});

	const options = $derived.by(() => {
		const byId = new Map<string, string>();
		for (const record of optionsQuery?.current ?? []) {
			const id = record.id;
			if (typeof id !== 'string') continue;
			byId.set(id, relationOptions ? relationOptions.label(record) : id);
		}
		// Keep a labelled current selection visible even when it falls outside the option query.
		for (const id of selectedIds) {
			const selectedLabel = labelById.get(id);
			if (!byId.has(id) && selectedLabel) byId.set(id, selectedLabel);
		}
		return [...byId].map(([optionValue, text]) => ({ value: optionValue, label: text }));
	});

	/** Filter controls the picker offers, so a long option list stays navigable. */
	const filterFields = $derived(relationOptions?.filters ?? []);

	// Never "loading" once something is displayable: a value already labelled must not flash.
	const loading = $derived(
		Boolean(
			optionsQuery?.loading || (label == null && selectedIds.length > 0 && valueQuery?.loading)
		)
	);
	const error = $derived(optionsQuery?.error?.message ?? valueQuery?.error?.message ?? null);

	/**
	 * A missing label never degrades to the stored id. Identity is useful to the query layer and
	 * meaningless to an operator.
	 */
	const displayLabel = $derived(
		selectedIds.length === 0
			? '—'
			: selectedIds.flatMap((id) => labelById.get(id) ?? []).join(', ') || '—'
	);
</script>

{#snippet optionFilters()}
	{#if filterFields.length > 0}
		<Cluster gap="xs" class="border-b border-border px-2 pb-2">
			{#each filterFields as field (field)}
				<input
					class="h-7 min-w-24 flex-1 rounded-md border border-border bg-background px-2 text-xs"
					placeholder={humanize(field)}
					value={activeFilters[field] ?? ''}
					oninput={(event) =>
						(activeFilters = { ...activeFilters, [field]: event.currentTarget.value })}
				/>
			{/each}
		</Cluster>
	{/if}
{/snippet}

{#if readonly}
	<span class={cn('block truncate', className)} title={displayLabel}>
		{displayLabel}
	</span>
{:else if multiple}
	<Combobox
		{options}
		multiple={true}
		value={Array.isArray(value) ? value : []}
		emptyPlaceholder={placeholder}
		searchPlaceholder={t('dataRenderer.searchTarget', { target: humanize(target) })}
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
		searchPlaceholder={t('dataRenderer.searchTarget', { target: humanize(target) })}
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
