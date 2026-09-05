<script lang="ts">
	import { Effect, Result, Schema } from 'effect';
	import { humanize } from '@norbital-ai/std/string';
	import { watch } from 'runed';
	import { CodeEditor } from '#lib/code-editor';
	import { Combobox } from '#lib/combobox';
	import { StructuredValue } from '#lib/structured-value';
	import { useI18n } from '#lib/i18n';
	import { cn } from '#lib/utils';
	import BooleanRenderer from './boolean/boolean.renderer.svelte';
	import ChannelsRenderer from './channels/channels.renderer.svelte';
	import FileRenderer from './file/file.renderer.svelte';
	import { readFileRef } from './file/file.types.js';
	import GeolocationPicker from './geolocation/geolocation.input.svelte';
	import GeolocationRenderer from './geolocation/geolocation.renderer.svelte';
	import {
		parseGeolocationPickerValues,
		type TGeolocationPickerValue
	} from './geolocation/geolocation.utils.js';
	import MoneyRenderer from './money/money.renderer.svelte';
	import NumericRenderer from './numeric/numeric.renderer.svelte';
	import PhoneNumberRenderer from './phone_number/phone_number.renderer.svelte';
	import TextRenderer from './text/text.renderer.svelte';
	import InstantRenderer from './time_stamp/timestamp.renderer.svelte';
	import TstzrangeRenderer from './time_stamp_range/timestamp_range.renderer.svelte';
	import { getDataRendererRuntimeContext } from './data-renderer-runtime.js';
	import type { DataRendererProps } from './data-renderer.types.js';
	import { formatDataValue, formatStructuredValue } from './data-renderer.utils.js';

	const BUILTIN_DISPLAY_KINDS = new Set([
		'boolean',
		'enum',
		'file',
		'geolocation',
		'integer',
		'instant',
		'instant_range',
		'money',
		'numeric',
		'number',
		'phone',
		'string',
		'text',
		'uuid'
	]);
	const NUMERIC_KINDS = new Set(['numeric', 'number', 'integer']);
	const SIMPLE_INPUT_KINDS = new Set(['text', 'string', 'uuid']);
	const decodeStructuredJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json));
	const isObjectish = Schema.is(
		Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Array(Schema.Unknown)])
	);
	const { t } = useI18n();

	let {
		field,
		value,
		id,
		mode = 'display',
		disabled = false,
		placeholder = t('dataRenderer.valuePlaceholder'),
		onValueChange,
		locale,
		class: className
	}: DataRendererProps = $props();
	const localeEffective = $derived(locale ?? useI18n().intlLocale);
	const rendererRuntime = getDataRendererRuntimeContext();
	const autocompleteGeolocation =
		rendererRuntime?.autocompleteGeolocation ?? (() => Effect.succeed([]));
	const enumOptions = $derived(
		(field.values ?? []).map((option) => ({ value: option, label: humanize(option) }))
	);
	const displayedFiles = $derived.by(
		(): ReadonlyArray<{ id: string; name: string; url: string | null }> => {
			if (field.kind !== 'file') return [];
			const candidates = Array.isArray(value) ? value : value == null ? [] : [value];
			return candidates.flatMap((candidate) => {
				const ref = readFileRef(candidate);
				if (ref === null) return [];
				return [
					{
						id: ref.storage_key,
						name: ref.file_name,
						url: rendererRuntime?.fileUrl(ref.storage_key) ?? null
					}
				];
			});
		}
	);
	const geolocationValue = $derived.by(
		(): TGeolocationPickerValue | TGeolocationPickerValue[] | null =>
			parseGeolocationPickerValues(value, field.array ?? false)
	);
	const usesStructuredDisplay = $derived(
		field.kind === 'json' ||
			(value != null && isObjectish(value) && !BUILTIN_DISPLAY_KINDS.has(field.kind))
	);
	let structuredDraft = $state('');
	let structuredError = $state('');
	let lastEmittedStructuredValue = $state<unknown>(undefined);
	watch(
		() => value,
		(next) => {
			if (next !== lastEmittedStructuredValue) {
				structuredDraft = next == null ? '' : formatStructuredValue(next, true);
				structuredError = '';
			}
		},
		{ lazy: false }
	);
	function updateStructuredValue(next: string): void {
		structuredDraft = next;
		if (!next.trim()) {
			structuredError = '';
			lastEmittedStructuredValue = field.nullable ? null : undefined;
			onValueChange?.(lastEmittedStructuredValue);
			return;
		}
		const parsed = decodeStructuredJson(next);
		if (Result.isFailure(parsed)) {
			structuredError = t('dataRenderer.invalidJson');
			return;
		}
		structuredError = '';
		lastEmittedStructuredValue = parsed.success;
		onValueChange?.(parsed.success);
	}
