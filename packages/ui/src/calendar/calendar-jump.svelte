<script lang="ts">
	/**
	 * The month and the year as two selects in the calendar's heading, so a birth date thirty
	 * years back is two picks rather than four hundred presses of the previous-month button.
	 * Both write the calendar's `placeholder`, which is what the arrows move too.
	 */
	import { getLocalTimeZone, today, type DateValue } from '@internationalized/date';
	import { cn } from '#lib/utils';

	let {
		placeholder = $bindable(),
		class: className
	}: { placeholder?: DateValue | undefined; class?: string } = $props();

	const shown = $derived(placeholder ?? today(getLocalTimeZone()));
	const monthNames = new Intl.DateTimeFormat(undefined, { month: 'long' });
	const months = Array.from({ length: 12 }, (_, index) => ({
		value: index + 1,
		label: monthNames.format(new Date(2000, index, 1))
	}));
	// A century back and fifteen years on, and always the shown year, so a value outside the
	// window is still selected rather than blank.
	const years = $derived.by(() => {
		const now = today(getLocalTimeZone()).year;
		const span = Array.from({ length: 116 }, (_, index) => now - 100 + index);
		return span.includes(shown.year)
			? span
			: [...span, shown.year].sort((a: number, b: number) => a - b);
	});
	const selectClass =
		'h-7 rounded-md border border-input bg-background px-1 text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
</script>

<div class={cn('flex items-center gap-1', className)}>
	<select
		class={selectClass}
		aria-label="Month"
		value={shown.month}
		onchange={(event) => (placeholder = shown.set({ month: Number(event.currentTarget.value) }))}
	>
		{#each months as month (month.value)}
			<option value={month.value}>{month.label}</option>
		{/each}
	</select>
	<select
		class={selectClass}
		aria-label="Year"
		value={shown.year}
		onchange={(event) => (placeholder = shown.set({ year: Number(event.currentTarget.value) }))}
	>
		{#each years as year (year)}
			<option value={year}>{year}</option>
		{/each}
	</select>
</div>
