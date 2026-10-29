<!--
@component
A region with a height contract (`content`, `fill`, `viewport`), optional padding, inset and clipping: the box a scrollport or a view fills.
-->
<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement, LayoutPad, LayoutSize } from './layout.shared.js';

	/**
	 * A `Bound`'s height contract: a layout `size` (`content`, `fill`), or `viewport` — the space below the page chrome.
	 */
	export type BoundSize = LayoutSize | 'viewport';
	/** The props of `Bound`. */
	export interface BoundProps extends LayoutAttributes {
		as?: LayoutElement;
		/**
		 * `content` (default): its own height — a clip or inset boundary; `fill`: the space left in
		 * its parent, down to `minHeight`; `viewport`: `min(42rem, 100dvh − 14rem)` with a 28rem floor,
		 * so a view in a page that scrolls claims the space below a ~14rem chrome band.
		 */
		size?: BoundSize;
		/** A `fill` bound's floor (a CSS length; default 0). */
		minHeight?: string;
		pad?: LayoutPad;
		inset?: boolean;
		clip?: boolean;
		children: Snippet;
	}
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import { cn } from '../primitives/utils.js';
	import { INSET_CLASS, PAD_CLASSES, SIZE_CLASSES } from './layout.shared.js';
	import { ownInset } from './inset.svelte.js';

	let {
		as = 'div',
		ref = $bindable(null),
		size = 'content',
		minHeight,
		pad = 'none',
		inset = false,
		clip = false,
		class: className,
		children,
		...restProps
	}: BoundProps = $props();
	// Read at init, like every context: an inset is a layout fact, not a toggled state.
	const padsInset = untrack(() => inset) ? ownInset() : false;
	const sizeClasses: Record<BoundSize, string> = {
		...SIZE_CLASSES,
		viewport: 'h-[min(42rem,calc(100dvh-14rem))] min-h-[28rem] flex-none'
	};
</script>

<svelte:element
	this={as}
	bind:this={ref}
	class={cn(
		'min-w-0 [container-type:inline-size]',
		sizeClasses[size],
		padsInset ? INSET_CLASS : PAD_CLASSES[pad],
		clip && 'overflow-clip',
		// The caller's class last: floors, layers and colours it names win; layout itself is props (doctor-enforced).
		className
	)}
	style:min-height={size === 'fill' ? minHeight : undefined}
	data-layout="bound"
	data-bound-clip={clip || undefined}
	data-bound-inset={padsInset || undefined}
	{...restProps}
>
	{@render children()}
</svelte:element>
