<!--
@component
A region with optional `top` and `bottom` chrome and a body between them, optionally centred: an empty state, a sign-in card, a page with a footer bar. `size="fill"` takes the space left in its parent, pinning `top` and `bottom` and handing the body the height between (a `fill` child of the body takes it).
-->
<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type {
		LayoutAttributes,
		LayoutElement,
		LayoutGap,
		LayoutPad,
		LayoutSize
	} from './layout.shared.js';

	/** The props of `Cover`. */
	interface CoverProps extends LayoutAttributes {
		/** The element rendered; `div` by default. */
		as?: LayoutElement;
		/** Space between `top`, the body and `bottom` (default `md`). */
		gap?: LayoutGap;
		/** Padding on every side (default `none`). */
		pad?: LayoutPad;
		/** `content` (default): its own height; `fill`: the space left in its parent, down to `min_height`. */
		size?: LayoutSize;
		/** A `fill` cover's floor (a CSS length; default 0). */
		min_height?: string;
		/**
		 * Centre the body's content in the space between `top` and `bottom` — Every Layout's Cover
		 * principal: an empty state, a sign-in card, a splash. Without it the body is a scroll owner's
		 * slot and starts at the top.
		 */
		center?: boolean;
		/** Chrome pinned above the body (a header), stacked over it. */
		top?: Snippet;
		/** Chrome pinned below the body (a footer bar). */
		bottom?: Snippet;
		/** The body: the height between `top` and `bottom`, clipped. */
		children: Snippet;
	}
</script>

<script lang="ts">
	import { cn } from '../primitives/utils.js';
	import { GAP_CLASSES, PAD_CLASSES, SIZE_CLASSES } from './layout.shared.js';

	let {
		as = 'div',
		ref = $bindable(null),
		gap = 'md',
		pad = 'none',
		size = 'content',
		min_height,
		center = false,
		top,
		bottom,
		class: className,
		style: styleProp,
		children,
		...attributes
	}: CoverProps = $props();

	/**
	 * The row template is an inline style, not a Tailwind arbitrary value.
	 *
	 * Tailwind generates CSS by scanning source text, so a class assembled at runtime —
	 * `` `[grid-template-rows:${rowTemplate}]` `` — names a rule that was never emitted. Cover then
	 * rendered as a bare `grid` with implicit auto rows, which is why a header would not stay at the
	 * top, the middle would not take the remaining height, and a footer would not pin to the bottom.
	 * Nothing errored; the layout was simply the browser's default.
	 */
	const rowTemplate = $derived(
		[top ? 'auto' : null, 'minmax(0,1fr)', bottom ? 'auto' : null]
			.filter((row) => row !== null)
			.join(' ')
	);
</script>

<svelte:element
	this={as}
	bind:this={ref}
	class={cn(
		'grid min-w-0 overflow-clip',
		GAP_CLASSES[gap],
		PAD_CLASSES[pad],
		SIZE_CLASSES[size],
		// The caller's class last: floors, layers and colours it names win; layout itself is props.
		className
	)}
	style={`grid-template-rows: ${rowTemplate};${styleProp ? ` ${styleProp}` : ''}`}
	style:min-height={size === 'fill' ? min_height : undefined}
	data-layout="cover"
	{...attributes}
>
	{#if top}
		<!-- Stack above the body so overlapping chrome (e.g. app banner icon) is not painted under. -->
		<div class="relative z-10 min-w-0 shrink-0">{@render top()}</div>
	{/if}
	<div
		class={cn(
			'min-h-0 min-w-0 overflow-clip',
			center && 'flex flex-col items-center justify-center'
		)}
	>
		{@render children()}
	</div>
	{#if bottom}
		<div class="min-w-0 shrink-0">{@render bottom()}</div>
	{/if}
</svelte:element>
