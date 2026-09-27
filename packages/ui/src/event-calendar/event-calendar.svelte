<!--
@component
Events on a day, week or month grid: timed boxes, all-day bars, month pills; dragging creates, moves and resizes, and the caller writes the change.
-->
<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { CalendarEvent, CalendarView, CreateSlot, EventRenderContext } from './calendar.js';

	/**
	 * Events on a day, week or month grid. Timed events are boxes placed by the clock (overlaps share the column in
	 * lanes); all-day and multi-day events are bars above the grid; a month cell shows three pills and "+N more".
	 * Unless `readonly`, dragging an empty slot creates, dragging a box moves it (across days in the week) and its
	 * lower edge resizes it; the calendar only reports: the caller writes and hands back new `events`.
	 */
	export type EventCalendarProps = {
		events: readonly CalendarEvent[];
		view?: CalendarView;
		views?: readonly CalendarView[];
		/** The day shown first; navigation moves away from it until it changes. */
		date?: Date;
		startHour?: number;
		endHour?: number;
		/** Pixels per hour on the time grid. */
		hourHeight?: number;
		snapMinutes?: number;
		/** The narrowest a week column gets before the grid scrolls sideways. */
		colWidth?: number;
		readonly?: boolean;
		onViewChange?(view: CalendarView): void;
		onDateChange?(date: Date): void;
		onEventClick?(event: CalendarEvent): void;
		onEventCreate?(slot: CreateSlot): void;
		onEventMove?(event: CalendarEvent, start: Date, end: Date): void;
		/** An event's body in place of its title (and time, on a box). */
		eventContent?: Snippet<[CalendarEvent, EventRenderContext]>;
		class?: string;
	};
</script>

