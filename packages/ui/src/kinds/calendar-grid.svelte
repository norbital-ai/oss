<script lang="ts">
	// The day grid inside a date or range picker's popover (the old `calendar` / `range-calendar`, one file): arrows, a
	// month and a year jump (a birth date thirty years back is two picks, not four hundred presses) and the weeks.
	// `parts` is the picker's namespace; both share bits' calendar parts, so one grid styles both.
	import Icon from '@iconify/svelte';
	import { getLocalTimeZone, today, type DateValue } from '@internationalized/date';
	import type { DatePicker } from 'bits-ui';
	import Combobox from '../primitives/combobox/combobox.svelte';
	import { cn } from '../primitives/utils.js';

	let { parts: P, months, weekdays, placeholder, onPlaceholder, locale, range = false }: {
		parts: typeof DatePicker;
		months: readonly { value: DateValue; weeks: DateValue[][] }[];
		weekdays: readonly string[];
		placeholder: DateValue | undefined;
		onPlaceholder(next: DateValue): void;
		locale?: string;
		/** A range picker: the ends are filled, the days between tinted. */
		range?: boolean;
	} = $props();
	const shown = $derived(placeholder ?? today(getLocalTimeZone()));
	const monthNames = $derived(Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: new Date(2000, i, 1).toLocaleDateString(locale, { month: 'long' }) })));
	// a century back and fifteen years on, and always the shown year
	const years = $derived.by(() => {
		const now = today(getLocalTimeZone()).year;
		const span = Array.from({ length: 116 }, (_, i) => now - 100 + i);
		return (span.includes(shown.year) ? span : [...span, shown.year].sort((a, b) => a - b)).map((y) => ({ value: String(y), label: String(y) })).reverse();
	});
	const ARROW = 'grid size-7 place-items-center rounded-sm border border-input text-muted-foreground hover:bg-accent hover:text-foreground';
</script>

<P.Header class="flex items-center justify-between gap-1">
	<P.PrevButton class={ARROW}><Icon icon="lucide:chevron-left" class="size-4" /></P.PrevButton>
	<div class="flex gap-1">
		<Combobox size="sm" class="w-28" aria-label="Month" options={monthNames} value={String(shown.month)} onChange={(m) => m !== null && onPlaceholder(shown.set({ month: Number(m) }))} />
		<Combobox size="sm" class="w-20" aria-label="Year" options={years} value={String(shown.year)} onChange={(y) => y !== null && onPlaceholder(shown.set({ year: Number(y) }))} />
	</div>
	<P.NextButton class={ARROW}><Icon icon="lucide:chevron-right" class="size-4" /></P.NextButton>
</P.Header>
{#each months as month (month.value.toString())}
	<P.Grid class="mt-3 w-full border-collapse select-none">
		<P.GridHead>
			<P.GridRow class="flex">
				{#each weekdays as day, i (i)}<P.HeadCell class="w-9 text-[0.8rem] font-normal text-muted-foreground">{day.slice(0, 2)}</P.HeadCell>{/each}
			</P.GridRow>
		</P.GridHead>
		<P.GridBody>
			{#each month.weeks as week (week[0]?.toString())}
				<P.GridRow class="mt-1 flex w-full">
					{#each week as date (date.toString())}
						<P.Cell {date} month={month.value} class={cn('relative size-9 p-0 text-center text-sm',
							range && '[&:has([data-selected])]:bg-accent [&:has([data-selection-start])]:rounded-l-md [&:has([data-selection-end])]:rounded-r-md')}>
							<P.Day
								class={cn(
									'inline-flex size-9 items-center justify-center rounded-md p-0 text-sm font-normal hover:bg-accent hover:text-accent-foreground',
									'[&[data-today]:not([data-selected])]:bg-accent [&[data-today]:not([data-selected])]:font-semibold',
									range ? 'data-[selection-start]:bg-primary data-[selection-start]:text-primary-foreground data-[selection-end]:bg-primary data-[selection-end]:text-primary-foreground'
										: 'data-[selected]:bg-primary data-[selected]:text-primary-foreground',
									'data-[outside-month]:pointer-events-none data-[outside-month]:opacity-40 data-[disabled]:opacity-50 data-[unavailable]:line-through'
								)}
							/>
						</P.Cell>
					{/each}
				</P.GridRow>
			{/each}
		</P.GridBody>
	</P.Grid>
{/each}
