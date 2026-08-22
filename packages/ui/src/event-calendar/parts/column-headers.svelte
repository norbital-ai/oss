<script lang="ts">
	import { cn } from '#lib/utils';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { addDays, isSameDay, isWeekend } from '#lib/event-calendar/utils';
	import type { CalendarView } from '#lib/event-calendar/types';

	let {
		view,
		date,
		columnCount = 7,
		colWidth = 130,
		class: className
	}: {
		view: CalendarView;
		date: Date;
		columnCount?: number;
		colWidth?: number;
		class?: string;
	} = $props();

	const intlLocale = $derived(useI18n<UiKeys>().intlLocale);
	const today = $derived(new Date());

	const columns = $derived.by(() => {
		const result: { date: Date; label: string; isToday: boolean; isWeekend: boolean }[] = [];
		for (let i = 0; i < columnCount; i++) {
			const colDate = addDays(date, i);
			result.push({
				date: colDate,
				label: colDate.toLocaleDateString(intlLocale, {
					weekday: view === 'month' ? 'narrow' : 'short'
				}),
				isToday: isSameDay(colDate, today),
				isWeekend: isWeekend(colDate)
			});
		}
		return result;
	});

	const dayNumber = $derived(columns.map((c) => c.date.getDate()));
</script>

<div class={cn('sticky top-0 z-20 flex bg-card border-b border-border', className)}>
	{#each columns as col, i}
		<div
			style="width: {colWidth}px; min-width: {colWidth}px"
			class={cn(
				'flex flex-col items-center justify-center py-1.5',
				col.isWeekend && 'bg-muted/25',
				col.isToday && !col.isWeekend ? 'bg-brand-50/20' : ''
			)}
		>
			{#if view === 'month'}
				<span class="text-overline">
					{col.label}
				</span>
			{:else}
				<span
					class={cn(
						'text-xs font-medium',
						col.isToday ? 'text-brand-700' : 'text-muted-foreground'
					)}
				>
					{col.label}
				</span>
			{/if}
			<span
				class={cn(
					'inline-flex items-center justify-center text-sm font-semibold',
					view === 'month' && 'mt-0.5',
					col.isToday ? 'bg-brand text-brand-foreground size-[26px] rounded-full' : 'size-[26px]'
				)}
			>
				{dayNumber[i]}
			</span>
		</div>
	{/each}
</div>
