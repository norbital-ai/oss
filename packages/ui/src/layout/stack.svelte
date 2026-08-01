<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement, LayoutGap } from './layout.shared.js';

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
		children: Snippet;
	}
</script>

<script lang="ts">
	import { cn } from '#lib/utils';
	import { GAP_CLASSES } from './layout.shared.js';

	let {
		as = 'div',
		gap = 'md',
		align = 'stretch',
		justify = 'start',
		grow = false,
		fill = false,
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
	class={cn(
		className,
		'flex min-h-0 min-w-0 flex-col',
		GAP_CLASSES[gap],
		alignClasses[align],
		justifyClasses[justify],
		grow && 'flex-1',
		fill && 'h-full'
	)}
	data-layout="stack"
	{...restProps}
>
	{@render children()}
</svelte:element>
