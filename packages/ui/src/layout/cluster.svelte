<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement, LayoutGap } from '#lib/layout/layout.shared';

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
		/** A hairline between children — a segmented strip. Pair with `gap="none"`. */
		divided?: boolean;
		children: Snippet;
	}
</script>

<script lang="ts">
	import { cn } from '#lib/utils';
	import { GAP_CLASSES } from '#lib/layout/layout.shared';

	let {
		as = 'div',
		ref = $bindable(null),
		gap = 'sm',
		align = 'center',
		justify = 'start',
		grow = false,
		fill = false,
		shrink = true,
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
		'flex min-h-0 min-w-0 flex-row flex-wrap',
		GAP_CLASSES[gap],
		alignClasses[align],
		justifyClasses[justify],
		grow && 'flex-1',
		fill && 'h-full',
		!shrink && 'shrink-0',
		divided && 'divide-x divide-border',
		// The caller's class last: floors, layers and colours it names win; layout itself is props (doctor-enforced).
		className
	)}
	data-layout="cluster"
	{...restProps}
>
	{@render children()}
</svelte:element>
