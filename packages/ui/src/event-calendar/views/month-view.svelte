<script lang="ts">
	import { cn } from '#lib/utils';
	import { Scroll, Stack } from '#lib/layout';
	import {
		assignLanes,
		endOfMonth,
		getMonthGrid,
		isSameDay,
		isWeekend,
		startOfMonth
	} from '../utils.js';
	import type { CalendarEvent, EventRenderContext } from '../types.js';
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

	const today = $derived(new Date());
	const { days, weekCount } = $derived(getMonthGrid(date));
	const monthStart = $derived(startOfMonth(date));
	const monthEnd = $derived(endOfMonth(date));

	const MAX_PILLS = 3;

	const cellEvents = $derived.by(() => {
		const map = new Map<string, CalendarEvent[]>();
		for (const day of days) {
			const key = day.toISOString().slice(0, 10);
			map.set(key, []);
		}
		for (const event of events) {
			const evStart = new Date(event.start);
			evStart.setHours(0, 0, 0, 0);
			const evEnd = new Date(event.end);
			evEnd.setHours(23, 59, 59, 999);

			for (const day of days) {
				if (day >= evStart && day <= evEnd) {
					const key = day.toISOString().slice(0, 10);
					const list = map.get(key);
					if (list) list.push(event);
				}
			}
		}
		return map;
	});

	function isOutsideMonth(day: Date): boolean {
		return day < monthStart || day > monthEnd;
	}
</script>

<Scroll axis="y" name="Month events" class={cn('bg-background p-2', className)}>
	<div
		class="grid h-full"
		style="grid-template-columns: repeat(7, 1fr); grid-template-rows: repeat({weekCount}, 1fr)"
	>
		{#each days as day (day.toISOString())}
			{@const cellKey = day.toISOString().slice(0, 10)}
			{@const dayEvents = cellEvents.get(cellKey) ?? []}
			{@const isToday = isSameDay(day, today)}
			{@const isOutside = isOutsideMonth(day)}
			{@const isWknd = isWeekend(day)}
			{@const overflow = Math.max(0, dayEvents.length - MAX_PILLS)}

			<button
				class={cn(
					'relative flex flex-col p-1 border border-border/60 rounded-sm text-left',
					'min-h-0 overflow-hidden transition-colors',
					isOutside && 'opacity-40',
					isWknd && 'bg-muted/20',
					'transition-colors hover:bg-accent/40'
				)}
				onclick={() => oncellclick?.(day)}
			>
				<span
					class={cn(
						'inline-flex items-center justify-center size-[26px] rounded-full text-xs font-semibold shrink-0',
						isToday && 'bg-brand text-brand-foreground'
					)}
				>
					{day.getDate()}
				</span>

				<Stack gap="xs" class="mt-0.5 min-w-0">
					{#each dayEvents.slice(0, MAX_PILLS) as event}
						<EventPill {event} onclick={onpillclick} />
					{/each}

					{#if overflow > 0}
						<span class="text-tiny font-medium text-muted-foreground px-1.5">
							+{overflow} more
						</span>
					{/if}
				</Stack>
			</button>
		{/each}
	</div>
</Scroll>
