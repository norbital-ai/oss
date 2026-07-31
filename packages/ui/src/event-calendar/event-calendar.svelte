<script lang="ts">
	import { cn } from '#lib/utils';
	import type { CalendarEvent, CalendarView, CreateSlot, EventRenderContext } from './types.js';
	import type { Snippet } from 'svelte';
	import { watch } from 'runed';
	import { Cover, Inline, Scroll, Stack } from '#lib/layout';
	import CalendarHeader from './parts/calendar-header.svelte';
	import TimeAxis from './parts/time-axis.svelte';
	import ColumnHeaders from './parts/column-headers.svelte';
	import DayView from './views/day-view.svelte';
	import WeekView from './views/week-view.svelte';
	import MonthView from './views/month-view.svelte';
	import * as Popover from '#lib/popover';

	let {
		events = [],
		view = 'week' as CalendarView,
		date: initialDate,
		views = ['day', 'week', 'month'] as CalendarView[],
		startHour = 0,
		endHour = 24,
		hourHeight = 56,
		snapMinutes = 15,
		colWidth = 110,
		readonly = false,
		onviewchange,
		ondatechange,
		oneventclick,
		oneventcreate,
		oneventupdate,
		oneventdelete,
		oneventmove,
		eventContent,
		eventEditor,
		eventClass,
		class: className,
		children
	}: {
		events?: CalendarEvent[];
		view?: CalendarView;
		date?: Date;
		views?: CalendarView[];
		startHour?: number;
		endHour?: number;
		hourHeight?: number;
		snapMinutes?: number;
		colWidth?: number;
		readonly?: boolean;
		onviewchange?: (v: CalendarView) => void;
		ondatechange?: (d: Date) => void;
		oneventclick?: (e: CalendarEvent) => void;
		oneventcreate?: (slot: CreateSlot) => void;
		oneventupdate?: (e: CalendarEvent, update: Partial<CalendarEvent>) => void;
		oneventdelete?: (e: CalendarEvent) => void;
		oneventmove?: (e: CalendarEvent, newStart: Date, newEnd: Date) => void;
		eventContent?: Snippet<[CalendarEvent, EventRenderContext]>;
		eventEditor?: Snippet<
			[EventRenderContext & { onsave: () => void; oncancel: () => void; ondelete: () => void }]
		>;
		eventClass?: (e: CalendarEvent) => string;
		class?: string;
		children?: Snippet;
	} = $props();

	let currentDate = $state<Date>(new Date());

	watch(
		() => initialDate,
		(date) => {
			if (date != null) currentDate = date;
		}
	);

	let selectedEvent = $state<CalendarEvent | null>(null);

	function handleViewChange(v: CalendarView) {
		onviewchange?.(v);
	}

	function handleDateChange(d: Date) {
		currentDate = d;
		ondatechange?.(d);
	}

	function handleEventClick(e: CalendarEvent) {
		selectedEvent = e;
		oneventclick?.(e);
	}

	function handleCellClick(day: Date) {
		handleDateChange(day);
	}

	function handleCreate(slot: CreateSlot) {
		oneventcreate?.(slot);
	}

	function handleMove(e: CalendarEvent, newStart: Date, newEnd: Date) {
		oneventmove?.(e, newStart, newEnd);
	}

	function handleSave() {
		if (selectedEvent) {
			oneventupdate?.(selectedEvent, selectedEvent);
		}
		selectedEvent = null;
	}

	function handleCancel() {
		selectedEvent = null;
	}

	function handleDelete() {
		if (selectedEvent) {
			oneventdelete?.(selectedEvent);
		}
		selectedEvent = null;
	}

	const editorCtx = $derived(
		selectedEvent
			? {
					view,
					mode: 'box' as const,
					isMultiDay: false,
					column: 0,
					lane: 0,
					totalLanes: 1,
					onsave: handleSave,
					oncancel: handleCancel,
					ondelete: handleDelete
				}
			: null
	);

	const activeColWidth = $derived(colWidth);
	const showTimeAxis = $derived(view !== 'month');
	const showColumnHeaders = $derived(view === 'week' || view === 'day');
	const columnCount = $derived(view === 'day' ? 1 : 7);
</script>

{#snippet calendarHeader()}
	<CalendarHeader
		{view}
		date={currentDate}
		{views}
		onviewchange={handleViewChange}
		ondatechange={handleDateChange}
		{readonly}
	/>
{/snippet}

<Cover
	as="div"
	gap="none"
	class={cn('bg-card rounded-lg border border-border shadow-card', className)}
	top={calendarHeader}
>
	<Inline gap="none" align="stretch" class="h-full">
		{#if children}
			{@render children()}
		{/if}

		<Stack gap="none" class="flex-1">
			{#if showColumnHeaders}
				<ColumnHeaders {view} date={currentDate} {columnCount} colWidth={activeColWidth} />
			{/if}

			<Inline gap="none" align="stretch" class="flex-1">
				{#if showTimeAxis}
					<TimeAxis {startHour} {endHour} {hourHeight} stepMinutes={60} />
				{/if}

				<Scroll axis="both" name="Calendar grid">
					{#if view === 'day'}
						<DayView
							date={currentDate}
							{events}
							{startHour}
							{endHour}
							{hourHeight}
							{snapMinutes}
							colWidth={activeColWidth}
							onboxclick={handleEventClick}
							oncreate={handleCreate}
							onmove={handleMove}
							{eventContent}
							{readonly}
						/>
					{:else if view === 'week'}
						<WeekView
							date={currentDate}
							{events}
							{startHour}
							{endHour}
							{hourHeight}
							{snapMinutes}
							colWidth={activeColWidth}
							onboxclick={handleEventClick}
							oncreate={handleCreate}
							onmove={handleMove}
							{eventContent}
							{readonly}
						/>
					{:else if view === 'month'}
						<MonthView
							date={currentDate}
							{events}
							onpillclick={handleEventClick}
							oncellclick={handleCellClick}
							{eventContent}
							{readonly}
						/>
					{/if}
				</Scroll>
			</Inline>
		</Stack>
	</Inline>
</Cover>

{#if selectedEvent && eventEditor && editorCtx}
	<Popover.Popover
		open={true}
		onOpenChange={(o) => {
			if (!o) handleCancel();
		}}
	>
		<Popover.PopoverContent class="w-[320px]" align="start" sideOffset={8}>
			{@render eventEditor(editorCtx)}
		</Popover.PopoverContent>
	</Popover.Popover>
{/if}
