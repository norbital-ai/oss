<!--
@component
Events on a day, week or month grid: timed boxes, all-day bars, month pills; dragging creates, moves and resizes, and the caller writes the change. In a narrow container the month is a grid of days with a dot per event over the chosen day's events in full, and the week is a strip of days over the chosen day. Under touch a finger scrolls: a tap opens an event or creates in a slot.
-->
<script lang="ts" module>
	import type { UiContext } from '../client/contract.js';
	import type { Snippet } from 'svelte';
	import type { CalendarEvent, CalendarView, CreateSlot, EventRenderContext } from './calendar.js';

	/**
	 * Events on a day, week or month grid. Timed events are boxes placed by the clock (overlaps share the column in
	 * lanes); all-day and multi-day events are bars above the grid; a month cell shows three pills and "+N more".
	 * Unless `readonly`, dragging an empty slot creates, dragging a box moves it (across days in the week) and its
	 * lower edge resizes it; the calendar only reports: the caller writes and hands back new `events`. Narrow, it
	 * reflows by its own width; under touch a tap on a slot creates and a tap on a box opens it.
	 */
	export type EventCalendarProps = {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
		/** The events shown; after a create or move, pass the updated list back. */
		events: readonly CalendarEvent[];
		/** The initial view. Default `'week'`; the viewer's switch fires `on_view_change`. */
		view?: CalendarView;
		/** The views the switcher offers (hidden when only one). Default day, week and month. */
		views?: readonly CalendarView[];
		/** The day shown first; navigation moves away from it until it changes. */
		date?: Date;
		/** The time grid's first hour. Default 0. */
		start_hour?: number;
		/** The time grid's end hour (exclusive). Default 24. */
		end_hour?: number;
		/** Pixels per hour on the time grid. */
		hour_height?: number;
		/** Drags snap to this many minutes. Default 15. */
		snap_minutes?: number;
		/** The narrowest a week column gets before the grid scrolls sideways. */
		col_width?: number;
		/** No creating, moving or resizing; clicks still open events. Default false. */
		readonly?: boolean;
		/** The viewer switched views. */
		on_view_change?(view: CalendarView): void;
		/** The viewer navigated (previous, next, today, or a day picked in the narrow layouts). */
		on_date_change?(date: Date): void;
		/** An event was clicked or tapped. */
		on_event_click?(event: CalendarEvent): void;
		/** A drag (or tap, under touch) on empty grid selected this slot. */
		on_event_create?(slot: CreateSlot): void;
		/** An event was moved or resized to `start`–`end`; the calendar does not write it. */
		on_event_move?(event: CalendarEvent, start: Date, end: Date): void;
		/** An event's body in place of its title (and time, on a box). */
		event_content?: Snippet<[CalendarEvent, EventRenderContext]>;
		/** Connection or other calendar actions beside the displayed date. */
		actions?: Snippet;
	};
</script>

