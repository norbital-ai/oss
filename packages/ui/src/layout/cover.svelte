<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement, LayoutGap, LayoutPad } from './layout.shared.js';

	export interface CoverProps extends LayoutAttributes {
		as?: LayoutElement;
		gap?: LayoutGap;
		pad?: LayoutPad;
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
		top,
		bottom,
		class: className,
		children,
		...restProps
	}: CoverProps = $props();
</script>

<svelte:element
	this={as}
	class={cn(
		className,
		'grid h-full max-h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-clip',
		GAP_CLASSES[gap],
		PAD_CLASSES[pad]
	)}
	data-layout="cover"
	{...restProps}
>
	<div class="min-w-0 shrink-0">
		{#if top}{@render top()}{/if}
	</div>
	<div class="min-h-0 min-w-0 overflow-clip">{@render children()}</div>
	<div class="min-w-0 shrink-0">
		{#if bottom}{@render bottom()}{/if}
	</div>
</svelte:element>
