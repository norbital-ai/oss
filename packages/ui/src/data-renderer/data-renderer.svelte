<script lang="ts">
	import {
		GeolocationPicker,
		parseGeolocationPickerValues,
		type TGeolocationPickerValue
	} from './geolocation/geolocation.internal.js';
	import { StructuredValue } from '#lib/structured-value';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { cn } from '#lib/utils';
	import DataRendererEditor from './data-renderer-editor.svelte';
	import { getDataRendererRuntimeContext } from './data-renderer-runtime.js';
	import type { CollectionRecord } from '@norbital-ai/std/collection';
	import type { DataRendererProps } from './data-renderer.types.js';
	import { formatDataValue, type Translate } from './data-renderer.utils.js';
	import NumericRenderer from './numeric/numeric.renderer.svelte';
	import RelationshipRenderer from './relationship/relationship.renderer.svelte';

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
		rendererRuntime?.autocompleteGeolocation ?? (() => Promise.resolve([]));
	const customRenderer = $derived(rendererRuntime?.customTypeRenderers[field.kind]);

	/**
	 * Only files route to the relationship renderer here, and only because a file's label is the
	 * asset's own name — something the platform owns rather than the view.
	 *
	 * A relation field is a uuid, so by default it renders as exactly that: text. Showing it as a
	 * labelled record is an explicit choice, made by passing `RelationshipRenderer` yourself with
	 * the option set you want (a table column's `render`, a form field's `renderer`). Nothing about
	 * the relation is inferred, and no surface fetches on your behalf.
	 */
	const fileTarget = $derived(field.kind === 'file' && !field.relation ? 'document_asset' : null);
	const fileOptions = {
		label: (record: CollectionRecord) =>
			typeof record.file_name === 'string' ? record.file_name : String(record.norbital_id)
	};
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
{:else if fileTarget}
	<RelationshipRenderer
		target={fileTarget}
		value={field.array
			? Array.isArray(value)
				? value.map(String)
				: []
			: typeof value === 'string'
				? value
				: null}
		multiple={field.array ?? false}
		options={fileOptions}
		{placeholder}
		{disabled}
		readonly={mode === 'display'}
		displayOnly={mode === 'display'}
		class={className}
		onValueChange={(next) => onValueChange?.(next)}
	/>
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
