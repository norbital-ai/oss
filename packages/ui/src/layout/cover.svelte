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

	const rowTemplate = $derived(
		[top ? 'auto' : null, 'minmax(0,1fr)', bottom ? 'auto' : null]
			.filter((row) => row !== null)
			.join('_')
	);
</script>

<svelte:element
	this={as}
	class={cn(
		className,
		'grid h-full max-h-full min-h-0 min-w-0 overflow-clip',
		rowTemplate && `[grid-template-rows:${rowTemplate}]`,
		GAP_CLASSES[gap],
		PAD_CLASSES[pad]
	)}
	data-layout="cover"
	{...restProps}
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