<script lang="ts">
	import Icon from '@iconify/svelte';
	import { useKinds } from '../kinds/context.js';
	import { cn, uiText } from '../primitives/utils.js';
	import { addDays, clock, isTimed, isWeekend, lanes, monthGrid, onDay, sameDay, step, viewStart } from './calendar.js';

	let {
		events, view = 'week', views = ['day', 'week', 'month'], date, startHour = 0, endHour = 24, hourHeight = 56, snapMinutes = 15,
		colWidth = 110, readonly = false, onViewChange, onDateChange, onEventClick, onEventCreate, onEventMove, eventContent, class: className
	}: EventCalendarProps = $props();
	const locale = useKinds().locale;
	const t = uiText();
	let shown = $derived(view);
	let at = $derived(date ?? new Date());
	let now = $state(new Date());
	$effect(() => { const timer = setInterval(() => (now = new Date()), 60_000); return () => clearInterval(timer); });

	const first = $derived(viewStart(shown, at));
	const days = $derived(shown === 'day' ? [first] : Array.from({ length: 7 }, (_, i) => addDays(first, i)));
	const n = $derived(days.length);
	const height = $derived((endHour - startHour) * hourHeight);
	const title = $derived.by(() => {
		const year = at.getFullYear() !== now.getFullYear() ? 'numeric' : undefined;
		if (shown === 'month') return at.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
		if (shown === 'day') return at.toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric', year });
		return `${first.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} – ${addDays(first, 6).toLocaleDateString(locale, { month: 'short', day: 'numeric', year })}`;
	});
	const go = (d: Date) => { at = d; onDateChange?.(d); };
	const pick = (v: CalendarView) => { shown = v; onViewChange?.(v); };

	// ── time grid ──
	const px = (d: Date, day: Date) => ((d.getTime() - new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()) / 60_000 - startHour * 60) * hourHeight / 60;
	const timed = $derived(days.map((d) => events.filter((e) => isTimed(e) && sameDay(e.start, d))));
	const laneOf = $derived(timed.map(lanes));
	/** All-day and multi-day bars over the shown days, stacked in rows. */
	const bars = $derived.by(() => {
		const last = addDays(first, n);
		const rows: number[] = [];
		return events.filter((e) => !isTimed(e) && e.start < last && e.end > first).sort((a, b) => a.start.getTime() - b.start.getTime()).map((e) => {
			const from = Math.max(0, days.findIndex((d) => sameDay(d, e.start) || d > e.start));
			const to = n - 1 - [...days].reverse().findIndex((d) => d < e.end || sameDay(d, e.end));
			let row = rows.findIndex((free) => free <= from);
			if (row === -1) row = rows.length;
			rows[row] = to + 1;
			return { e, from, span: Math.max(1, to - from + 1), row };
		});
	});
	const barRows = $derived(Math.min(6, Math.max(0, ...bars.map((b) => b.row + 1))));

	type Drag = { mode: 'create' | 'move' | 'resize'; event?: CalendarEvent; col: number; y0: number; y: number; top: number; h: number; moved: boolean };
	let drag = $state<Drag | null>(null);
	let grid = $state<HTMLElement | null>(null);
	const snap = (y: number) => Math.round(y / (hourHeight * snapMinutes / 60)) * (hourHeight * snapMinutes / 60);
	const toDate = (col: number, y: number) => {
		const d = new Date(days[col]!);
		d.setHours(0, startHour * 60 + Math.round(snap(y) / hourHeight * 60), 0, 0);
		return d;
	};
	const point = (e: PointerEvent) => {
		const r = grid!.getBoundingClientRect();
		return { col: Math.min(n - 1, Math.max(0, Math.floor((e.clientX - r.left) / (r.width / n)))), y: Math.min(height, Math.max(0, e.clientY - r.top)) };
	};
	function begin(e: PointerEvent, mode: Drag['mode'], event?: CalendarEvent) {
		if (e.button !== 0 || grid === null) return;
		e.stopPropagation();
		e.preventDefault(); // no text selection or native drag, which would cancel the pointer
		const p = point(e);
		const locked = readonly || event?.editable === false;
		if (locked && mode !== 'move') return;
		const col = event === undefined ? p.col : days.findIndex((d) => sameDay(d, event.start));
		const top = event === undefined ? snap(p.y) : px(event.start, days[col]!);
		drag = { mode, event, col, y0: p.y, y: p.y, top, h: event === undefined ? 0 : px(event.end, days[col]!) - top, moved: false };
		const move = (m: PointerEvent) => {
			if (drag === null) return;
			const q = point(m);
			const moved = drag.moved || Math.abs(q.y - drag.y0) > 3 || (drag.mode === 'move' && q.col !== drag.col);
			drag = { ...drag, y: q.y, moved, col: drag.mode === 'move' && !locked && shown === 'week' ? q.col : drag.col };
		};
		const up = (u: PointerEvent) => {
			removeEventListener('pointermove', move);
			removeEventListener('pointerup', up);
			removeEventListener('pointercancel', up);
			const d = drag;
			drag = null;
			if (d === null || u.type === 'pointercancel') return;
			if (!d.moved) { if (d.event !== undefined) onEventClick?.(d.event); return; }
			if (locked) return;
			const r = rect(d)!;
			const start = toDate(d.col, r.top), end = toDate(d.col, r.top + r.h);
			if (end <= start) return;
			if (d.mode === 'create') onEventCreate?.({ start, end });
			else onEventMove?.(d.event!, start, end);
		};
		addEventListener('pointermove', move);
		addEventListener('pointerup', up);
		addEventListener('pointercancel', up);
	}
	/** The drop preview: where the box would land. */
	function rect(d: Drag): { top: number; h: number } | null {
		const dy = d.y - d.y0;
		if (d.mode === 'create') return { top: snap(Math.min(d.y0, d.y)), h: Math.max(snap(Math.abs(dy)), hourHeight * snapMinutes / 60) };
		if (d.mode === 'move') return { top: snap(d.top + dy), h: d.h };
		return { top: d.top, h: Math.max(hourHeight * snapMinutes / 60, snap(d.h + dy)) };
	}
	const preview = $derived(drag?.moved === true && !readonly && drag.event?.editable !== false ? rect(drag) : null);

	// ── month ──
	const cells = $derived(monthGrid(at));
	const MAX_PILLS = 3;
	const weekdays = $derived(Array.from({ length: 7 }, (_, i) => addDays(new Date(2024, 0, 1), i).toLocaleDateString(locale, { weekday: 'short' })));
</script>

