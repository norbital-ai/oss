<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement, LayoutGap } from '#lib/layout/layout.shared';

	export interface StackProps extends LayoutAttributes {
		as?: LayoutElement;
		gap?: LayoutGap;
		/** Cross-axis (horizontal) placement of the children. */
		align?: 'start' | 'center' | 'end' | 'stretch';
		/**
		 * Main-axis (vertical) placement of the children.
		 *
		 * Only meaningful when the Stack has more height than its content — inside a `Cover` body, a
		 * `Bound size="full"`, or anything else that hands it a definite height. A Stack whose height
		 * comes from its own content has nothing to distribute, which is why placing content against
		 * a `min-h-*` parent silently does nothing and the content stays at the top. Pair with `fill`.
		 */
		justify?: 'start' | 'center' | 'end' | 'between';
		/** Take the remaining space along the parent's main axis. */
		grow?: boolean;
		/** Fill the parent's height, so `justify` has room to distribute. */
		fill?: boolean;
		/** Allow this region to shrink when its parent is constrained. */
		shrink?: boolean;
		/** A hairline between children — a list of rows. Pair with `gap="none"`. */
		divided?: boolean;
		/** Last child on top: a log read newest-first without reversing the data. */
		reverse?: boolean;
		children: Snippet;
	}
</script>

<script lang="ts">
	import { cn } from '#lib/utils';
	import { GAP_CLASSES } from '#lib/layout/layout.shared';

	let {
		as = 'div',
		ref = $bindable(null),
		gap = 'md',
		align = 'stretch',
		justify = 'start',
		grow = false,
		fill = false,
		shrink = true,
		divided = false,
		reverse = false,
		class: className,
		children,
		...restProps
	}: StackProps = $props();

	const alignClasses = {
		start: 'items-start',
		center: 'items-center',
		end: 'items-end',
		stretch: 'items-stretch'
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
		'flex min-h-0 min-w-0',
		reverse ? 'flex-col-reverse' : 'flex-col',
		GAP_CLASSES[gap],
		alignClasses[align],
		justifyClasses[justify],
		grow && 'flex-1',
		fill && 'h-full',
		!shrink && 'shrink-0',
		divided && 'divide-y divide-border',
		// The caller's class last: floors, layers and colours it names win; layout itself is props (doctor-enforced).
		className
	)}
	data-layout="stack"
	{...restProps}
>
	{@render children()}
</svelte:element>
