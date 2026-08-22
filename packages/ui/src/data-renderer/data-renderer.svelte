<script lang="ts">
	import { Effect } from 'effect';
	import GeolocationPicker from './geolocation/geolocation.input.svelte';
	import {
		parseGeolocationPickerValues,
		type TGeolocationPickerValue
	} from '#lib/data-renderer/geolocation/geolocation.utils';
	import { StructuredValue } from '#lib/structured-value';
	import { readFileRef } from '#lib/data-renderer/file/file.types';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { cn } from '#lib/utils';
	import DataRendererEditor from './data-renderer-editor.svelte';
	import { getDataRendererRuntimeContext } from '#lib/data-renderer/data-renderer-runtime';
	import type { DataRendererProps } from '#lib/data-renderer/data-renderer.types';
	import { formatDataValue, type Translate } from '#lib/data-renderer/data-renderer.utils';
	import NumericRenderer from './numeric/numeric.renderer.svelte';

	const { t } = useI18n<UiKeys>();

	const BUILTIN_DISPLAY_KINDS = new Set([
		'boolean',
		'date',
		'date-range',
		'dateRange',
		'enum',
		'file',
		'geolocation',
		'integer',
		'money',
		'numeric',
		'number',
		'phone',
		'clock_time',
		'string',
		'timestamp',
		'timestamptz',
		'datetime',
		'tstzrange',
		'text',
		'uuid'
	]);

	const NUMERIC_KINDS = new Set(['numeric', 'number', 'integer']);

	let {
		field,
		value,
		id,
		mode = 'display',
		disabled = false,
		placeholder = t('dataRenderer.valuePlaceholder'),
		onValueChange,
		row,
		onRowChange,
		locale,
		class: className
	}: DataRendererProps = $props();
	const localeEffective = $derived(locale ?? useI18n<UiKeys>().intlLocale);
	const rendererRuntime = getDataRendererRuntimeContext();
	const autocompleteGeolocation =
		rendererRuntime?.autocompleteGeolocation ?? (() => Effect.succeed([]));
	const customRenderer = $derived(rendererRuntime?.customTypeRenderers[field.kind]);

	/**
	 * A `file()` value displayed: its name, linking to its bytes.
	 *
	 * This used to route through `RelationshipRenderer` at `document_asset`, which was the only
	 * renderer able to turn an id into a label — a file column held a uuid and the name lived on
	 * another row. It fetched per record to show a filename, and it showed nothing at all, because
	 * the upload path never wrote the row it was fetching. The value now carries the name, so there
	 * is no target, no fetch, and no id to resolve.
	 *
	 * A relation field is still a uuid and still renders as exactly that: text. Showing it as a
	 * labelled record is an explicit choice, made by passing `RelationshipRenderer` yourself with
	 * the option set you want (a table column's `render`, a form field's `renderer`). Nothing about
	 * the relation is inferred, and no surface fetches on your behalf.
	 */
	const displayedFiles = $derived.by((): ReadonlyArray<{ name: string; url: string }> => {
		if (field.kind !== 'file' || field.relation) return [];
		const candidates = Array.isArray(value) ? value : value == null ? [] : [value];
		return candidates.flatMap((candidate) => {
			const ref = readFileRef(candidate);
			if (ref === null) return [];
			return [{ name: ref.file_name, url: `/api/files/${encodeURIComponent(ref.storage_key)}` }];
		});
	});
	const isFileDisplay = $derived(field.kind === 'file' && !field.relation && mode !== 'edit');
	const geolocationValue = $derived.by(
		(): TGeolocationPickerValue | TGeolocationPickerValue[] | null =>
			parseGeolocationPickerValues(value, field.array ?? false)
	);
	const geolocationValues = $derived(Array.isArray(geolocationValue) ? geolocationValue : []);
	const geolocationSingle = $derived(
		geolocationValue && !Array.isArray(geolocationValue) ? geolocationValue : null
	);
	const usesStructuredDisplay = $derived(
		field.kind === 'json' ||
			(value != null && typeof value === 'object' && !BUILTIN_DISPLAY_KINDS.has(field.kind))
	);
</script>

{#if customRenderer}
	{@const CustomRenderer = customRenderer}
	<CustomRenderer
		{field}
		{value}
		{id}
		{mode}
		{disabled}
		{placeholder}
		{onValueChange}
		{row}
		{onRowChange}
		locale={localeEffective}
		class={className}
	/>
{:else if field.kind === 'geolocation' && mode === 'display' && field.array}
	<GeolocationPicker
		value={geolocationValues}
		multiple={true}
		autocomplete={autocompleteGeolocation}
		readonly
		class={className}
	/>
{:else if field.kind === 'geolocation' && mode === 'display'}
	<GeolocationPicker
		value={geolocationSingle}
		multiple={false}
		autocomplete={autocompleteGeolocation}
		readonly
		class={className}
	/>
{:else if NUMERIC_KINDS.has(field.kind) && mode === 'display'}
	<NumericRenderer
		{field}
		{value}
		mode="display"
		placeholder={t('dataRenderer.null')}
		locale={localeEffective}
		class={className}
	/>
{:else if field.kind === 'file' && mode === 'edit'}
	<DataRendererEditor
		{field}
		{value}
		{id}
		{disabled}
		{placeholder}
		{onValueChange}
		locale={localeEffective}
		class={className}
	/>
{:else if isFileDisplay}
	{#if displayedFiles.length === 0}
		<span class={cn('text-muted-foreground', className)}>{placeholder}</span>
	{:else}
		<span class={cn('inline-flex flex-wrap gap-x-2 gap-y-1', className)}>
			{#each displayedFiles as file (file.url)}
				<a
					href={file.url}
					target="_blank"
					rel="noreferrer"
					class="truncate underline underline-offset-2"
				>
					{file.name}
				</a>
			{/each}
		</span>
	{/if}
{:else if mode === 'edit'}
	<DataRendererEditor
		{field}
		{value}
		{id}
		{disabled}
		{placeholder}
		{onValueChange}
		locale={localeEffective}
		class={className}
	/>
{:else if usesStructuredDisplay}
	<StructuredValue {value} class={className} />
{:else}
	{@const displayValue = formatDataValue(field, value, localeEffective, t as Translate)}
	<span class={cn('block truncate', className)} title={displayValue}>{displayValue}</span>
{/if}
