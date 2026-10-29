<!--
@component
The one scroll owner of a region: scrolls on `axis`, fades edges with content beyond them, and optionally snaps children. `name` identifies it (a page restores its position).
A vertical scroll owner is `size="fill"` (the space left in its parent, scrolling inside) or `content` capped by `max`
(a popover list); a `content` Scroll without a cap is its content's height and scrolls only on `x`.
-->
<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type {
		LayoutAttributes,
		LayoutElement,
		LayoutGap,
		LayoutSize,
		ScrollAxis
	} from './layout.shared.js';

	type ScrollLayout = 'block' | 'inline' | 'stack';
	/** The props of `Scroll`. */
	export interface ScrollProps extends LayoutAttributes {
		as?: LayoutElement;
		axis?: ScrollAxis;
		name: string;
		inset?: boolean;
		/**
		 * Fade the edges that have content beyond them. On by default: it is what tells a
		 * reader there is more below now that the scroll bar hides at rest. Turn it off for a
		 * region whose own content must stay at full opacity to its edge — a media surface, a
		 * chart, anything where a soft edge would read as a rendering fault.
		 */
		fade?: boolean;
		/** Arrange direct children without introducing a second wrapper or scroll owner. */
		layout?: ScrollLayout;
		gap?: LayoutGap;
		align?: 'start' | 'center' | 'end' | 'baseline' | 'stretch';
		justify?: 'start' | 'center' | 'end' | 'between';
		/** `content` (default): its own height, up to `max`; `fill`: the space left in its parent, scrolling inside, down to `minHeight`. */
		size?: LayoutSize;
		/** A `fill` scroll's floor (a CSS length; default 0). */
		minHeight?: string;
		/** Snap children to the start edge along the scroll axis — a reel of lanes or cards. */
		snap?: boolean;
		/**
		 * A `content` scroll's cap: it grows with its content up to it, then scrolls — a popover list,
		 * a disclosure body. Capped by the viewport too.
		 */
		max?: 'compact' | 'standard' | 'tall';
		ref?: HTMLElement | null;
		children: Snippet;
	}
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import { cn } from '../primitives/utils.js';
	import { getContext, setContext } from 'svelte';
	import {
		GAP_CLASSES,
		INSET_CLASS,
		SCROLL_AXIS_CLASSES,
		SIZE_CLASSES,
		SCROLL_PORT_CONTEXT,
		type ScrollPort
	} from './layout.shared.js';
	import { scrollAffordance } from './scroll-affordance.svelte.js';
	import { ownInset } from './inset.svelte.js';

	let {
		as = 'div',
		axis = 'y',
		name,
		inset = false,
		fade = true,
		layout = 'block',
		gap = 'none',
		align,
		justify = 'start',
		size = 'content',
		minHeight,
		snap = false,
		max,
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: ScrollProps = $props();
	const layoutClasses: Record<ScrollLayout, string | undefined> = {
		block: undefined,
		// `flex-nowrap` and `[&>*]:shrink-0` say the same thing on the two axes: a scroll container
		// scrolls, its children do not compress to fit. Without it on the stack axis, a column whose
		// content overruns shrank every child — and a child carrying `min-h-0`, which a `fill`
		// primitive sets, has no floor, so the agent transcript collapsed every message to zero height
		// and the replies painted over one another.
		inline: 'flex flex-row flex-nowrap',
		stack: 'flex flex-col [&>*]:shrink-0'
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
	const padsInset = untrack(() => inset) ? ownInset() : false;
	const parentPort = getContext<ScrollPort | undefined>(SCROLL_PORT_CONTEXT);
	setContext<ScrollPort>(SCROLL_PORT_CONTEXT, {
		get element() {
			return axis === 'x' ? (parentPort?.element ?? null) : ref;
		}
	});
	// Capped by the viewport too: a popover body on a short phone still fits the screen.
	const MAX_CLASSES = {
		compact: 'max-h-[min(18rem,calc(100dvh-6rem))]',
		standard: 'max-h-[min(28rem,calc(100dvh-6rem))]',
		tall: 'max-h-[min(40rem,calc(100dvh-6rem))]'
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
		SIZE_CLASSES[size],
		size === 'content' && max && MAX_CLASSES[max],
		'min-w-0 [scrollbar-gutter:stable] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
		SCROLL_AXIS_CLASSES[axis],
		layoutClasses[layout],
		layout !== 'block' && GAP_CLASSES[gap],
		layout !== 'block' && alignClasses[resolvedAlign],
		layout !== 'block' && justifyClasses[justify],
		padsInset && INSET_CLASS,
		snap &&
			(axis === 'x'
				? 'snap-x snap-mandatory [&>*]:snap-start'
				: 'snap-y snap-mandatory [&>*]:snap-start'),
		// The caller's class last: floors, layers and colours it names win; layout itself is props (doctor-enforced).
		className
	)}
	style:min-height={size === 'fill' ? minHeight : undefined}
	data-layout="scroll"
	data-scroll-axis={axis}
	data-scroll-inset={padsInset || undefined}
	{...restProps}
	{@attach scrollAffordance({ fade })}
>
	{@render children()}
</svelte:element>