<script lang="ts">
	import Icon from '@iconify/svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { onMount } from 'svelte';
	import { watch } from 'runed';
	import { Button } from '../primitives/button/index.js';
	import TabStrip from '../primitives/tabs/tab-strip.svelte';
	import { cn, ui_text } from '../primitives/utils.js';
	import {
		addDays,
		clock,
		isTimed,
		isWeekend,
		lanes,
		monthGrid,
		onDay,
		sameDay,
		step,
		viewStart
	} from './calendar.js';

	let {
		ctx,
		events,
		view = 'week',
		views = ['day', 'week', 'month'],
		date,
		start_hour = 0,
		end_hour = 24,
		hour_height = 56,
		snap_minutes = 15,
		col_width = 110,
		readonly = false,
		on_view_change,
		on_date_change,
		on_event_click,
		on_event_create,
		on_event_move,
		event_content,
		actions
	}: EventCalendarProps = $props();
	const locale = $derived(ctx.ui.kinds.locale);
	const t = ui_text();
	let shown = $derived(view);
	let at = $derived(date ?? new Date());
	let now = $state(new Date());
	onMount(() => {
		const timer = setInterval(() => (now = new Date()), 60_000);
		return () => clearInterval(timer);
	});

	// the calendar reflows by its own width, not the screen's: a narrow pane is a phone to it
	let width = $state(Number.POSITIVE_INFINITY);
	const compact = $derived(width < 640);
	/** A finger scrolls the time grid: a drag there can neither create nor move. */
	const touch = new MediaQuery('pointer: coarse');
	const week_start = $derived(viewStart('week', at));
	const week = $derived(Array.from({ length: 7 }, (_, i) => addDays(week_start, i)));
	/** The narrow week: a strip of the week's days over one day's grid. */
	const strip = $derived(compact && shown === 'week');
	const first = $derived(viewStart(strip ? 'day' : shown, at));
	const days = $derived(shown === 'day' || strip ? [first] : week);
	const n = $derived(days.length);
	const height = $derived((end_hour - start_hour) * hour_height);
	let scroller = $state<HTMLElement | null>(null);
	watch(
		[() => scroller, () => shown, () => days, () => start_hour, () => hour_height],
		([element, view, dates, start, scale]) => {
			if (element === null || view === 'month') return;
			const current = new Date();
			const hour = dates.some((day) => sameDay(day, current))
				? Math.max(0, current.getHours() - 1)
				: 8;
			element.scrollTop = Math.max(0, (hour - start) * scale);
		}
	);
	const title = $derived.by(() => {
		const year = at.getFullYear() !== now.getFullYear() ? 'numeric' : undefined;
		if (shown === 'month') return at.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
		if (shown === 'day')
			return at.toLocaleDateString(locale, {
				weekday: 'long',
				month: 'long',
				day: 'numeric',
				year
			});
		return `${week_start.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} – ${addDays(week_start, 6).toLocaleDateString(locale, { month: 'short', day: 'numeric', year })}`;
	});
	const go = (d: Date) => {
		at = d;
		on_date_change?.(d);
	};
	const pick = (v: CalendarView) => {
		shown = v;
		on_view_change?.(v);
	};

	// ── time grid ──
	const px = (d: Date, day: Date) =>
		(((d.getTime() - new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()) /
			60_000 -
			start_hour * 60) *
			hour_height) /
		60;
	const columns = $derived(days.map((day) => {
		const timed = events.filter((event) => isTimed(event) && sameDay(event.start, day));
		return { day, events: timed, lanes: lanes(timed) };
	}));
	/** All-day and multi-day bars over the shown days, stacked in rows. */
	const bars = $derived.by(() => {
		const last = addDays(first, n);
		const rows: number[] = [];
		return events
			.filter((e) => !isTimed(e) && e.start < last && e.end > first)
			.sort((a, b) => a.start.getTime() - b.start.getTime())
			.map((e) => {
				const from = Math.max(
					0,
					days.findIndex((d) => sameDay(d, e.start) || d > e.start)
				);
				const to = n - 1 - [...days].reverse().findIndex((d) => d < e.end || sameDay(d, e.end));
				let row = rows.findIndex((free) => free <= from);
				if (row === -1) row = rows.length;
				rows[row] = to + 1;
				return { e, from, span: Math.max(1, to - from + 1), row };
			});
	});
	const barRows = $derived(Math.min(6, Math.max(0, ...bars.map((b) => b.row + 1))));

	type DragAction = { mode: 'create' } | { mode: 'move' | 'resize'; event: CalendarEvent };
	type Drag = DragAction & {
		col: number;
		y0: number;
		y: number;
		top: number;
		h: number;
		moved: boolean;
	};
	let drag = $state<Drag | null>(null);
	let grid = $state<HTMLElement | null>(null);
	let stop_drag = () => {};
	const drag_scope = () => () => stop_drag();
	const snap = (y: number) =>
		Math.round(y / ((hour_height * snap_minutes) / 60)) * ((hour_height * snap_minutes) / 60);
	const toDate = (day: Date, y: number) => {
		const d = new Date(day);
		d.setHours(0, start_hour * 60 + Math.round((snap(y) / hour_height) * 60), 0, 0);
		return d;
	};
	const point = (e: MouseEvent, element: HTMLElement) => {
		const r = element.getBoundingClientRect();
		return {
			col: Math.min(n - 1, Math.max(0, Math.floor((e.clientX - r.left) / (r.width / n)))),
			y: Math.min(height, Math.max(0, e.clientY - r.top))
		};
	};
	function begin(e: PointerEvent, action: DragAction) {
		const element = grid;
		if (e.button !== 0 || element === null) return;
		e.stopPropagation();
		e.preventDefault(); // no text selection or native drag, which would cancel the pointer
		const event = action.mode === 'create' ? undefined : action.event;
		const p = point(e, element);
		const locked = readonly || event?.editable === false;
		if (locked && action.mode !== 'move') return;
		const col = event === undefined ? p.col : days.findIndex((day) => sameDay(day, event.start));
		const day = days[col];
		if (day === undefined) return;
		stop_drag();
		const top = event === undefined ? snap(p.y) : px(event.start, day);
		drag = {
			...action,
			col,
			y0: p.y,
			y: p.y,
			top,
			h: event === undefined ? 0 : px(event.end, day) - top,
			moved: false
		};
		const move = (m: PointerEvent) => {
			if (drag === null) return;
			const q = point(m, element);
			const moved =
				drag.moved || Math.abs(q.y - drag.y0) > 3 || (drag.mode === 'move' && q.col !== drag.col);
			drag = {
				...drag,
				y: q.y,
				moved,
				col: drag.mode === 'move' && !locked && n > 1 ? q.col : drag.col
			};
		};
		const clear = () => {
			removeEventListener('pointermove', move);
			removeEventListener('pointerup', up);
			removeEventListener('pointercancel', up);
			drag = null;
			stop_drag = () => {};
		};
		const up = (u: PointerEvent) => {
			const d = drag;
			clear();
			if (d === null || u.type === 'pointercancel') return;
			if (!d.moved) {
				if (d.mode !== 'create') on_event_click?.(d.event);
				return;
			}
			if (locked) return;
			const day = days[d.col];
			if (day === undefined) return;
			const r = rect(d);
			const start = toDate(day, r.top),
				end = toDate(day, r.top + r.h);
			if (end <= start) return;
			if (d.mode === 'create') on_event_create?.({ start, end });
			else on_event_move?.(d.event, start, end);
		};
		stop_drag = clear;
		addEventListener('pointermove', move);
		addEventListener('pointerup', up);
		addEventListener('pointercancel', up);
	}
	/** Under touch a tap on an empty slot creates an hour there. */
	function tapSlot(e: MouseEvent & { currentTarget: EventTarget & HTMLElement }) {
		const element = grid;
		if (!touch.current || readonly || e.target !== e.currentTarget || element === null) return;
		const { col, y } = point(e, element);
		const day = days[col];
		if (day === undefined) return;
		on_event_create?.({ start: toDate(day, y), end: toDate(day, y + hour_height) });
	}
	/** The drop preview: where the box would land. */
	function rect(d: Drag): { top: number; h: number } {
		const dy = d.y - d.y0;
		if (d.mode === 'create')
			return {
				top: snap(Math.min(d.y0, d.y)),
				h: Math.max(snap(Math.abs(dy)), (hour_height * snap_minutes) / 60)
			};
		if (d.mode === 'move') return { top: snap(d.top + dy), h: d.h };
		return { top: d.top, h: Math.max((hour_height * snap_minutes) / 60, snap(d.h + dy)) };
	}
	const preview = $derived(
		drag?.moved === true && !readonly && (drag.mode === 'create' || drag.event.editable !== false) ? rect(drag) : null
	);

	// ── month ──
	const cells = $derived(monthGrid(at));
	const MAX_PILLS = 3;
	const weekdays = $derived(
		Array.from({ length: 7 }, (_, i) =>
			addDays(new Date(2024, 0, 1), i).toLocaleDateString(locale, { weekday: 'short' })
		)
	);
