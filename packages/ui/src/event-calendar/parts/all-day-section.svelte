<script lang="ts">
	import { cn } from '#lib/utils';
	import { assignLanes, isSameDay } from '../utils.js';
	import type { CalendarEvent, EventRenderContext } from '../types.js';
	import type { Snippet } from 'svelte';
	import EventBar from './event-bar.svelte';

	let {
		events,
		columnCount = 7,
		allDayEvents = [],
		colWidth = 130,
		onbarclick,
		eventContent,
		class: className
	}: {
		events: CalendarEvent[];
		columnCount?: number;
		allDayEvents?: CalendarEvent[];
		colWidth?: number;
		onbarclick?: (e: CalendarEvent) => void;
		eventContent?: Snippet<[CalendarEvent, EventRenderContext]>;
		class?: string;
	} = $props();

	const allDay = $derived(events.filter((e) => e.allDay || !isSameDay(e.start, e.end)));

	const laneAssignments = $derived(assignLanes(allDay));
	const maxLanes = $derived(Math.max(1, ...laneAssignments.map((a) => a.totalLanes)));

	const LONE_HEIGHT = 22;
	const LABEL_LANE = 6;

	const assignedMap = $derived(new Map(laneAssignments.map((a) => [a.event.id, a])));
</script>

{#if allDay.length > 0}
	<div class={cn('border-b border-border bg-card/60', className)}>
		<div style="height: {Math.min(maxLanes, LABEL_LANE) * LONE_HEIGHT}px" class="relative">
			{#each allDay as event}
				{@const a = assignedMap.get(event.id)}
				{@const visible = a ? a.lane < LABEL_LANE : false}
				{#if visible}
					{@const lane = a!.lane}
					<EventBar
						{event}
						onclick={onbarclick}
						{eventContent}
						style="top: {lane * LONE_HEIGHT}px; left: 0; right: 0; height: {LONE_HEIGHT - 2}px"
					/>
				{/if}
			{/each}

			{#if maxLanes > LABEL_LANE}
				<div
					style="top: {LABEL_LANE * LONE_HEIGHT}px"
					class="absolute left-2 text-tiny text-muted-foreground font-medium"
				>
					+{maxLanes - LABEL_LANE} more
				</div>
			{/if}
		</div>
	</div>
{/if}
