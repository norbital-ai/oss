<script lang="ts">
	import { humanize } from '@norbital-ai/std/string';
	import { CodeEditor } from '#lib/code-editor';
	import { Combobox } from '#lib/combobox';
	import { cn } from '#lib/utils';
	import { watch } from 'runed';
	import BooleanRenderer from './boolean/boolean.renderer.svelte';
	import { getDataRendererRuntimeContext } from './data-renderer-runtime.js';
	import type { DataRendererProps } from './data-renderer.types.js';
	import { formatStructuredValue } from './data-renderer.utils.js';
	import FileRenderer from './file/file.renderer.svelte';
	import GeolocationRenderer from './geolocation/geolocation.renderer.svelte';
	import MoneyRenderer from './money/money.renderer.svelte';
	import NumericRenderer from './numeric/numeric.renderer.svelte';
	import PhoneNumberRenderer from './phone_number/phone_number.renderer.svelte';
	import TextRenderer from './text/text.renderer.svelte';
	import TimeRenderer from './time/time.renderer.svelte';
	import TimestamptzRenderer from './time_stamp/timestamp.renderer.svelte';
	import TstzrangeRenderer from './time_stamp_range/timestamp_range.renderer.svelte';

	const NUMERIC_KINDS = new Set(['numeric', 'number', 'integer']);
	const SIMPLE_INPUT_KINDS = new Set(['text', 'string', 'uuid']);

	let {
		field,
		value,
		id,
		disabled = false,
		placeholder = 'Value…',
		onValueChange,
		locale = 'en-US',
		class: className
	}: DataRendererProps = $props();
	const rendererRuntime = getDataRendererRuntimeContext();
	const enumOptions = $derived(
		(field.values ?? []).map((option) => ({ value: option, label: humanize(option) }))
	);
	let structuredDraft = $state('');
	let structuredError = $state('');
	let lastEmittedStructuredValue: unknown;
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
		try {
			// stupidity:allow R6b -- JSON.parse is the JSON editor's validation boundary and failures remain local draft errors.
			lastEmittedStructuredValue = JSON.parse(next);
			structuredError = '';
			onValueChange?.(lastEmittedStructuredValue);
		} catch {
			structuredError = 'Enter valid JSON before saving.';
		}
	}
</script>

{#if field.kind === 'enum'}
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
{:else if field.kind === 'date' || field.kind === 'timestamp' || field.kind === 'timestamptz'}
	<TimestamptzRenderer {field} {value} {disabled} {placeholder} {onValueChange} class={className} />
{:else if field.kind === 'date-range' || field.kind === 'tstzrange'}
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
		{locale}
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
		{locale}
		class={className}
	/>
{:else if field.kind === 'clock_time'}
	<TimeRenderer {field} {value} {id} {disabled} {placeholder} {onValueChange} class={className} />
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
	<!-- stupidity:allow UI7 -- this leaf component owns responsive or internal spacing as part of its public DOM contract -->
	<div class={cn('min-w-0 space-y-1.5', className)}>
		<CodeEditor
			value={structuredDraft}
			language="json"
			invalid={Boolean(structuredError)}
			readonly={disabled}
			minHeight="9rem"
			onValueChange={updateStructuredValue}
		/>
		{#if structuredError}
			<p class="text-xs text-destructive" role="alert">{structuredError}</p>
		{/if}
	</div>
{/if}
