<script lang="ts">
	// The day grid inside a date or range picker's popover: arrows, a month and a year jump
	// (a birth date thirty years back is two picks, not four hundred presses) and the weeks.
	// Powered directly by `CalendarBehavior` (`create_calendar`).
	import Icon from '@iconify/svelte';
	import { getLocalTimeZone, today } from '@internationalized/date';
	import type { CalendarBehavior } from '../behaviors/index.js';
	import Combobox from '../primitives/combobox/combobox.svelte';
	import { cn, ui_text } from '../primitives/utils.js';

	let {
		calendar,
		locale,
		range = false
	}: {
		calendar: CalendarBehavior;
		locale?: string;
		/** A range picker: the ends are filled, the days between tinted. */
		range?: boolean;
	} = $props();
	const t = ui_text();
	const shown = $derived(calendar.placeholder);
	const monthNames = $derived(
		Array.from({ length: 12 }, (_, i) => ({
			value: String(i + 1),
			label: new Date(2000, i, 1).toLocaleDateString(locale, { month: 'long' })
		}))
	);
	// a century back and fifteen years on, and always the shown year
	const years = $derived.by(() => {
		const now = today(getLocalTimeZone()).year;
		const span = Array.from({ length: 116 }, (_, i) => now - 100 + i);
		return (span.includes(shown.year) ? span : [...span, shown.year].sort((a, b) => a - b))
			.map((y) => ({ value: String(y), label: String(y) }))
			.reverse();
	});
	const ARROW =
		'grid size-8 max-sm:size-11 place-items-center rounded-control border border-border-control text-muted-foreground hover:bg-accent hover:text-foreground';
</script>

<div class="flex items-center justify-between gap-1">
	<button type="button" class={ARROW} aria-label={t('previous')} onclick={() => calendar.prev_month()}>
		<Icon icon="lucide:chevron-left" class="size-4" />
	</button>
	<div class="flex gap-1">
		<Combobox
			class="w-28"
			aria-label={t('month')}
			options={monthNames}
			value={String(shown.month)}
			on_change={(m) => m !== null && calendar.set_placeholder(shown.set({ month: Number(m) }))}
		/>
		<Combobox
			class="w-20"
			aria-label={t('year')}
			options={years}
			value={String(shown.year)}
			on_change={(y) => y !== null && calendar.set_placeholder(shown.set({ year: Number(y) }))}
		/>
	</div>
	<button type="button" class={ARROW} aria-label={t('next')} onclick={() => calendar.next_month()}>
		<Icon icon="lucide:chevron-right" class="size-4" />
	</button>
</div>
<div class={calendar.months.length > 1 ? 'grid grid-cols-2 gap-4' : 'contents'}>
	{#each calendar.months as month (month.value.toString())}
		<div>
			{#if calendar.months.length > 1}
				<p class="mt-3 text-center text-sm font-medium">
					{new Date(Date.UTC(month.value.year, month.value.month - 1, 1)).toLocaleDateString(
						locale,
						{ month: 'long', year: 'numeric', timeZone: 'UTC' }
					)}
				</p>
			{/if}
			<table class="mt-3 w-full border-collapse select-none" role="grid">
				<thead>
					<tr class="flex">
						{#each calendar.weekdays as day, i (i)}
							<th class="w-9 max-sm:w-11 text-xs font-normal text-muted-foreground">
								{day.slice(0, 2)}
							</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each month.weeks as week (week[0]?.toString())}
						<tr class="mt-1 flex w-full">
							{#each week as date (date.toString())}
								{@const dayProps = calendar.day_attrs(date, month.value)}
								<td
									class={cn(
										'relative size-9 max-sm:size-11 p-0 text-center text-sm',
										range &&
											'[&:has([data-selected])]:bg-accent [&:has([data-selection-start])]:rounded-l-control [&:has([data-selection-end])]:rounded-r-control'
									)}
								>
									<div
										{...dayProps}
										{@attach calendar.day_ref(date)}
										class={cn(
											'inline-flex size-9 max-sm:size-11 cursor-pointer items-center justify-center rounded-control p-0 text-sm font-normal hover:bg-accent hover:text-accent-foreground',
											'[&[data-today]:not([data-selected])]:bg-accent [&[data-today]:not([data-selected])]:font-semibold',
											range
												? 'data-[selection-start]:bg-primary data-[selection-start]:text-primary-foreground data-[selection-end]:bg-primary data-[selection-end]:text-primary-foreground'
												: 'data-[selected]:bg-primary data-[selected]:text-primary-foreground',
											'data-[outside-month]:pointer-events-none data-[outside-month]:opacity-40 data-[disabled]:opacity-50 data-[unavailable]:line-through'
										)}
									>
										{date.day}
									</div>
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/each}
</div>
