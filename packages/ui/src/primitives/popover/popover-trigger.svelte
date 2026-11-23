<script lang="ts">
	import type { Snippet } from 'svelte';
	import { createAttachmentKey } from 'svelte/attachments';
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '../utils.js';
	import { get_popover_context } from './context.js';

	let {
		ref = $bindable(null),
		class: className,
		open_on_hover = false,
		open_delay = 150,
		close_delay = 150,
		child,
		children,
		onclick,
		...restProps
	}: WithElementRef<HTMLButtonAttributes, HTMLElement> & {
		/** Open on hover in addition to click. */
		open_on_hover?: boolean;
		/** Hover open delay in ms. */
		open_delay?: number;
		/** Hover close delay in ms. */
		close_delay?: number;
		/** Optional render delegation snippet receiving trigger props. */
		child?: Snippet<[{ props: Record<string, unknown> }]>;
		/** Trigger label content. */
		children?: Snippet;
	} = $props();

	const popover = get_popover_context();
	let hoverTimer: ReturnType<typeof setTimeout> | undefined;
	let fallbackEl = $state<HTMLElement | null>(null);

	$effect(() => {
		const el = ref ?? fallbackEl;
		if (el !== null) popover?.set_trigger(el);
		return () => {
			if (el !== null && popover?.trigger_el === el) popover.set_trigger(null);
		};
	});

	function handleClick(e: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement }): void {
		if (e.currentTarget instanceof HTMLElement && popover?.trigger_el !== e.currentTarget) {
			popover?.set_trigger(e.currentTarget);
		}
		popover?.set_open(!(popover?.open ?? false));
		onclick?.(e);
	}

	const triggerProps = $derived({
		[createAttachmentKey()]: (el: HTMLElement) => {
			fallbackEl = el;
			return () => {
				if (fallbackEl === el) fallbackEl = null;
			};
		},
		'data-slot': 'popover-trigger',
		'aria-haspopup': 'dialog' as const,
		'aria-expanded': popover?.open ?? false,
		'aria-controls': popover?.content_id,
		'data-state': popover?.open ? ('open' as const) : ('closed' as const),
		onclick: handleClick,
		onpointerenter: open_on_hover
			? () => {
					if (hoverTimer !== undefined) clearTimeout(hoverTimer);
					hoverTimer = setTimeout(() => popover?.set_open(true), open_delay);
				}
			: undefined,
		onpointerleave: open_on_hover
			? () => {
					if (hoverTimer !== undefined) clearTimeout(hoverTimer);
					hoverTimer = setTimeout(() => popover?.set_open(false), close_delay);
				}
			: undefined,
		...restProps
	});
</script>

{#if child}
	{@render child({ props: triggerProps })}
{:else}
	<button
		type="button"
		bind:this={ref}
		class={cn('', className)}
		{...triggerProps}
	>
		{@render children?.()}
	</button>
{/if}
