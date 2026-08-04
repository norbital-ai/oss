<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement, LayoutGap } from './layout.shared.js';

	export type ScrollAxis = 'x' | 'y' | 'both';
	export type ScrollLayout = 'block' | 'inline' | 'stack';
	export interface ScrollProps extends LayoutAttributes {
		as?: LayoutElement;
		axis?: ScrollAxis;
		name: string;
		inset?: boolean;
		/** Arrange direct children without introducing a second wrapper or scroll owner. */
		layout?: ScrollLayout;
		gap?: LayoutGap;
		align?: 'start' | 'center' | 'end' | 'baseline' | 'stretch';
		justify?: 'start' | 'center' | 'end' | 'between';
		/** Take the remaining space along the parent's main axis. */
		grow?: boolean;
		/** Allow this region to shrink when its parent is constrained. */
		shrink?: boolean;
		ref?: HTMLElement | null;
		children: Snippet;
	}
</script>

<script lang="ts">
	import { cn } from '#lib/utils';
	import { GAP_CLASSES, INSET_CLASS } from './layout.shared.js';

	let {
		as = 'div',
		axis = 'y',
		name,
		inset = false,
		layout = 'block',
		gap = 'none',
		align,
		justify = 'start',
		grow = false,
		shrink = true,
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: ScrollProps = $props();
	const axisClasses: Record<ScrollAxis, string> = {
		// Per-axis contain: an x-only reel must not trap vertical parent scroll.
		x: 'overflow-x-auto overflow-y-clip overscroll-x-contain',
		y: 'overflow-x-clip overflow-y-auto overscroll-y-contain',
		both: 'overflow-auto overscroll-contain'
	};
	const layoutClasses: Record<ScrollLayout, string | undefined> = {
		block: undefined,
		inline: 'flex flex-row flex-nowrap',
		stack: 'flex flex-col'
	};
	const alignClasses = {
		start: 'items-start',
		center: 'items-center',
		end: 'items-end',
		baseline: 'items-baseline',
		stretch: 'items-stretch'
	} as const;
	const justifyClasses = {
		start: 'justify-start',
		center: 'justify-center',
		end: 'justify-end',
		between: 'justify-between'
	} as const;
	const resolvedAlign = $derived(align ?? (layout === 'inline' ? 'center' : 'stretch'));
</script>

<svelte:element
	this={as}
	bind:this={ref}
	role="region"
	aria-label={name}
	tabindex="0"
	class={cn(
		className,
		'h-full max-h-full min-h-0 min-w-0 [scrollbar-gutter:stable] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
		axisClasses[axis],
		layoutClasses[layout],
		layout !== 'block' && GAP_CLASSES[gap],
		layout !== 'block' && alignClasses[resolvedAlign],
		layout !== 'block' && justifyClasses[justify],
		inset && INSET_CLASS,
		grow && 'flex-1',
		!shrink && 'shrink-0'
	)}
	data-layout="scroll"
	data-scroll-axis={axis}
	data-scroll-inset={inset || undefined}
	{...restProps}
>
	{@render children()}
</svelte:element>
