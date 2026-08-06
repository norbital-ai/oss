<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement, LayoutPad } from './layout.shared.js';

	export type BoundSize = 'compact' | 'standard' | 'tall' | 'fit' | 'full';
	export interface BoundProps extends LayoutAttributes {
		as?: LayoutElement;
		/**
		 * The named height contract. `compact`/`standard`/`tall` are fixed panes;
		 * `fit` tracks the viewer: `min(42rem, 100dvh − 14rem)` with a `standard` floor, so a
		 * scrollport claims the space below a ~14rem chrome band instead of guessing a pane size;
		 * `full` fills whatever definite height the parent grants.
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
	import { cn } from '#lib/utils';
	import { INSET_CLASS, PAD_CLASSES } from './layout.shared.js';

	let {
		as = 'div',
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
	const sizeClasses: Record<BoundSize, string> = {
		compact: 'h-72',
		standard: 'h-[28rem]',
		tall: 'h-[40rem]',
		fit: 'h-[min(42rem,calc(100dvh-14rem))] min-h-[28rem]',
		full: 'h-full'
	};
</script>

<svelte:element
	this={as}
	class={cn(
		className,
		'min-h-0 min-w-0 [container-type:inline-size]',
		sizeClasses[size],
		inset ? INSET_CLASS : PAD_CLASSES[pad],
		clip && 'overflow-clip',
		grow && 'flex-1',
		!shrink && 'shrink-0'
	)}
	data-layout="bound"
	data-bound-clip={clip || undefined}
	data-bound-inset={inset || undefined}
	{...restProps}
>
	{@render children()}
</svelte:element>
