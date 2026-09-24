<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement, LayoutPad } from '#lib/layout/layout.shared';

	export type BoundSize = 'compact' | 'standard' | 'tall' | 'fit' | 'full' | 'auto';
	export interface BoundProps extends LayoutAttributes {
		as?: LayoutElement;
		/**
		 * The named height contract. `compact`/`standard`/`tall` are fixed panes;
		 * `fit` tracks the viewer: `min(42rem, 100dvh − 14rem)` with a `standard` floor, so a
		 * scrollport claims the space below a ~14rem chrome band instead of guessing a pane size;
		 * `full` fills whatever definite height the parent grants; `auto` is content height — a clip
		 * or inset boundary with no height contract of its own.
		 */
		size?: BoundSize;
		pad?: LayoutPad;
		inset?: boolean;
		clip?: boolean;
		/** Take the remaining space along the parent's main axis. */
		grow?: boolean;
		/** Allow this region to shrink when its parent is constrained. */
		shrink?: boolean;
		children: Snippet;
	}
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import { cn } from '#lib/utils';
	import { INSET_CLASS, PAD_CLASSES } from '#lib/layout/layout.shared';
	import { ownInset } from '#lib/layout/inset.svelte';

	let {
		as = 'div',
		ref = $bindable(null),
		size = 'standard',
		pad = 'none',
		inset = false,
		clip = false,
		grow = false,
		shrink = true,
		class: className,
		children,
		...restProps
	}: BoundProps = $props();
	// Read at init, like every context: an inset is a layout fact, not a toggled state.
	const padsInset = untrack(() => inset) ? ownInset() : false;
	const sizeClasses: Record<BoundSize, string> = {
		compact: 'h-72',
		standard: 'h-[28rem]',
		tall: 'h-[40rem]',
		fit: 'h-[min(42rem,calc(100dvh-14rem))] min-h-[28rem]',
		full: 'h-full',
		// Content height: a clip or inset boundary with no height contract of its own.
		auto: 'h-auto'
	};
</script>

<svelte:element
	this={as}
	bind:this={ref}
	class={cn(
		'min-h-0 min-w-0 [container-type:inline-size]',
		sizeClasses[size],
		padsInset ? INSET_CLASS : PAD_CLASSES[pad],
		clip && 'overflow-clip',
		grow && 'flex-1',
		!shrink && 'shrink-0',
		// The caller's class last: floors, layers and colours it names win; layout itself is props (doctor-enforced).
		className
	)}
	data-layout="bound"
	data-bound-clip={clip || undefined}
	data-bound-inset={padsInset || undefined}
	{...restProps}
>
	{@render children()}
</svelte:element>
