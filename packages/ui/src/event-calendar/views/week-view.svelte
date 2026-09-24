<script lang="ts">
	import { cn } from '#lib/utils';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Imposter, Scroll, Stack } from '#lib/layout';
	import { fromAction } from 'svelte/attachments';
	import { pixelDrag } from '#lib/utils/pixel-drag';
	import {
		addDays,
		assignLanes,
		dateToPixels,
		isSameDay,
		isWeekend,
		startOfWeek
	} from '#lib/event-calendar/utils';
	import type { CalendarEvent, CreateSlot, EventRenderContext } from '#lib/event-calendar/types';
	import type { Snippet } from 'svelte';
	import EventBox from '../parts/event-box.svelte';
	import AllDaySection from '../parts/all-day-section.svelte';
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
		...rest
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

	const weekStart = $derived(startOfWeek(date));
	const totalHeight = $derived((endHour - startHour) * hourHeight);
	const timedEvents = $derived(events.filter((e) => !e.allDay && isSameDay(e.start, e.end)));

	const dayColumns = $derived.by(() => {
		const cols: CalendarEvent[][] = Array.from({ length: 7 }, () => []);
		for (const event of timedEvents) {
			for (let i = 0; i < 7; i++) {
				if (isSameDay(event.start, addDays(weekStart, i))) {
					cols[i].push(event);
					break;
				}
			}
		}
		return cols;
	});

	const laneMaps = $derived.by(() =>
		dayColumns.map((col) => {
			const assignments = assignLanes(col);
			return new Map(assignments.map((a) => [a.event.id, a]));
		})
	);

	function eventTop(event: CalendarEvent, col: number): number {
		return dateToPixels(event.start, addDays(weekStart, col), hourHeight, startHour);
	}

	function eventHeight(event: CalendarEvent, col: number): number {
		return Math.max(
			dateToPixels(event.end, addDays(weekStart, col), hourHeight, startHour) -
				eventTop(event, col),
			12
		);
	}

	function getContext(event: CalendarEvent, col: number): EventRenderContext {
		const a = laneMaps[col]?.get(event.id);
		return {
			view: 'week',
			mode: 'box',
			isMultiDay: false,
			column: col,
			lane: a?.lane ?? 0,
			totalLanes: a?.totalLanes ?? 1
		};
	}

	const today = $derived(new Date());
	const todayIndex = $derived.by(() => {
		for (let i = 0; i < 7; i++) if (isSameDay(addDays(weekStart, i), today)) return i;
		return -1;
	});

	function commitDrop(): void {
		const ds = drag.getDragState();
		const col = ds.mode !== 'idle' ? ds.column : 0;
		const colDate = addDays(weekStart, col);
		const result = drag.endDrag(colDate, hourHeight, startHour, snapMinutes);
		if (!result) return;
		if (result.mode === 'create' && result.slot) {
			oncreate?.(result.slot);
		} else if (result.event && result.newStart && result.newEnd) {
			onmove?.(result.event, result.newStart, result.newEnd);
		}
	}

	const overlay = $derived(drag.getOverlayRect());
	const ds = $derived(drag.getDragState());
	const overlayColumn = $derived(ds.mode !== 'idle' ? ds.column : 0);
	const overlayLeft = $derived(overlayColumn * colWidth + 2);
	const overlayWidth = $derived(colWidth - 4);
</script>

<Stack gap="none" grow {...rest}>
	<AllDaySection {events} columnCount={7} {colWidth} onbarclick={onboxclick} {eventContent} />

	<Scroll axis="y" name={t('misc.weekEvents')} class="bg-background relative">
		<div style="height: {totalHeight}px; position: relative; min-width: {7 * colWidth}px">
			{#each Array.from({ length: 7 }) as _, col (col)}
				{@const colDate = addDays(weekStart, col)}
				{@const isTodayColumn = col === todayIndex}
				{@const isWeekendCol = isWeekend(colDate)}
				<!-- A day column at its computed offset, under the event blocks. -->
				<Imposter
					placement="start"
					layer="under"
					style="left: {col *
						colWidth}px; width: {colWidth}px; background-image: repeating-linear-gradient(to bottom, var(--color-border) 0 1px, transparent 1px {hourHeight}px)"
					data-calendar-column={col}
					class={cn(
						isWeekendCol && 'bg-muted/25',
						isTodayColumn && !isWeekendCol && 'bg-brand-50/15'
					)}
				>
					{#if !readonly}
						<Imposter
							placement="fill"
							layer="under"
							{@attach fromAction(pixelDrag, () => ({
								onStart: (event) => {
									if (!drag.isDragging() && event.currentTarget instanceof HTMLElement) {
										const top = event.clientY - event.currentTarget.getBoundingClientRect().top;
										drag.beginCreate(col, top);
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
				</Imposter>

				{#each dayColumns[col] as event (event.id)}
					{@const ctx = getContext(event, col)}
					{@const a = laneMaps[col]?.get(event.id)}
					{@const totalLanes = Math.max(
						1,
						...dayColumns[col].map((e) => laneMaps[col]?.get(e.id)?.totalLanes ?? 1)
					)}
					{@const laneWidth = (colWidth - 4) / totalLanes}
					{@const top = eventTop(event, col)}
					{@const h = eventHeight(event, col)}
					{@const editable = !readonly && event.editable !== false}
					<!-- An event block at its computed time offset. -->
					<Imposter
						placement="top-start"
						offset="none"
						layer="under"
						style="left: {col * colWidth + 2 + (a?.lane ?? 0) * laneWidth}px; width: {laneWidth -
							2}px; top: {top}px; height: {h}px"
						role="button"
						tabindex={0}
						aria-disabled={!editable}
						title={!editable ? event.lockedReason : undefined}
						{@attach fromAction(pixelDrag, () => ({
							onStart: () => {
								if (editable) drag.beginMove(event, col, top, h);
							},
							onMove: (pointerEvent, _dx, dy) => {
								const targetColumn = Number(
									document
										.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)
										?.closest('[data-calendar-column]')
										?.getAttribute('data-calendar-column')
								);
								drag.updateDrag(dy, Number.isInteger(targetColumn) ? targetColumn : col);
							},
							onEnd: commitDrop,
							onCancel: drag.cancelDrag,
							axis: 'both' as const
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
										drag.beginResize(event, col, top, h);
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
			{/each}

			<NowLine {date} {hourHeight} {startHour} {endHour} timeAxisWidth={0} />

			{#if overlay}
				<!-- The drop preview at the drag offset. -->
				<Imposter
					placement="top-start"
					offset="none"
					class="pointer-events-none z-30 rounded-md border-2 border-dashed opacity-50"
					style="top: {overlay.top}px; left: {overlayLeft}px; width: {overlayWidth}px; height: {overlay.height}px; border-color: var(--color-brand); background: var(--color-brand-50)"
				/>
			{/if}
		</div>
	</Scroll>
</Stack>
