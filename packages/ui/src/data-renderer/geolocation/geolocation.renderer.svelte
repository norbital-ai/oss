<script lang="ts">
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { cn } from '#lib/utils';
	import type { DataRendererRuntime } from '#lib/data-renderer/data-renderer-runtime';
	import type { DataRendererProps } from '#lib/data-renderer/data-renderer.types';
	import GeolocationPicker from './geolocation.input.svelte';
	import {
		parseGeolocationPickerValues,
		type TGeolocationPickerValue
	} from '#lib/data-renderer/geolocation/geolocation.utils';

	const { t } = useI18n<UiKeys>();

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
		{t('dataRenderer.geoProviderMissing')}
	</p>
{/if}
