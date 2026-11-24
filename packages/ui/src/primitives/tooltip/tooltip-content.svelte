<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import {
		create_floating,
		portal,
		type FloatingAlign,
		type FloatingSide
	} from '../../behaviors/index.js';
	import { cn, type WithElementRef } from '../utils.js';

	let {
		ref = $bindable(null),
		open = false,
		anchor = null,
		class: className,
		side_offset = 4,
		side = 'top',
		align = 'center',
		avoid_collisions = true,
		collision_padding = 8,
		on_pointer_enter,
		on_pointer_leave,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>, HTMLDivElement> & {
		/** Whether the tooltip bubble is visible. */
		open?: boolean;
		/** Anchor element the tooltip floats beside. */
		anchor?: HTMLElement | null;
		/** Preferred side (default `'top'`). */
		side?: FloatingSide;
		/** Cross-axis alignment (default `'center'`). */
		align?: FloatingAlign;
		/** Gap from the anchor in px. */
		side_offset?: number;
		/** Flip/shift to stay on screen. */
		avoid_collisions?: boolean;
		/** Viewport gutter in px. */
		collision_padding?: number;
		/** Keep open while hovering content. */
		on_pointer_enter?: () => void;
		/** Close after leaving content. */
		on_pointer_leave?: () => void;
		/** Tooltip body content. */
		children?: Snippet;
	} = $props();

	const floating = create_floating({
		open: () => open,
		anchor: () => anchor,
		side: () => side,
		align: () => align,
		side_offset: () => side_offset,
		padding: () => collision_padding,
		flip: () => avoid_collisions,
		escape: false,
		outside: false
	});
</script>

{#if open}
	<div {@attach portal()} class="contents">
		<div
			bind:this={ref}
			role="tooltip"
			{@attach floating.content}
			data-slot="tooltip-content"
			data-state="open"
			data-side={floating.side}
			data-positioned={floating.positioned ? 'true' : undefined}
			style={floating.style}
			onpointerenter={on_pointer_enter}
			onpointerleave={on_pointer_leave}
			class={cn(
				'z-50 w-fit max-w-[min(20rem,calc(100vw-1rem))] origin-[var(--floating-origin-x,50%)_var(--floating-origin-y,50%)] rounded-control bg-primary px-3 py-1.5 text-xs leading-snug text-pretty [overflow-wrap:anywhere] text-primary-foreground animation-duration-150 ease-spring motion-reduce:animate-none data-[positioned=true]:animate-in data-[positioned=true]:fade-in-0 data-[positioned=true]:zoom-in-95',
				!on_pointer_enter && !on_pointer_leave && 'pointer-events-none',
				className
			)}
			{...restProps}
		>
			{@render children?.()}
		</div>
	</div>
{/if}
