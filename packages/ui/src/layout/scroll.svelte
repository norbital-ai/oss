<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement } from './layout.shared.js';

	export type ScrollAxis = 'x' | 'y' | 'both';
	export interface ScrollProps extends LayoutAttributes {
		as?: LayoutElement;
		axis?: ScrollAxis;
		name: string;
		inset?: boolean;
		ref?: HTMLElement | null;
		children: Snippet;
	}
</script>

<script lang="ts">
	import { cn } from '#lib/utils';
	import { INSET_CLASS } from './layout.shared.js';

	let {
		as = 'div',
		axis = 'y',
		name,
		inset = false,
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: ScrollProps = $props();
	const axisClasses: Record<ScrollAxis, string> = {
		x: 'overflow-x-auto overflow-y-clip',
		y: 'overflow-x-clip overflow-y-auto',
		both: 'overflow-auto'
	};
</script>

<svelte:element
	this={as}
	bind:this={ref}
	role="region"
	aria-label={name}
	tabindex="0"
	class={cn(
		className,
		'h-full max-h-full min-h-0 min-w-0 overscroll-contain [scrollbar-gutter:stable] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
		axisClasses[axis],
		inset && INSET_CLASS
	)}
	data-layout="scroll"
	data-scroll-axis={axis}
	data-scroll-inset={inset || undefined}
	{...restProps}
>
	{@render children()}
</svelte:element>
