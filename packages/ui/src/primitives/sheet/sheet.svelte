<!--
@component
A panel sliding in from an edge over the page, with a heading, header actions and a close button. On a phone every sheet
is the same bottom drawer: rounded on top, its grabber dragged to resize it or tapped to expand it up to the shell's top
bar (`--shell-header-height`). On a wide screen a right sheet drags wider or narrower by its left edge and goes full
screen from its header.
-->
<script lang="ts" module>
	import type { Snippet } from 'svelte';

	/** The props of `Sheet`: `open`, the side, the title or header, actions and body. */
	export type SheetProps = {
		open?: boolean;
		onOpenChange?: (open: boolean) => void;
		side?: 'left' | 'right';
		/** The heading and accessible name. */
		title?: string;
		/** Replaces the heading (a record label with badges); the close button stays. */
		header?: Snippet;
		/** Header content beside the close button (record actions). */
		actions?: Snippet;
		children: Snippet;
		class?: string;
	};

	// one width for every right sheet in this tab (staging's persisted detail width), dragged by the left edge
	const WIDTH = 'ui.sheet.width';
	const remembered = (): number | null => {
		try { const n = Number(sessionStorage.getItem(WIDTH)); return n > 0 ? n : null; } catch { return null; }
	};
</script>

<script lang="ts">
	import { setContext } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { watch } from 'runed';
	import { resetInset } from '../../layout/inset.svelte.js';
	import { TAB_LEVEL } from '../tabs/level.js';
	import { cn, uiText } from '../utils.js';
	import { escapes, openSheets } from './dismiss.js';

	let { open = $bindable(false), onOpenChange, side = 'right', title, header, actions, children, class: className }: SheetProps = $props();
	const t = uiText();
	const me = {};
	// hook:view-ui — a record view inside claims this header for its label, pills and actions: one header, not two
	let claimed = $state<Snippet | null>(null);
	setContext(Symbol.for('ui.sheet.header'), (s: Snippet | null) => (claimed = s));
	// hook:view-ui — the record's toggle (beside full screen) and history scrubber (the header's lower edge)
	let chrome = $state<{ tools: Snippet; timeline: Snippet } | null>(null);
	setContext(Symbol.for('ui.sheet.chrome'), (c: { tools: Snippet; timeline: Snippet } | null) => (chrome = c));
	// an overlay is a new page edge, a new tab hierarchy and a new record frame (an opener's carried record is not a parent)
	resetInset(true);
	setContext(TAB_LEVEL, undefined);
	setContext('ui.views.record', undefined);

	const close = () => {
		open = false;
		onOpenChange?.(false);
	};
	watch(() => open, (isOpen) => {
		if (!isOpen) return;
		openSheets.push(me);
		return () => void openSheets.splice(openSheets.indexOf(me), 1);
	});

	const right = $derived(side === 'right');
	const wide = new MediaQuery('min-width: 48rem');
	let full = $state(false);
	let width = $state<number | null>(remembered());
	let height = $state<number | null>(null);
	let panel = $state<HTMLElement | null>(null);
	// a right sheet never covers the workspace sidebar: the shell publishes its width as `--shell-sidebar-width`
	function sidebar(): number {
		if (panel === null) return 0;
		const v = getComputedStyle(panel).getPropertyValue('--shell-sidebar-width').trim(), n = parseFloat(v) || 0;
		return v.endsWith('rem') ? n * parseFloat(getComputedStyle(document.documentElement).fontSize) : n;
	}
	const clamp = (w: number) => Math.round(Math.min(Math.max(w, 300), innerWidth * 0.9, innerWidth - sidebar()));
	const keep = (w: number) => { width = clamp(w); try { sessionStorage.setItem(WIDTH, String(width)); } catch { /* this sheet still has it */ } };
	function drag(e: PointerEvent) {
		if (e.button !== 0 || panel === null) return;
		e.preventDefault();
		const x0 = e.clientX, w0 = panel.offsetWidth;
		const move = (m: PointerEvent) => { width = clamp(w0 + x0 - m.clientX); };
		const up = () => {
			removeEventListener('pointermove', move); removeEventListener('pointerup', up);
			document.body.style.cursor = document.body.style.userSelect = '';
			if (width !== null) keep(width);
		};
		document.body.style.cursor = 'ew-resize';
		document.body.style.userSelect = 'none';
		addEventListener('pointermove', move);
		addEventListener('pointerup', up);
	}
	// the phone drawer's grabber: a drag sets its height, up to the shell's top bar (below a quarter of the screen closes
	// it); a tap (its click, unless it dragged) expands it
	let dragged = false;
	function lift(e: PointerEvent) {
		if (e.button !== 0 || panel === null) return;
		const y0 = e.clientY, h0 = panel.offsetHeight;
		const max = innerHeight - (parseFloat(getComputedStyle(panel).getPropertyValue('--shell-header-height')) || 0);
		dragged = false;
		const move = (m: PointerEvent) => {
			if (!dragged && Math.abs(m.clientY - y0) < 4) return;
			dragged = true;
			full = false;
			height = Math.round(Math.min(Math.max(h0 + y0 - m.clientY, 120), max));
		};
		const up = () => {
			removeEventListener('pointermove', move); removeEventListener('pointerup', up);
			document.body.style.userSelect = '';
			if (dragged && height !== null && height < innerHeight / 4) { height = null; close(); }
		};
		document.body.style.userSelect = 'none';
		addEventListener('pointermove', move);
		addEventListener('pointerup', up);
	}
	function nudge(e: KeyboardEvent) {
		if (panel === null || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
		e.preventDefault();
		keep(panel.offsetWidth + (e.key === 'ArrowLeft' ? 24 : -24));
	}
</script>

<!-- Esc is the × button's close; it consumes the key, so one Esc closes one sheet (a sheet below, whose listener runs
	after this close has flushed, sees a handled key) -->
