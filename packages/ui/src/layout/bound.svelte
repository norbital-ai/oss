<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement, LayoutPad } from './layout.shared.js';

	export type BoundSize = 'compact' | 'standard' | 'tall' | 'full';
	export interface BoundProps extends LayoutAttributes {
		as?: LayoutElement;
		size?: BoundSize;
		pad?: LayoutPad;
		inset?: boolean;
		clip?: boolean;
		children: Snippet;
	}
</script>

<script lang="ts">
	import { cn } from '#lib/utils';
	import { INSET_CLASS, PAD_CLASSES } from './layout.shared.js';

	let {
		as = 'div',
		size = 'standard',
		pad = 'none',
		inset = false,
		clip = false,
		class: className,
		children,
		...restProps
	}: BoundProps = $props();
	const sizeClasses: Record<BoundSize, string> = {
		compact: 'h-72',
		standard: 'h-[28rem]',
		tall: 'h-[40rem]',
		full: 'h-full'
	};
</script>

<svelte:element
	this={as}
	class={cn(
		className,
		'min-h-0 min-w-0 [container-type:inline-size]',
		sizeClasses[size],
		inset ? INSET_CLASS : PAD_CLASSES[pad],
		clip && 'overflow-clip'
	)}
	data-layout="bound"
	data-bound-clip={clip || undefined}
	data-bound-inset={inset || undefined}
	{...restProps}
>
	{@render children()}
</svelte:element>
