<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement } from './layout.shared.js';

	export type CenterMeasure = 'reading' | 'wide' | 'full';
	export interface CenterProps extends LayoutAttributes {
		as?: LayoutElement;
		measure?: CenterMeasure;
		children: Snippet;
	}
</script>

<script lang="ts">
	import { cn } from '#lib/utils';

	let {
		as = 'div',
		measure = 'reading',
		class: className,
		children,
		...restProps
	}: CenterProps = $props();
	const measureClasses: Record<CenterMeasure, string> = {
		reading: 'max-w-[var(--measure)]',
		wide: 'max-w-7xl',
		full: 'max-w-none'
	};
</script>

<svelte:element
	this={as}
	class={cn(className, 'mx-auto min-h-0 w-full min-w-0', measureClasses[measure])}
	data-layout="center"
	{...restProps}
>
	{@render children()}
</svelte:element>