<svelte:window onkeydown={(e) => { if (open && escapes(e, me)) { e.preventDefault(); close(); } }} />

{#if open}
	<!-- non-modal on a wide screen: no backdrop, no focus trap, no scroll lock; the page behind stays clickable and typeable.
	     A phone's drawer has no ×: a tap outside it (this scrim) or a swipe down on its grabber dismisses it -->
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div data-sheet-scrim class="fixed inset-0 z-40 bg-black/40 md:hidden" onclick={close}></div>
	<div
		bind:this={panel}
		role="dialog"
		aria-modal="false"
		aria-label={title}
		data-sheet-side={side}
		data-fullscreen={full || undefined}
		style={[right && !full && width !== null ? `--sheet-w:${width}px` : '', !full && height !== null ? `--sheet-h:${height}px` : ''].join(';') || undefined}
		class={cn(
			// a phone: one bottom drawer for every side, its top corners a squircle, never above the shell's top bar
			'bg-popover text-popover-foreground fixed inset-x-0 bottom-0 z-40 flex max-h-[calc(100dvh-var(--shell-header-height,env(safe-area-inset-top)))] min-w-0 flex-col rounded-t-[1.25rem] border-t pb-[env(safe-area-inset-bottom)] shadow-lg [corner-shape:squircle]',
			full ? 'h-[calc(100dvh-var(--shell-header-height,env(safe-area-inset-top)))] rounded-none' : 'h-[var(--sheet-h,min(90dvh,48rem))]',
			'md:max-h-full md:rounded-none md:border-t-0 md:pb-0 md:inset-y-0 md:h-full',
			right
				? full ? 'md:right-0 md:left-[var(--shell-sidebar-width,0px)] md:w-auto'
					: 'md:right-0 md:left-auto md:w-[var(--sheet-w,min(40rem,90vw))] md:max-w-[min(90vw,calc(100vw-var(--shell-sidebar-width,0px)))] md:border-l'
				: 'md:right-auto md:left-0 md:w-[min(40rem,90vw)] md:border-r',
			className
		)}
	>
		<!-- a phone's drawer: its grabber, centred on the top border (it takes no space), is dragged to resize it and tapped to
		     expand it; expanded, the drawer is square and flush with the top bar -->
		<button type="button" data-sheet-grabber aria-label={t('resize')}
			class="group/grab absolute inset-x-0 top-0 z-10 mx-auto flex h-4 w-16 -translate-y-1/2 cursor-row-resize touch-none items-center justify-center [--hit-target:0px] outline-none md:hidden"
			onpointerdown={lift} onclick={() => { if (!dragged) { full = !full; height = null; } dragged = false; }}>
			<span class="bg-muted-foreground/70 group-focus-visible/grab:bg-ring h-1 w-10 rounded-full shadow-sm"></span>
		</button>
		{#if right && !full}
			<!-- the resize handle: a pill on the left edge (wide screens), dragged or moved with the arrow keys -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
			<div role="separator" aria-orientation="vertical" aria-label={t('resize')} tabindex="0" data-sheet-resize
				class="group/resize absolute inset-y-0 -left-2 z-10 hidden w-4 cursor-ew-resize touch-none items-center justify-center outline-none md:flex"
				onpointerdown={drag} onkeydown={nudge}>
				<span class="bg-border group-hover/resize:bg-input group-focus-visible/resize:bg-ring h-12 w-1.5 rounded-full transition-colors duration-150"></span>
			</div>
		{/if}
		<header class="flex shrink-0 flex-wrap items-center gap-x-2 border-b px-4 py-3">
			<div class="min-w-0 flex-1">
				{#if header}{@render header()}{:else if claimed}{@render claimed()}{:else if title}<h2 class="text-heading truncate">{title}</h2>{/if}
			</div>
			{@render actions?.()}
			{@render chrome?.tools()}
			<!-- a right sheet's full screen on a wide screen; every drawer's expand on a phone -->
			{#if right || !wide.current}
				<button
					type="button"
					data-sheet-fullscreen
					aria-pressed={full}
					aria-label={full ? t('exitFullScreen') : t('fullScreen')}
					title={full ? t('exitFullScreen') : t('fullScreen')}
					onclick={() => (full = !full)}
					class="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/40 grid size-8 shrink-0 place-items-center rounded-md focus-visible:ring-2 focus-visible:outline-none"
				>
					<svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						{#if full}<path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />
						{:else}<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />{/if}
					</svg>
				</button>
			{/if}
			<button
				type="button"
				data-sheet-close
				aria-label={t('close')}
				onclick={close}
				class="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/40 hidden size-8 md:grid shrink-0 place-items-center rounded-md focus-visible:ring-2 focus-visible:outline-none"
			>
				<svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
			</button>
			{#if chrome}<div class="mt-1 -mb-2.5 basis-full empty:hidden">{@render chrome.timeline()}</div>{/if}
		</header>
		<div class="min-h-0 flex-1 overflow-auto p-4" data-sheet-body>{@render children()}</div>
	</div>
{/if}
