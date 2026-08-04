<script lang="ts">
	import { cn } from '#lib/utils';
	import { Scroll } from '#lib/layout';
	import { pixelDrag } from '#lib/utils/pixel-drag';
	import { assignLanes, dateToPixels, isMultiDayEvent, isSameDay } from '../utils.js';
	import type { CalendarEvent, CalendarView, CreateSlot, EventRenderContext } from '../types.js';
	import type { Snippet } from 'svelte';
	import EventBox from '../parts/event-box.svelte';
	import NowLine from '../parts/now-line.svelte';
	import {
		isDragging,
		beginMove,
		beginResize,
		beginCreate,
		updateDrag,
		endDrag,
		cancelDrag,
		getOverlayRect
	} from '../drag-state.svelte.js';

	let {
		date,
		events,
		startHour = 0,
		endHour = 24,
		hourHeight = 60,
		snapMinutes = 15,
		colWidth = 130,
		onboxclick,
		oncreate,
		onmove,
		eventContent,
		readonly = false,
		class: className
	}: {
		date: Date;
		events: CalendarEvent[];
		startHour?: number;
		endHour?: number;
		hourHeight?: number;
		snapMinutes?: number;
		colWidth?: number;
		onboxclick?: (e: CalendarEvent) => void;
		oncreate?: (slot: CreateSlot) => void;
		onmove?: (e: CalendarEvent, newStart: Date, newEnd: Date) => void;
		eventContent?: Snippet<[CalendarEvent, EventRenderContext]>;
		readonly?: boolean;
		class?: string;
	} = $props();

	const totalHeight = $derived((endHour - startHour) * hourHeight);
	const timedEvents = $derived(events.filter((e) => !e.allDay && isSameDay(e.start, e.end)));
	const laneAssignments = $derived(assignLanes(timedEvents));
	const assignedMap = $derived(new Map(laneAssignments.map((a) => [a.event.id, a])));

	function eventTop(event: CalendarEvent): number {
		return dateToPixels(event.start, date, hourHeight, startHour);
	}

	function eventHeight(event: CalendarEvent): number {
		return Math.max(dateToPixels(event.end, date, hourHeight, startHour) - eventTop(event), 12);
	}

	function eventStyle(event: CalendarEvent): string {
		return `top: ${eventTop(event)}px; height: ${eventHeight(event)}px; width: calc(100% - 2px); left: 1px`;
	}

	function getContext(event: CalendarEvent): EventRenderContext {
		const a = assignedMap.get(event.id);
		return {
			view: 'day' as CalendarView,
			mode: 'box',
			isMultiDay: isMultiDayEvent(event),
			column: 0,
			lane: a?.lane ?? 0,
			totalLanes: a?.totalLanes ?? 1
		};
	}

	function commitDrop(): void {
		const result = endDrag(date, hourHeight, startHour, snapMinutes);
		if (!result) return;
		if (result.mode === 'create' && result.slot) {
			oncreate?.(result.slot);
		} else if (result.event && result.newStart && result.newEnd) {
			onmove?.(result.event, result.newStart, result.newEnd);
		}
	}

	const overlay = $derived(getOverlayRect());
</script>

<Scroll axis="y" name="Day events" class={cn('relative bg-background', className)}>
	<div style="height: {totalHeight}px; position: relative">
		{#each Array.from({ length: endHour - startHour + 1 }) as _, i (i)}
			<div
				style="top: {i * hourHeight}px"
				class="absolute left-0 right-0 h-px bg-border pointer-events-none"
			></div>
		{/each}

		<NowLine {date} {hourHeight} {startHour} {endHour} timeAxisWidth={0} />

		{#if !readonly}
			<div
				class="absolute inset-0"
				use:pixelDrag={{
					onStart: (event) => {
						if (!isDragging() && event.currentTarget instanceof HTMLElement) {
							const top = event.clientY - event.currentTarget.getBoundingClientRect().top;
							beginCreate(0, top);
						}
					},
					onMove: (_e, _dx, dy) => updateDrag(dy),
					onEnd: commitDrop,
					onCancel: cancelDrag,
					axis: 'y',
					cursor: 'crosshair'
				}}
				role="none"
			></div>
		{/if}

		{#each timedEvents as event (event.id)}
			{@const ctx = getContext(event)}
			{@const top = eventTop(event)}
			{@const h = eventHeight(event)}
			{@const editable = !readonly && event.editable !== false}
			<div
				class="absolute"
				style={eventStyle(event)}
				role="button"
				tabindex="0"
				aria-disabled={!editable}
				title={!editable ? event.lockedReason : undefined}
				use:pixelDrag={{
					onStart: () => {
						if (editable) beginMove(event, 0, top, h);
					},
					onMove: (_e, _dx, dy) => updateDrag(dy),
					onEnd: commitDrop,
					onCancel: cancelDrag,
					axis: 'y'
				}}
			>
				<EventBox
					{event}
					{ctx}
					onclick={onboxclick}
					{eventContent}
					style="top: 0; left: 0; right: 0; bottom: 0; position: static"
					class={editable ? undefined : 'cursor-default opacity-70'}
				/>
				{#if editable}
					<div
						class="absolute bottom-0 left-0 right-0 h-[10px] cursor-s-resize hover:bg-brand/10 rounded-b-md"
						use:pixelDrag={{
							onStart: (e) => {
								e.stopPropagation();
								beginResize(event, 0, top, h);
							},
							onMove: (_e, _dx, dy) => updateDrag(dy),
							onEnd: commitDrop,
							onCancel: cancelDrag,
							axis: 'y'
						}}
						role="none"
					></div>
				{/if}
			</div>
		{/each}

		{#if overlay}
			<div
				class="absolute left-[2px] right-[2px] rounded-md border-2 border-dashed opacity-50 z-30 pointer-events-none"
				style="top: {overlay.top}px; height: {overlay.height}px; border-color: var(--color-brand); background: var(--color-brand-50)"
			></div>
		{/if}
	</div>
</Scroll>
