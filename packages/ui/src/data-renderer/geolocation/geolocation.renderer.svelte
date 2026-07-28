<script lang="ts">
	import { cn } from '#lib/utils';
	import type { DataRendererRuntime } from '../data-renderer-runtime.js';
	import type { DataRendererProps } from '../data-renderer.types.js';
	import {
		GeolocationPicker,
		parseGeolocationPickerValues,
		type TGeolocationPickerValue
	} from './geolocation.internal.js';

	let {
		field,
		value,
		disabled = false,
		onValueChange,
		runtime,
		class: className
	}: DataRendererProps & { runtime?: DataRendererRuntime } = $props();

	const pickerValue = $derived.by((): TGeolocationPickerValue | TGeolocationPickerValue[] | null =>
		parseGeolocationPickerValues(value, field.array ?? false)
	);
</script>

{#if runtime && field.array}
	<GeolocationPicker
		value={Array.isArray(pickerValue) ? pickerValue : []}
		multiple={true}
		autocomplete={runtime.autocompleteGeolocation}
		{disabled}
		class={className}
		onValueChange={(next) => onValueChange?.(next ?? [])}
	/>
{:else if runtime}
	<GeolocationPicker
		value={pickerValue && !Array.isArray(pickerValue) ? pickerValue : null}
		multiple={false}
		autocomplete={runtime.autocompleteGeolocation}
		{disabled}
		class={className}
		onValueChange={(next) => onValueChange?.(next)}
	/>
{:else}
	<p
		class={cn('rounded-md border border-destructive/40 p-3 text-sm text-destructive', className)}
		role="alert"
	>
		Geolocation editing is unavailable because no geolocation provider is configured.
	</p>
{/if}
