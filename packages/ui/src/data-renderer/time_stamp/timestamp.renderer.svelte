<script lang="ts">
	import DateView from './views/date.view.svelte';
	import TimeView from './views/time.view.svelte';
	import { calendarDateToInstant, instantToCalendarDate } from './date.utils.js';
	import type { DataRendererProps } from '../data-renderer.types.js';

	let {
		field,
		value,
		disabled = false,
		placeholder = 'Value…',
		onValueChange,
		class: className
	}: DataRendererProps = $props();

	function instantString(item: unknown): string | null {
		if (item instanceof Date && !Number.isNaN(item.getTime())) return item.toISOString();
		return typeof item === 'string' && item ? item : null;
	}

	const dateTimeValue = $derived.by((): string | string[] | null => {
		if (!field.array) return instantString(value);
		return Array.isArray(value) ? value.flatMap((item) => instantString(item) ?? []) : [];
	});
	const datePickerValue = $derived.by((): string | string[] | null => {
		const toInstant = (item: unknown): string | null => {
			const instant = instantString(item);
			if (!instant) return null;
			return /^\d{4}-\d{2}-\d{2}$/.test(instant) ? calendarDateToInstant(instant) : instant;
		};
		if (!field.array) return toInstant(value);
		if (!Array.isArray(value)) return [];
		return value.flatMap((item) => toInstant(item) ?? []);
	});

	function updateDate(next: string | string[] | null): void {
		onValueChange?.(
			Array.isArray(next)
				? next.flatMap((item) => instantToCalendarDate(item) ?? [])
				: next == null
					? null
					: instantToCalendarDate(next)
		);
	}
</script>

{#if field.kind === 'date' && field.array}
	<DateView
		value={Array.isArray(datePickerValue) ? datePickerValue : []}
		multi={true}
		placeholder={placeholder === 'Value…' ? 'Select date' : placeholder}
		{disabled}
		class={className}
		onValueChange={updateDate}
	/>
{:else if field.kind === 'date'}
	<DateView
		value={typeof datePickerValue === 'string' ? datePickerValue : null}
		multi={false}
		placeholder={placeholder === 'Value…' ? 'Select date' : placeholder}
		{disabled}
		class={className}
		onValueChange={updateDate}
	/>
{:else}
	<TimeView
		value={dateTimeValue}
		multiple={field.array ?? false}
		{placeholder}
		{disabled}
		class={className}
		onValueChange={(next) => onValueChange?.(next)}
	/>
{/if}
