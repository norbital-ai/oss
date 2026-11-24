<!--
@component
A tooltip on hover or focus of its trigger, with a text or snippet body; where nothing hovers, a tap opens it as a popover.
-->
<script lang="ts" module>
	const WARM_MS = 250;
	let activeTooltip: { close: () => void } | null = null;
	let lastClosedAt = 0;
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { FloatingAlign, FloatingSide } from '../../behaviors/index.js';
	import * as Popover from '../popover/index.js';
	import { cn, noHover } from '../utils.js';
	import Content from './tooltip-content.svelte';

	let {
		open: controlledOpen = $bindable(),
		delay_duration = 100,
		disabled = false,
		ignore_non_keyboard_focus = false,
		side = 'top',
		side_offset = 4,
		align = 'center',
		avoid_collisions = true,
		collision_padding = 8,
		text,
		content_class,
		arrow_classes: _arrowClasses,
		trigger,
		content,
		on_open_change,
		on_open_change_complete,
		disable_hoverable_content = false,
		disable_close_on_trigger_click = false
	}: {
		/** Controlled open state; bindable. */
		open?: boolean;
		/** Hover open delay in ms. */
		delay_duration?: number;
		/** When true, renders the trigger without a tooltip. */
		disabled?: boolean;
		/** Only open on keyboard `:focus-visible`, not pointer clicks. */
		ignore_non_keyboard_focus?: boolean;
		/** The trigger's side it opens on; default `top`. */
		side?: FloatingSide;
		/** The gap from the trigger, in px; default 4. */
		side_offset?: number;
		/** Its alignment along that side: `start`, `center` or `end`. */
		align?: FloatingAlign;
		/** Flip/shift the content to keep it on screen (default `true`). */
		avoid_collisions?: boolean;
		/** The viewport gutter kept while avoiding collisions, in px; default 8. */
		collision_padding?: number;
		/** Simple string body. Prefer `content` for richer markup. */
		text?: string | undefined;
		/** Classes on the content surface. */
		content_class?: string;
		/** Kept for compatibility with arrow-styled callers. */
		arrow_classes?: string;
		/** The element it describes; spread the given `props` onto it. */
		trigger: Snippet<[{ props: Record<string, unknown> }]>;
		/** A rich body, in place of `text`. */
		content?: Snippet;
		/** Called as it opens or closes. */
		on_open_change?: (open: boolean) => void;
		/** Called once open or close settles. */
		on_open_change_complete?: (open: boolean) => void;
		/** Close immediately as the pointer leaves the trigger. */
		disable_hoverable_content?: boolean;
		/** Keep an open tooltip open when clicking the trigger. */
		disable_close_on_trigger_click?: boolean;
	} = $props();

	const hasBody = $derived(Boolean(text) || Boolean(content));
	let internalOpen = $state(false);
	let anchorEl = $state<HTMLElement | null>(null);
	let openTimer: ReturnType<typeof setTimeout> | undefined;
	let closeTimer: ReturnType<typeof setTimeout> | undefined;

	const open = $derived(controlledOpen ?? internalOpen);
	const handle = {
		close() {
			clearTimers();
			setOpen(false);
		}
	};

	function clearTimers(): void {
		if (openTimer !== undefined) {
			clearTimeout(openTimer);
			openTimer = undefined;
		}
		if (closeTimer !== undefined) {
			clearTimeout(closeTimer);
			closeTimer = undefined;
		}
	}

	function setOpen(next: boolean): void {
		if (next === open) return;
		if (next && controlledOpen === undefined) {
			if (activeTooltip !== null && activeTooltip !== handle) activeTooltip.close();
			activeTooltip = handle;
		} else if (!next && activeTooltip === handle) {
			activeTooltip = null;
			lastClosedAt = Date.now();
		}
		if (controlledOpen !== undefined) controlledOpen = next;
		internalOpen = next;
		on_open_change?.(next);
		queueMicrotask(() => on_open_change_complete?.(next));
	}

	function scheduleOpen(): void {
		clearTimers();
		const warm = activeTooltip !== null || Date.now() - lastClosedAt < WARM_MS;
		if (delay_duration <= 0 || warm) {
			setOpen(true);
		} else {
			openTimer = setTimeout(() => {
				openTimer = undefined;
				setOpen(true);
			}, delay_duration);
		}
	}

	function scheduleClose(): void {
		clearTimers();
		if (disable_hoverable_content) {
			setOpen(false);
		} else {
			closeTimer = setTimeout(() => {
				closeTimer = undefined;
				setOpen(false);
			}, 80);
		}
	}

	$effect(() => () => {
		clearTimers();
		if (activeTooltip === handle) activeTooltip = null;
	});

	$effect(() => {
		if (!open || noHover.current || typeof document === 'undefined') return;
		const onKeydown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setOpen(false);
		};
		document.addEventListener('keydown', onKeydown);
		return () => document.removeEventListener('keydown', onKeydown);
	});

	const hoverTriggerProps = $derived({
		onpointerenter: (e: PointerEvent) => {
			if (e.pointerType === 'touch') return;
			if (e.currentTarget instanceof HTMLElement) anchorEl = e.currentTarget;
			scheduleOpen();
		},
		onpointerleave: (e: PointerEvent) => {
			if (e.pointerType === 'touch') return;
			scheduleClose();
		},
		onfocus: (e: FocusEvent) => {
			if (e.currentTarget instanceof HTMLElement) {
				anchorEl = e.currentTarget;
				if (ignore_non_keyboard_focus && !e.currentTarget.matches(':focus-visible')) return;
			}
			setOpen(true);
		},
		onblur: () => setOpen(false),
		onclick: () => {
			if (!disable_close_on_trigger_click) setOpen(false);
		},
		onkeydown: (e: KeyboardEvent) => {
			if (e.key === 'Escape') setOpen(false);
		}
	});
