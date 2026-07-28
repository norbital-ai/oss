<script lang="ts">
	import { cn } from '#lib/utils';
	import { RangeCalendar as RangeCalendarPrimitive, type WithoutChildrenOrChild } from 'bits-ui';
	import Cell from './range-calendar-cell.svelte';
	import Day from './range-calendar-day.svelte';
	import Grid from './range-calendar-grid.svelte';
	import Header from './range-calendar-header.svelte';
	import Months from './range-calendar-months.svelte';
	import GridRow from './range-calendar-grid-row.svelte';
	import Heading from './range-calendar-heading.svelte';
	import HeadCell from './range-calendar-head-cell.svelte';
	import NextButton from './range-calendar-next-button.svelte';
	import PrevButton from './range-calendar-prev-button.svelte';

	const GridHead = RangeCalendarPrimitive.GridHead;
	const GridBody = RangeCalendarPrimitive.GridBody;

	let {
		ref = $bindable(null),
		value = $bindable(),
		placeholder = $bindable(),
		weekdayFormat = 'short',
		class: className,
		...restProps
	}: WithoutChildrenOrChild<RangeCalendarPrimitive.RootProps> = $props();
</script>

<RangeCalendarPrimitive.Root
	bind:ref
	bind:value
	bind:placeholder
	{weekdayFormat}
	class={cn('p-3', className)}
	{...restProps}
>
	{#snippet children({ months, weekdays })}
		<Header>
			<PrevButton />
			<Heading />
			<NextButton />
		</Header>
		<Months>
			{#each months as month}
				<Grid>
					<GridHead>
						<GridRow class="flex">
							{#each weekdays as weekday}
								<HeadCell>
									{weekday.slice(0, 2)}
								</HeadCell>
							{/each}
						</GridRow>
					</GridHead>
					<GridBody>
						{#each month.weeks as weekDates}
							<GridRow class="mt-2 w-full">
								{#each weekDates as date}
									<Cell {date} month={month.value}>
										<Day />
									</Cell>
								{/each}
							</GridRow>
						{/each}
					</GridBody>
				</Grid>
			{/each}
		</Months>
	{/snippet}
</RangeCalendarPrimitive.Root>
