<!--
@component
A vertical flow of children with a gap: the default layout of a page body, a form or a card.
Like every layout primitive, a box is `size="content"` (the default: its own size, never squeezed — the nearest
scroll owner scrolls when boxes do not fit) or `size="fill"` (the space left in its parent, shrinking to `minHeight`; a
`Scroll` there scrolls inside). Nothing scrolls sideways unless it is a `Scroll axis="x"`.
@example
<Stack gap="md" size="fill">
	<h2>{title}</h2>
	<Scroll name="Notes" size="fill">{notes}</Scroll>
</Stack>
-->
<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement, LayoutGap, LayoutSize } from './layout.shared.js';

	/** The props of `Stack`. */
	export interface StackProps extends LayoutAttributes {
		as?: LayoutElement;
		gap?: LayoutGap;
		/** Cross-axis (horizontal) placement of the children. */
		align?: 'start' | 'center' | 'end' | 'stretch';
		/**
		 * Main-axis (vertical) placement of the children.
		 *
		 * Only meaningful when the Stack has more height than its content: `size="fill"`. A Stack whose
		 * height comes from its own content has nothing to distribute, which is why placing content
		 * against a `min-h-*` parent silently does nothing and the content stays at the top.
		 */
		justify?: 'start' | 'center' | 'end' | 'between';
		/** `content` (default): its own size, never squeezed; `fill`: the space left in its parent, down to `minHeight`. */
		size?: LayoutSize;
		/** A `fill` box's floor (a CSS length; default 0). */
		minHeight?: string;
		/** A hairline between children — a list of rows. Pair with `gap="none"`. */
		divided?: boolean;
		/** Last child on top: a log read newest-first without reversing the data. */
		reverse?: boolean;
		children: Snippet;
	}
</script>

<script lang="ts">
	import { cn } from '../primitives/utils.js';
	import { GAP_CLASSES, SIZE_CLASSES } from './layout.shared.js';

	let {
		as = 'div',
		ref = $bindable(null),
		gap = 'md',
		align = 'stretch',
		justify = 'start',
		size = 'content',
		minHeight,
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
		'flex min-w-0',
		reverse ? 'flex-col-reverse' : 'flex-col',
		GAP_CLASSES[gap],
		alignClasses[align],
		justifyClasses[justify],
		SIZE_CLASSES[size],
		divided && 'divide-y divide-border',
		// The caller's class last: floors, layers and colours it names win; layout itself is props (doctor-enforced).
		className
	)}
	style:min-height={size === 'fill' ? minHeight : undefined}
	data-layout="stack"
	{...restProps}
>
	{@render children()}
</svelte:element>
