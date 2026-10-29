<!--
@component
A wrapping row of items with a gap: tags, buttons, metadata. Children wrap to the next line when the row is full.
-->
<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement, LayoutGap, LayoutSize } from './layout.shared.js';

	/** The props of `Cluster`. */
	export interface ClusterProps extends LayoutAttributes {
		as?: LayoutElement;
		gap?: LayoutGap;
		align?: 'start' | 'center' | 'end' | 'baseline';
		justify?: 'start' | 'center' | 'end' | 'between';
		/** `content` (default): its own size, never squeezed; `fill`: the space left in its parent, down to `minHeight`. */
		size?: LayoutSize;
		/** A `fill` box's floor (a CSS length; default 0). */
		minHeight?: string;
		/** A hairline between children — a segmented strip. Pair with `gap="none"`. */
		divided?: boolean;
		children: Snippet;
	}
</script>

<script lang="ts">
	import { cn } from '../primitives/utils.js';
	import { GAP_CLASSES, SIZE_CLASSES } from './layout.shared.js';

	let {
		as = 'div',
		ref = $bindable(null),
		gap = 'sm',
		align = 'center',
		justify = 'start',
		size = 'content',
		minHeight,
		divided = false,
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
	bind:this={ref}
	class={cn(
		'flex min-w-0 flex-row flex-wrap',
		GAP_CLASSES[gap],
		alignClasses[align],
		justifyClasses[justify],
		SIZE_CLASSES[size],
		divided && 'divide-x divide-border',
		// The caller's class last: floors, layers and colours it names win; layout itself is props (doctor-enforced).
		className
	)}
	style:min-height={size === 'fill' ? minHeight : undefined}
	data-layout="cluster"
	{...restProps}
>
	{@render children()}
</svelte:element>
