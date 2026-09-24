<script lang="ts">
	import { cn } from '#lib/utils';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Columns, Scroll, Stack } from '#lib/layout';
	import {
		assignLanes,
		endOfMonth,
		getMonthGrid,
		isSameDay,
		isWeekend,
		startOfMonth
	} from '#lib/event-calendar/utils';
	import type { CalendarEvent, EventRenderContext } from '#lib/event-calendar/types';
	import type { Snippet } from 'svelte';
	import EventPill from '../parts/event-pill.svelte';
	import { buttonVariants } from '#lib/button';

	let {
		date,
		events,
		onpillclick,
		oncellclick,
		eventContent,
		readonly = false,
		class: className
	}: {
		date: Date;
		events: CalendarEvent[];
		onpillclick?: (e: CalendarEvent) => void;
		oncellclick?: (day: Date) => void;
		eventContent?: Snippet<[CalendarEvent, EventRenderContext]>;
		readonly?: boolean;
		class?: string;
	} = $props();

	const { t } = useI18n<UiKeys>();

	const today = $derived(new Date());
	const { days, weekCount } = $derived(getMonthGrid(date));
	const monthStart = $derived(startOfMonth(date));
	const monthEnd = $derived(endOfMonth(date));

	const MAX_PILLS = 3;

	const cellEvents = $derived.by(() => {
		const map = new Map<string, CalendarEvent[]>();
		for (const day of days) {
			map.set(day.toISOString().slice(0, 10), []);
		}
		for (const event of events) {
			const evStart = new Date(event.start);
			evStart.setHours(0, 0, 0, 0);
			const evEnd = new Date(event.end);
			evEnd.setHours(23, 59, 59, 999);

			for (const day of days) {
				if (day < evStart || day > evEnd) continue;
				const list = map.get(day.toISOString().slice(0, 10));
				if (list) list.push(event);
			}
		}
		return map;
	});
</script>

<Scroll axis="y" name={t('misc.monthEvents')} class={cn('bg-background p-2', className)}>
	<Columns
		count={7}
		collapse="none"
		gap="none"
		class="h-full"
		style="grid-template-rows: repeat({weekCount}, 1fr)"
	>
		{#each days as day (day.toISOString())}
			{@const cellKey = day.toISOString().slice(0, 10)}
			{@const dayEvents = cellEvents.get(cellKey) ?? []}
			{@const isToday = isSameDay(day, today)}
			{@const isOutside = day < monthStart || day > monthEnd}
			{@const isWknd = isWeekend(day)}
			{@const overflow = Math.max(0, dayEvents.length - MAX_PILLS)}

			<button
				class={cn(
					'relative p-1 border border-border/60 rounded-sm text-left',
					'min-h-0 overflow-clip transition-colors',
					isOutside && 'opacity-40',
					isWknd && 'bg-muted/20',
					'transition-colors hover:bg-accent/40'
				)}
				onclick={() => oncellclick?.(day)}
			>
				<Stack gap="none" fill>
					<Stack
						as="span"
						gap="none"
						align="center"
						justify="center"
						shrink={false}
						class={cn(
							'size-[26px] rounded-full text-xs font-semibold',
							isToday && 'bg-brand text-brand-foreground'
						)}
					>
						{day.getDate()}
					</Stack>

					<Stack gap="xs" class="mt-0.5 min-w-0">
						{#each dayEvents.slice(0, MAX_PILLS) as event}
							<EventPill {event} onclick={onpillclick} />
						{/each}

						{#if overflow > 0}
							<span class="text-tiny font-medium text-muted-foreground px-1.5">
								{t('misc.moreItems', { count: overflow })}
							</span>
						{/if}
					</Stack>
				</Stack>
			</button>
		{/each}
	</Columns>
</Scroll>