</script>

{#snippet body(e: CalendarEvent, mode: EventRenderContext['mode'])}
	{#if event_content}{@render event_content(e, { view: shown, mode })}
	{:else}
		<span class="block truncate text-micro font-semibold leading-tight text-foreground"
			>{e.title}</span
		>
		{#if mode === 'box'}<span
				class="block truncate font-mono text-tiny tabular-nums text-muted-foreground"
				>{clock(e.start)} – {clock(e.end)}</span
			>{/if}
	{/if}
{/snippet}

<div
	class="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border bg-card"
	data-event-calendar={shown}
	bind:clientWidth={width}
>
	<header
		class={cn(
			'flex flex-wrap items-center justify-between gap-2 border-b px-4',
			views.length > 1 ? 'pt-2.5' : 'py-2.5'
		)}
	>
		<div class="flex min-w-0 flex-wrap items-center gap-1">
			<Button
				variant="ghost"
				size="icon"
				aria-label={t('previous')}
				onclick={() => go(step(shown, at, -1))}
				><Icon icon="lucide:chevron-left" class="size-4" /></Button
			>
			<Button variant="ghost" class="px-2.5 text-xs" onclick={() => go(new Date())}
				>{t('today')}</Button
			>
			<Button
				variant="ghost"
				size="icon"
				aria-label={t('next')}
				onclick={() => go(step(shown, at, 1))}
				><Icon icon="lucide:chevron-right" class="size-4" /></Button
			>
			<span class="ml-2 text-sm font-semibold select-none">{title}</span>
			{#if actions}<div class="ml-2">{@render actions()}</div>{/if}
		</div>
		{#if views.length > 1}
			<TabStrip
				class="border-b-0"
				label="View"
				value={shown}
				items={views.map((v) => ({ name: v, title: t(v) }))}
				on_value_change={(v) => {
					const next = views.find((x) => x === v);
					if (next !== undefined) pick(next);
				}}
			/>
		{/if}
	</header>

	{#if shown === 'month' && compact}
		<div class="min-h-0 flex-1 overflow-auto overscroll-contain" data-calendar-compact>
			<div class="grid grid-cols-7 px-2 pt-1 text-center">
				{#each weekdays as w (w)}<span class="py-1 text-overline text-muted-foreground">{w}</span
					>{/each}
				{#each cells as d (d.getTime())}
					{@const list = onDay(events, d)}
					<button
						type="button"
						class={cn(
							'flex h-11 flex-col items-center justify-center gap-0.5 rounded-md text-xs font-semibold [--hit-target:0px]',
							d.getMonth() !== at.getMonth() && 'text-muted-foreground',
							sameDay(d, at) && 'bg-accent'
						)}
						aria-pressed={sameDay(d, at)}
						data-day={d.getDate()}
						onclick={() => go(d)}
					>
						<span
							class={cn(
								'grid size-6 place-items-center rounded-full',
								sameDay(d, now) && 'bg-brand text-brand-foreground'
							)}>{d.getDate()}</span
						>
						<span class="flex h-1 gap-0.5" aria-hidden="true">
							{#each list.slice(0, 3) as e (e.id)}<span
									class="size-1 rounded-full"
									style:background={e.color ?? 'var(--color-brand)'}
								></span>{/each}
						</span>
					</button>
				{/each}
			</div>
			<ul class="mt-1 divide-y border-t" data-calendar-agenda>
				{#each onDay(events, at) as e (e.id)}
					<li>
						<button
							type="button"
							class="flex w-full min-w-0 items-stretch gap-2 px-4 py-2 text-left"
							data-event={e.id}
							onclick={() => on_event_click?.(e)}
						>
							<span
								class="w-0.75 shrink-0 rounded-full"
								style:background={e.color ?? 'var(--color-brand)'}
							></span>
							<span class="min-w-0 flex-1">{@render body(e, isTimed(e) ? 'box' : 'bar')}</span>
						</button>
					</li>
				{:else}
					<li class="px-4 py-3 text-xs text-muted-foreground">{t('noResults')}</li>
				{/each}
			</ul>
		</div>
	{:else if shown === 'month'}
		<div class="mx-4 grid grid-cols-7 border-b text-center">
			{#each weekdays as w (w)}<span class="py-1.5 text-overline text-muted-foreground">{w}</span
				>{/each}
		</div>
		<div
			class="mx-4 mb-4 grid min-h-0 flex-1 grid-cols-7 gap-px overflow-auto bg-border p-px"
			style:grid-template-rows="repeat({cells.length / 7}, minmax(6rem, 1fr))"
		>
			{#each cells as d (d.getTime())}
				{@const list = onDay(events, d)}
				<div
					class={cn(
						'flex min-w-0 flex-col gap-0.5 overflow-hidden bg-popover p-1 dark:bg-background',
						isWeekend(d) && 'bg-muted dark:bg-muted/20',
						d.getMonth() !== at.getMonth() && 'bg-background text-muted-foreground dark:bg-muted'
					)}
					data-day={d.getDate()}
				>
					<button
						type="button"
						class={cn(
							'grid size-6.5 place-items-center self-start rounded-full text-xs font-semibold hover:bg-accent',
							sameDay(d, now) && 'bg-brand text-brand-foreground hover:bg-brand'
						)}
						onclick={() => {
							go(d);
							pick('day');
						}}>{d.getDate()}</button
					>
					{#each list.slice(0, MAX_PILLS) as e (e.id)}
						<button
							type="button"
							class="flex min-w-0 items-center gap-1 rounded-full bg-secondary px-1.5 py-0.5 text-left text-secondary-foreground hover:brightness-95 dark:bg-muted/60 dark:text-foreground"
							onclick={() => on_event_click?.(e)}
							data-event={e.id}
						>
							<span
								class="size-1.25 shrink-0 rounded-full"
								style:background={e.color ?? 'var(--color-brand)'}
							></span>
							<span class="min-w-0 flex-1">{@render body(e, 'pill')}</span>
						</button>
					{/each}
					{#if list.length > MAX_PILLS}<button
							type="button"
							class="rounded-sm px-1.5 text-left text-tiny font-medium text-muted-foreground hover:bg-accent"
							onclick={() => {
								go(d);
								pick('day');
							}}>{t('more').replace('{n}', String(list.length - MAX_PILLS))}</button
						>{/if}
				</div>
			{/each}
		</div>
	{:else}
		{#if strip}
			<div class="grid shrink-0 grid-cols-7 border-b px-2 py-1" data-calendar-strip>
				{#each week as d (d.getTime())}
					<button
						type="button"
						class={cn(
							'flex flex-col items-center gap-0.5 rounded-md py-1 [--hit-target:0px]',
							sameDay(d, at) && 'bg-accent'
						)}
						aria-pressed={sameDay(d, at)}
						onclick={() => go(d)}
					>
						<span class="text-tiny text-muted-foreground"
							>{d.toLocaleDateString(locale, { weekday: 'short' })}</span
						>
						<span
							class={cn(
								'grid size-6 place-items-center rounded-full text-xs font-semibold',
								sameDay(d, now) && 'bg-brand text-brand-foreground'
							)}>{d.getDate()}</span
						>
					</button>
				{/each}
			</div>
		{/if}
		<div
			bind:this={scroller}
			class={cn('min-h-0 flex-1 overflow-auto overscroll-contain', !compact && 'mx-4 mb-4')}
			data-calendar-scroll
		>
			<div class="relative" style:min-width="calc(3.5rem + {n * col_width}px)">
				<!-- the day headings and the all-day band stay pinned above the scrolling grid -->
				<div class="sticky top-0 z-20 border-b bg-card">
					{#if !strip}<div class="flex">
							<div class="w-14 shrink-0"></div>
							{#each days as d (d.getTime())}
								<div
									class={cn(
										'flex flex-1 flex-col items-center py-1.5',
										isWeekend(d) && 'bg-muted dark:bg-muted/25'
									)}
								>
									<span
										class={cn(
											'text-xs font-medium',
											sameDay(d, now) ? 'text-brand-text' : 'text-muted-foreground'
										)}>{d.toLocaleDateString(locale, { weekday: 'short' })}</span
									>
									<span
										class={cn(
											'grid size-6.5 place-items-center rounded-full text-sm font-semibold',
											sameDay(d, now) && 'bg-brand text-brand-foreground'
										)}>{d.getDate()}</span
									>
								</div>
							{/each}
						</div>{/if}
					{#if barRows > 0}
						<div class="relative ml-14 border-t" style:height="{barRows * 22 + 4}px">
							{#each bars.filter((b) => b.row < barRows) as b (b.e.id)}
								<button
									type="button"
									class="absolute flex h-5 items-center gap-1 rounded-full bg-secondary px-2 text-left text-secondary-foreground dark:bg-muted/60 dark:text-foreground"
									data-event={b.e.id}
									style:left="calc({b.from} * 100% / {n} + 2px)"
									style:width="calc({b.span} * 100% / {n} - 4px)"
									style:top="{b.row * 22 + 2}px"
									onclick={() => on_event_click?.(b.e)}
								>
									<span
										class="size-1.25 shrink-0 rounded-full"
										style:background={b.e.color ?? 'var(--color-brand)'}
									></span>
									<span class="min-w-0 flex-1">{@render body(b.e, 'bar')}</span>
								</button>
							{/each}
						</div>
					{/if}
				</div>
				<div class="flex">
					<div
						class="sticky left-0 z-10 w-14 shrink-0 bg-card select-none"
						style:height="{height}px"
					>
						<!-- each label centred on its hour line; the first sits below the top edge -->
						{#each Array.from({ length: end_hour - start_hour }, (_, i) => i) as i (i)}
							<span
								class="absolute right-2 font-mono text-tiny leading-none text-muted-foreground tabular-nums {i >
								0
									? '-translate-y-1/2'
									: ''}"
								style:top="{i * hour_height + (i === 0 ? 2 : 0)}px"
								>{String(start_hour + i).padStart(2, '0')}:00</span
							>
						{/each}
					</div>
					<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
					<div
						bind:this={grid}
						{@attach drag_scope}
						class={cn(
							'relative flex-1 bg-popover select-none dark:bg-background',
							!readonly && !touch.current && 'touch-none cursor-crosshair'
						)}
						style:height="{height}px"
						onpointerdown={(e) => !readonly && !touch.current && begin(e, { mode: 'create' })}
						onclick={tapSlot}
					>
						{#each columns as column, col (column.day.getTime())}
							{@const d = column.day}
							<div
								class={cn(
									'pointer-events-none absolute inset-y-0 border-l border-border',
									isWeekend(d) && 'bg-muted dark:bg-muted/25',
									sameDay(d, now) && !isWeekend(d) && 'bg-brand/10'
								)}
								style:left="calc({col} * 100% / {n})"
								style:width="calc(100% / {n})"
								style:background-image="repeating-linear-gradient(to bottom, var(--color-border) 0
								1px, transparent 1px {hour_height}px)"
							></div>
							{#each column.events as e (e.id)}
								{@const l = column.lanes.get(e.id) ?? { lane: 0, of: 1 }}
								{@const top = px(e.start, d)}
								{@const editable = !readonly && e.editable !== false}
								<div
									class={cn(
										'absolute overflow-hidden rounded-md border bg-card text-left transition-colors hover:border-input',
										editable ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
										drag !== null && drag.mode !== 'create' && drag.event.id === e.id && drag.moved && 'opacity-40'
									)}
									style:top="{top}px"
									style:height="{Math.max(12, px(e.end, d) - top)}px"
									style:left="calc(({col} + {l.lane / l.of}) * 100% / {n} + 2px)"
									style:width="calc(100% / {n * l.of} - 4px)"
									role="button"
									tabindex="0"
									title={editable ? undefined : e.locked_reason}
									data-event={e.id}
									onpointerdown={(p) => editable && !touch.current && begin(p, { mode: 'move', event: e })}
									onclick={() => {
										if (!editable || touch.current) on_event_click?.(e);
									}}
									onkeydown={(k) => {
										if (k.key === 'Enter' || k.key === ' ') {
											k.preventDefault();
											on_event_click?.(e);
										}
									}}
								>
									<div class="h-0.75" style:background={e.color ?? 'var(--color-brand)'}></div>
									<div class="min-w-0 px-1.5 py-1">{@render body(e, 'box')}</div>
									{#if editable && !touch.current}
										<!-- svelte-ignore a11y_no_static_element_interactions -->
										<div
											class="absolute inset-x-0 bottom-0 h-2.5 cursor-s-resize hover:bg-brand/10"
											onpointerdown={(p) => begin(p, { mode: 'resize', event: e })}
										></div>
									{/if}
								</div>
							{/each}
							{#if sameDay(d, now)}
								{@const top = px(now, d)}
								{#if top >= 0 && top <= height}
									<div
										class="pointer-events-none absolute z-10 h-px bg-brand"
										style:top="{top}px"
										style:left="calc({col} * 100% / {n})"
										style:width="calc(100% / {n})"
									>
										<span class="absolute -top-1 -left-1 size-2 rounded-full bg-brand"></span>
									</div>
								{/if}
							{/if}
						{/each}
						{#if preview && drag}
							<div
								class="pointer-events-none absolute z-30 rounded-md border-2 border-dashed border-brand bg-brand/15 opacity-50"
								style:top="{preview.top}px"
								style:height="{preview.h}px"
								style:left="calc({drag.col} * 100% / {n} + 2px)"
								style:width="calc(100% / {n} - 4px)"
							></div>
						{/if}
					</div>
				</div>
			</div>
		</div>
	{/if}
</div>
