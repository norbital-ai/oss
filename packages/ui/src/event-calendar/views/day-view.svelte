<script lang="ts">
	import { cn } from '#lib/utils';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Imposter, Scroll } from '#lib/layout';
	import { fromAction } from 'svelte/attachments';
	import { pixelDrag } from '#lib/utils/pixel-drag';
	import { assignLanes, dateToPixels, isMultiDayEvent, isSameDay } from '#lib/event-calendar/utils';
	import type { CalendarEvent, CreateSlot, EventRenderContext } from '#lib/event-calendar/types';
	import type { Snippet } from 'svelte';
	import EventBox from '../parts/event-box.svelte';
	import NowLine from '../parts/now-line.svelte';
	import { useDragState } from '../drag-state.svelte.js';

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

	const { t } = useI18n<UiKeys>();

	const drag = useDragState();

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
			view: 'day',
			mode: 'box',
			isMultiDay: isMultiDayEvent(event),
			column: 0,
			lane: a?.lane ?? 0,
			totalLanes: a?.totalLanes ?? 1
		};
	}

	function commitDrop(): void {
		const result = drag.endDrag(date, hourHeight, startHour, snapMinutes);
		if (!result) return;
		if (result.mode === 'create' && result.slot) {
			oncreate?.(result.slot);
		} else if (result.event && result.newStart && result.newEnd) {
			onmove?.(result.event, result.newStart, result.newEnd);
		}
	}

	const overlay = $derived(drag.getOverlayRect());
</script>

<Scroll axis="y" name={t('misc.dayEvents')} class={cn('relative bg-background', className)}>
	<div
		style="height: {totalHeight}px; position: relative; background-image: repeating-linear-gradient(to bottom, var(--color-border) 0 1px, transparent 1px {hourHeight}px)"
	>
		<NowLine {date} {hourHeight} {startHour} {endHour} timeAxisWidth={0} />

		{#if !readonly}
			<!-- The create-drag surface lies under the event blocks. -->
			<Imposter
				placement="fill"
				layer="under"
				{@attach fromAction(pixelDrag, () => ({
					onStart: (event) => {
						if (!drag.isDragging() && event.currentTarget instanceof HTMLElement) {
							const top = event.clientY - event.currentTarget.getBoundingClientRect().top;
							drag.beginCreate(0, top);
						}
					},
					onMove: (_e, _dx, dy) => drag.updateDrag(dy),
					onEnd: commitDrop,
					onCancel: drag.cancelDrag,
					axis: 'y' as const,
					cursor: 'crosshair'
				}))}
				role="none"
			/>
		{/if}

		{#each timedEvents as event (event.id)}
			{@const ctx = getContext(event)}
			{@const top = eventTop(event)}
			{@const h = eventHeight(event)}
			{@const editable = !readonly && event.editable !== false}
			<!-- An event block at its computed time offset. -->
			<Imposter
				placement="top-start"
				offset="none"
				layer="under"
				style={eventStyle(event)}
				role="button"
				tabindex={0}
				aria-disabled={!editable}
				title={!editable ? event.lockedReason : undefined}
				{@attach fromAction(pixelDrag, () => ({
					onStart: () => {
						if (editable) drag.beginMove(event, 0, top, h);
					},
					onMove: (_e, _dx, dy) => drag.updateDrag(dy),
					onEnd: commitDrop,
					onCancel: drag.cancelDrag,
					axis: 'y' as const
				}))}
			>
				<EventBox
					{event}
					{ctx}
					onclick={onboxclick}
					{eventContent}
					class={editable ? undefined : 'cursor-default opacity-70'}
				/>
				{#if editable}
					<!-- The resize grip pins to the event's lower edge. -->
					<Imposter
						placement="bottom"
						layer="under"
						class="h-2.5 cursor-s-resize rounded-b-md hover:bg-brand/10"
						{@attach fromAction(pixelDrag, () => ({
							onStart: (e) => {
								e.stopPropagation();
								drag.beginResize(event, 0, top, h);
							},
							onMove: (_e, _dx, dy) => drag.updateDrag(dy),
							onEnd: commitDrop,
							onCancel: drag.cancelDrag,
							axis: 'y' as const
						}))}
						role="none"
					/>
				{/if}
			</Imposter>
		{/each}

		{#if overlay}
			<!-- The drop preview at the drag offset. -->
			<Imposter
				placement="top"
				class="pointer-events-none inset-x-[2px] z-30 rounded-md border-2 border-dashed opacity-50"
				style="top: {overlay.top}px; height: {overlay.height}px; border-color: var(--color-brand); background: var(--color-brand-50)"
			/>
		{/if}
	</div>
</Scroll>
