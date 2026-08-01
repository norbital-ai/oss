<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement, LayoutGap, LayoutPad } from './layout.shared.js';

	export interface CoverProps extends LayoutAttributes {
		as?: LayoutElement;
		gap?: LayoutGap;
		pad?: LayoutPad;
		/** Take the remaining space along the parent's main axis. */
		grow?: boolean;
		/** Allow this region to shrink when its parent is constrained. */
		shrink?: boolean;
		top?: Snippet;
		bottom?: Snippet;
		children: Snippet;
	}
</script>

<script lang="ts">
	import { cn } from '#lib/utils';
	import { GAP_CLASSES, PAD_CLASSES } from './layout.shared.js';

	let {
		as = 'div',
		gap = 'md',
		pad = 'none',
		grow = false,
		shrink = true,
		top,
		bottom,
		class: className,
		children,
		...restProps
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
	const { style: styleProp, ...attributes } = $derived(
		restProps as { style?: string } & Record<string, unknown>
	);
</script>

<svelte:element
	this={as}
	class={cn(
		className,
		'grid h-full max-h-full min-h-0 min-w-0 overflow-clip',
		GAP_CLASSES[gap],
		PAD_CLASSES[pad],
		grow && 'flex-1',
		!shrink && 'shrink-0'
	)}
	style={`grid-template-rows: ${rowTemplate};${styleProp ? ` ${styleProp}` : ''}`}
	data-layout="cover"
	{...attributes}
>
	{#if top}
		<div class="min-w-0 shrink-0">{@render top()}</div>
	{/if}
	<!-- stupidity:allow UI5 -- the Cover primitive owns this clip region -->
	<div class="min-h-0 min-w-0 overflow-clip">{@render children()}</div>
	{#if bottom}
		<div class="min-w-0 shrink-0">{@render bottom()}</div>
	{/if}
</svelte:element>