</script>

{#if mode === 'display' && field.kind === 'geolocation' && field.array}
	<GeolocationPicker
		value={Array.isArray(geolocationValue) ? geolocationValue : []}
		multiple={true}
		autocomplete={autocompleteGeolocation}
		readonly
		class={className}
	/>
{:else if mode === 'display' && field.kind === 'geolocation'}
	<GeolocationPicker
		value={geolocationValue && !Array.isArray(geolocationValue) ? geolocationValue : null}
		multiple={false}
		autocomplete={autocompleteGeolocation}
		readonly
		class={className}
	/>
{:else if mode === 'display' && NUMERIC_KINDS.has(field.kind)}
	<NumericRenderer
		{field}
		{value}
		mode="display"
		placeholder={t('dataRenderer.null')}
		locale={localeEffective}
		class={className}
	/>
{:else if mode === 'display' && field.kind === 'file'}
	{#if displayedFiles.length === 0}
		<span class={cn('min-w-0 truncate text-muted-foreground', className)}>{placeholder}</span>
	{:else}
		<span class={cn('inline-flex min-w-0 flex-wrap gap-x-2 gap-y-1', className)}>
			{#each displayedFiles as file (file.id)}
				{#if file.url === null}
					<span class="truncate">{file.name}</span>
				{:else}
					<a
						href={file.url}
						target="_blank"
						rel="noreferrer"
						class="truncate underline underline-offset-2">{file.name}</a
					>
				{/if}
			{/each}
		</span>
	{/if}
{:else if mode === 'display' && usesStructuredDisplay}
	<StructuredValue {value} class={cn('min-w-0 w-full', className)} />
{:else if mode === 'display'}
	{@const displayValue = formatDataValue(field, value, localeEffective, t)}
	<span class={cn('block min-w-0 truncate', className)} title={displayValue}>{displayValue}</span>
{:else if field.kind === 'enum'}
	<Combobox
		options={enumOptions}
		multiple={field.array ?? false}
		value={field.array
			? Array.isArray(value)
				? value.map(String)
				: []
			: typeof value === 'string'
				? value
				: null}
		searchable={enumOptions.length > 8}
		emptyPlaceholder={placeholder}
		class={className}
		{disabled}
		onValueChange={(next) => onValueChange?.(next ?? (field.array ? [] : null))}
	/>
{:else if field.kind === 'channels'}
	<ChannelsRenderer {value} {disabled} {onValueChange} class={className} />
{:else if field.kind === 'boolean'}
	<BooleanRenderer
		{field}
		{value}
		{id}
		{disabled}
		{placeholder}
		{onValueChange}
		class={className}
	/>
{:else if field.kind === 'instant'}
	<InstantRenderer {field} {value} {disabled} {placeholder} {onValueChange} class={className} />
{:else if field.kind === 'instant_range'}
	<TstzrangeRenderer {field} {value} {disabled} {placeholder} {onValueChange} class={className} />
{:else if field.kind === 'money'}
	<MoneyRenderer {field} {value} {id} {disabled} {onValueChange} class={className} />
{:else if NUMERIC_KINDS.has(field.kind)}
	<NumericRenderer
		{field}
		{value}
		{id}
		mode="edit"
		{disabled}
		{placeholder}
		{onValueChange}
		locale={localeEffective}
		class={className}
	/>
{:else if field.kind === 'phone'}
	<PhoneNumberRenderer
		{field}
		{value}
		{id}
		{disabled}
		{placeholder}
		{onValueChange}
		locale={localeEffective}
		class={className}
	/>
{:else if field.kind === 'geolocation'}
	<GeolocationRenderer
		{field}
		{value}
		{disabled}
		{onValueChange}
		runtime={rendererRuntime}
		class={className}
	/>
{:else if field.kind === 'file'}
	<FileRenderer
		{field}
		{value}
		{disabled}
		{onValueChange}
		runtime={rendererRuntime}
		class={className}
	/>
{:else if SIMPLE_INPUT_KINDS.has(field.kind)}
	<TextRenderer {field} {value} {id} {disabled} {placeholder} {onValueChange} class={className} />
{:else}
	<div class={cn('min-w-0 space-y-1.5', className)}>
		<CodeEditor
			value={structuredDraft}
			language="json"
			invalid={Boolean(structuredError)}
			readonly={disabled}
			minHeight="9rem"
			onValueChange={updateStructuredValue}
		/>
		{#if structuredError}<p class="text-xs text-destructive" role="alert">{structuredError}</p>{/if}
	</div>
{/if}