</script>

{#snippet body()}
	{#if content}
		{@render content()}
	{:else}
		<p>{text}</p>
	{/if}
{/snippet}

{#if disabled || !hasBody}
	{@render trigger({ props: {} })}
{:else if noHover.current}
	<Popover.Root
		bind:open={() => open, (next) => setOpen(next)}
		{on_open_change}
		{on_open_change_complete}
	>
		<Popover.Trigger>
			{#snippet child({ props })}
				<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
				<span
					class="contents has-[>:disabled,>[aria-disabled=true]]:inline-flex [&>:disabled]:pointer-events-none"
					onclick={(e) => {
						if (e.target === e.currentTarget) setOpen(!open);
					}}
				>
					{@render trigger({ props: { ...props, onkeydown: undefined } })}
				</span>
			{/snippet}
		</Popover.Trigger>
		<Popover.Content
			{side}
			{side_offset}
			{align}
			{avoid_collisions}
			{collision_padding}
			trap_focus={false}
			on_open_auto_focus={(e: Event) => e.preventDefault()}
			class={cn(
				'max-w-[min(20rem,calc(100vw-1rem))] px-3 py-1.5 text-xs leading-snug text-pretty [overflow-wrap:anywhere]',
				// repository-health:allow UI25 -- pass-through of the caller's `content_class` prop; its tokens are literal at the call site
				content_class
			)}
		>
			{@render body()}
		</Popover.Content>
	</Popover.Root>
{:else}
	{@render trigger({ props: hoverTriggerProps })}
	<Content
		{open}
		anchor={anchorEl}
		{side}
		{side_offset}
		{align}
		{avoid_collisions}
		{collision_padding}
		on_pointer_enter={disable_hoverable_content ? undefined : scheduleOpen}
		on_pointer_leave={disable_hoverable_content ? undefined : scheduleClose}
		class={/* repository-health:allow UI25 -- pass-through of the caller's `content_class` prop; its tokens are literal at the call site */ content_class}
	>
		{@render body()}
	</Content>
{/if}
