<script lang="ts">
	import { useI18n, type UiKeys } from '#lib/i18n';
	import DateView from './views/date.view.svelte';
	import TimeView from './views/time.view.svelte';
	import type { DataRendererProps } from '#lib/data-renderer/data-renderer.types';
	import { instantFieldAllowsClear } from './timestamp.utils';

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

	function instantString(item: unknown): string | null {
		if (item instanceof Date && !Number.isNaN(item.getTime())) return item.toISOString();
		return typeof item === 'string' && item ? item : null;
	}

	const dateTimeValue = $derived.by((): string | string[] | null => {
		if (!field.array) return instantString(value);
		return Array.isArray(value) ? value.flatMap((item) => instantString(item) ?? []) : [];
	});
	const datePickerValue = $derived.by((): string | string[] | null => {
		if (!field.array) return instantString(value);
		if (!Array.isArray(value)) return [];
		return value.flatMap((item) => instantString(item) ?? []);
	});
	const allowClear = $derived(instantFieldAllowsClear(field));

	function updateDate(next: string | string[] | null): void {
		// Day precision changes only what the picker exposes. The selected value remains the exact
		// instant emitted by the calendar in the viewer's timezone; it is never collapsed to a bare
		// YYYY-MM-DD string or stored in a second temporal representation.
		onValueChange?.(next);
	}
</script>

{#if field.precision === 'day' && field.array}
	<DateView
		value={Array.isArray(datePickerValue) ? datePickerValue : []}
		multi={true}
		placeholder={placeholder === valuePlaceholderText ? t('dataRenderer.selectDate') : placeholder}
		{disabled}
		{allowClear}
		class={className}
		onValueChange={updateDate}
	/>
{:else if field.precision === 'day'}
	<DateView
		value={typeof datePickerValue === 'string' ? datePickerValue : null}
		multi={false}
		placeholder={placeholder === valuePlaceholderText ? t('dataRenderer.selectDate') : placeholder}
		{disabled}
		{allowClear}
		class={className}
		onValueChange={updateDate}
	/>
{:else}
	<TimeView
		value={dateTimeValue}
		multiple={field.array ?? false}
		{placeholder}
		{disabled}
		{allowClear}
		class={className}
		onValueChange={(next) => onValueChange?.(next)}
	/>
{/if}