{#snippet body(e: CalendarEvent, mode: EventRenderContext['mode'])}
	{#if eventContent}{@render eventContent(e, { view: shown, mode })}
	{:else}
		<span class="block truncate text-micro font-semibold leading-tight text-foreground">{e.title}</span>
		{#if mode === 'box'}<span class="block truncate font-mono text-tiny tabular-nums text-muted-foreground">{clock(e.start)} – {clock(e.end)}</span>{/if}
	{/if}
{/snippet}

<div class={cn('flex h-full min-h-96 flex-col overflow-hidden rounded-lg border bg-card shadow-card', className)} data-event-calendar={shown}>
	<header class="flex items-center justify-between gap-2 border-b px-4 py-2.5">
		<div class="flex items-center gap-1">
			<button type="button" class="grid size-8 place-items-center rounded-sm hover:bg-accent" aria-label={t('previous')} onclick={() => go(step(shown, at, -1))}><Icon icon="lucide:chevron-left" class="size-4" /></button>
			<button type="button" class="h-7 rounded-sm px-2.5 text-xs font-medium hover:bg-accent" onclick={() => go(new Date())}>{t('today')}</button>
			<button type="button" class="grid size-8 place-items-center rounded-sm hover:bg-accent" aria-label={t('next')} onclick={() => go(step(shown, at, 1))}><Icon icon="lucide:chevron-right" class="size-4" /></button>
			<span class="ml-2 text-sm font-semibold select-none">{title}</span>
		</div>
		{#if views.length > 1}
			<div class="flex rounded-sm border bg-muted/40 p-0.5" role="tablist">
				{#each views as v (v)}
					<button type="button" role="tab" aria-selected={v === shown} onclick={() => pick(v)}
						class={cn('rounded-sm px-3 py-1 text-xs font-medium', v === shown ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground')}>{t(v)}</button>
				{/each}
			</div>
		{/if}
	</header>

	{#if shown === 'month'}
		<div class="grid grid-cols-7 border-b text-center">
			{#each weekdays as w (w)}<span class="py-1.5 text-overline text-muted-foreground">{w}</span>{/each}
		</div>
		<div class="grid min-h-0 flex-1 grid-cols-7 gap-px bg-border/60 p-px" style:grid-template-rows="repeat({cells.length / 7}, minmax(6rem, 1fr))">
			{#each cells as d (d.getTime())}
				{@const list = onDay(events, d)}
				<div class={cn('flex min-w-0 flex-col gap-0.5 overflow-hidden bg-background p-1', d.getMonth() !== at.getMonth() && 'opacity-40', isWeekend(d) && 'bg-muted/20')} data-day={d.getDate()}>
					<button type="button" class={cn('grid size-6.5 place-items-center self-start rounded-full text-xs font-semibold hover:bg-accent', sameDay(d, now) && 'bg-brand text-brand-foreground hover:bg-brand')}
						onclick={() => go(d)}>{d.getDate()}</button>
					{#each list.slice(0, MAX_PILLS) as e (e.id)}
						<button type="button" class="flex min-w-0 items-center gap-1 rounded-full bg-muted/60 px-1.5 py-0.5 text-left hover:brightness-95" onclick={() => onEventClick?.(e)} data-event={e.id}>
							<span class="size-1.25 shrink-0 rounded-full" style:background={e.color ?? 'var(--color-brand)'}></span>
							<span class="min-w-0 flex-1">{@render body(e, 'pill')}</span>
						</button>
					{/each}
					{#if list.length > MAX_PILLS}<span class="px-1.5 text-tiny font-medium text-muted-foreground">{t('more').replace('{n}', String(list.length - MAX_PILLS))}</span>{/if}
				</div>
			{/each}
		</div>
	{:else}
		<div class="min-h-0 flex-1 overflow-auto">
			<div class="relative" style:min-width="calc(3.5rem + {n * colWidth}px)">
				<!-- the day headings and the all-day band stay pinned above the scrolling grid -->
				<div class="sticky top-0 z-20 border-b bg-card">
					<div class="flex">
						<div class="w-14 shrink-0"></div>
						{#each days as d (d.getTime())}
							<div class={cn('flex flex-1 flex-col items-center py-1.5', isWeekend(d) && 'bg-muted/25')}>
								<span class={cn('text-xs font-medium', sameDay(d, now) ? 'text-brand-700' : 'text-muted-foreground')}>{d.toLocaleDateString(locale, { weekday: 'short' })}</span>
								<span class={cn('grid size-6.5 place-items-center rounded-full text-sm font-semibold', sameDay(d, now) && 'bg-brand text-brand-foreground')}>{d.getDate()}</span>
							</div>
						{/each}
					</div>
					{#if barRows > 0}
						<div class="relative ml-14 border-t" style:height="{barRows * 22 + 4}px">
							{#each bars.filter((b) => b.row < barRows) as b (b.e.id)}
								<button type="button" class="absolute flex h-5 items-center gap-1 rounded-full bg-muted/60 px-2 text-left" data-event={b.e.id}
									style:left="calc({b.from} * 100% / {n} + 2px)" style:width="calc({b.span} * 100% / {n} - 4px)" style:top="{b.row * 22 + 2}px"
									onclick={() => onEventClick?.(b.e)}>
									<span class="size-1.25 shrink-0 rounded-full" style:background={b.e.color ?? 'var(--color-brand)'}></span>
									<span class="min-w-0 flex-1">{@render body(b.e, 'bar')}</span>
								</button>
							{/each}
						</div>
					{/if}
				</div>
				<div class="flex">
					<div class="sticky left-0 z-10 w-14 shrink-0 bg-card select-none" style:height="{height}px">
						<!-- each label centred on its hour line; the first sits below the top edge -->
						{#each Array.from({ length: endHour - startHour }, (_, i) => i) as i (i)}
							<span class="absolute right-2 font-mono text-tiny leading-none text-muted-foreground tabular-nums {i > 0 ? '-translate-y-1/2' : ''}"
								style:top="{i * hourHeight + (i === 0 ? 2 : 0)}px">{String(startHour + i).padStart(2, '0')}:00</span>
						{/each}
					</div>
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div bind:this={grid} class={cn('relative flex-1 touch-none select-none', !readonly && 'cursor-crosshair')} style:height="{height}px"
						style:background-image="repeating-linear-gradient(to bottom, var(--color-border) 0 1px, transparent 1px {hourHeight}px)"
						onpointerdown={(e) => !readonly && begin(e, 'create')}>
						{#each days as d, col (d.getTime())}
							<div class={cn('pointer-events-none absolute inset-y-0 border-l border-border/60', isWeekend(d) && 'bg-muted/25', sameDay(d, now) && !isWeekend(d) && 'bg-brand-50/15')}
								style:left="calc({col} * 100% / {n})" style:width="calc(100% / {n})"></div>
							{#each timed[col] as e (e.id)}
								{@const l = laneOf[col]!.get(e.id) ?? { lane: 0, of: 1 }}
								{@const top = px(e.start, d)}
								{@const editable = !readonly && e.editable !== false}
								<div class={cn('absolute overflow-hidden rounded-md border bg-card text-left shadow-xs transition-shadow hover:shadow-sm', editable ? 'cursor-grab active:cursor-grabbing' : 'cursor-default opacity-70',
										drag?.event?.id === e.id && drag.moved && 'opacity-40')}
									style:top="{top}px" style:height="{Math.max(12, px(e.end, d) - top)}px"
									style:left="calc(({col} + {l.lane / l.of}) * 100% / {n} + 2px)" style:width="calc(100% / {n * l.of} - 4px)"
									role="button" tabindex="0" title={editable ? undefined : e.lockedReason} data-event={e.id}
									onpointerdown={(p) => begin(p, 'move', e)}
									onkeydown={(k) => { if (k.key === 'Enter' || k.key === ' ') { k.preventDefault(); onEventClick?.(e); } }}>
									<div class="h-0.75" style:background={e.color ?? 'var(--color-brand)'}></div>
									<div class="min-w-0 px-1.5 py-1">{@render body(e, 'box')}</div>
									{#if editable}
										<!-- svelte-ignore a11y_no_static_element_interactions -->
										<div class="absolute inset-x-0 bottom-0 h-2.5 cursor-s-resize hover:bg-brand/10" onpointerdown={(p) => begin(p, 'resize', e)}></div>
									{/if}
								</div>
							{/each}
							{#if sameDay(d, now)}
								{@const top = px(now, d)}
								{#if top >= 0 && top <= height}
									<div class="pointer-events-none absolute z-10 h-px bg-brand" style:top="{top}px" style:left="calc({col} * 100% / {n})" style:width="calc(100% / {n})">
										<span class="absolute -top-1 -left-1 size-2 rounded-full bg-brand"></span>
									</div>
								{/if}
							{/if}
						{/each}
						{#if preview && drag}
							<div class="pointer-events-none absolute z-30 rounded-md border-2 border-dashed border-brand bg-brand-50 opacity-50"
								style:top="{preview.top}px" style:height="{preview.h}px" style:left="calc({drag.col} * 100% / {n} + 2px)" style:width="calc(100% / {n} - 4px)"></div>
						{/if}
					</div>
				</div>
			</div>
		</div>
	{/if}
</div>
