<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement, LayoutGap } from './layout.shared.js';

	export interface ClusterProps extends LayoutAttributes {
		as?: LayoutElement;
		gap?: LayoutGap;
		align?: 'start' | 'center' | 'end' | 'baseline';
		justify?: 'start' | 'center' | 'end' | 'between';
		/** Take the remaining space along the parent's main axis. */
		grow?: boolean;
		/** Fill the parent's height. */
		fill?: boolean;
		/** Allow this region to shrink when its parent is constrained. */
		shrink?: boolean;
		children: Snippet;
	}
</script>

<script lang="ts">
	import { cn } from '#lib/utils';
	import { GAP_CLASSES } from './layout.shared.js';

	let {
		as = 'div',
		gap = 'sm',
		align = 'center',
		justify = 'start',
		grow = false,
		fill = false,
		shrink = true,
		class: className,
		children,
		...restProps
	}: ClusterProps = $props();

	const alignClasses = {
		start: 'items-start',
		center: 'items-center',
		end: 'items-end',
		baseline: 'items-baseline'
	} as const;
	const justifyClasses = {
		start: 'justify-start',
		center: 'justify-center',
		end: 'justify-end',
		between: 'justify-between'
	} as const;
</script>

<svelte:element
	this={as}
	class={cn(
		className,
		'flex min-h-0 min-w-0 flex-row flex-wrap',
		GAP_CLASSES[gap],
		alignClasses[align],
		justifyClasses[justify],
		grow && 'flex-1',
		fill && 'h-full',
		!shrink && 'shrink-0'
	)}
	data-layout="cluster"
	{...restProps}
>
	{@render children()}
</svelte:element>
