<script lang="ts">
	import { useI18n, type UiKeys } from '#lib/i18n';
	import type { DataRendererProps } from '../data-renderer.types.js';
	import DateView from './views/date.view.svelte';

	type RangeValue = { start?: string; end?: string };

	const { t } = useI18n<UiKeys>();

	let {
		field,
		value,
		disabled = false,
		placeholder = t('dataRenderer.valuePlaceholder'),
		onValueChange,
		class: className
	}: DataRendererProps = $props();

	const valuePlaceholderText = t('dataRenderer.valuePlaceholder');

	function parseRange(item: unknown): RangeValue {
		if (item != null && typeof item === 'object') {
			const start = Reflect.get(item, 'start') ?? Reflect.get(item, 'lower');
			const end = Reflect.get(item, 'end') ?? Reflect.get(item, 'upper');
			return {
				start: typeof start === 'string' ? start : undefined,
				end: typeof end === 'string' ? end : undefined
			};
		}
		if (typeof item !== 'string' || item === 'empty') return {};
		const match = item.match(/^[[(]\"?([^,\"]*)\"?,\"?([^\]\)\"]*)\"?[\])]$/);
		return match ? { start: match[1] || undefined, end: match[2] || undefined } : {};
	}

	const pickerValue = $derived.by((): RangeValue | RangeValue[] =>
		field.array && Array.isArray(value) ? value.map(parseRange) : parseRange(value)
	);
</script>

{#if field.array}
	<DateView
		value={Array.isArray(pickerValue) ? pickerValue : []}
		multi={true}
		allowTime={field.kind === 'tstzrange'}
		emptyPlaceholder={placeholder === valuePlaceholderText ? t('dataRenderer.pickDateRanges') : placeholder}
		{disabled}
		class={className}
		onValueChange={(next) => onValueChange?.(next)}
	/>
{:else}
	<DateView
		value={!Array.isArray(pickerValue) ? pickerValue : {}}
		multi={false}
		allowTime={field.kind === 'tstzrange'}
		emptyPlaceholder={placeholder === valuePlaceholderText ? t('dataRenderer.pickDateRanges') : placeholder}
		{disabled}
		class={className}
		onValueChange={(next) => onValueChange?.(next)}
	/>
{/if}
