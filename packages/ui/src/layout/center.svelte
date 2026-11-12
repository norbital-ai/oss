<!--
@component
Centres its content at a reading measure (`narrow`, `reading`, `wide`, `full`), optionally laying out its children as a stack, row, cluster or grid.
-->
<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement, LayoutGap } from './layout.shared.js';

	/** The maximum width a `Center` holds its content to. */
	type CenterMeasure = 'narrow' | 'reading' | 'wide' | 'full';
	type CenterLayout = 'block' | 'stack' | 'inline' | 'cluster' | 'grid';
	/** The props of `Center`. */
	interface CenterProps extends LayoutAttributes {
		as?: LayoutElement;
		measure?: CenterMeasure;
		/** Arrange direct children while keeping centring and composition on the same element. */
		layout?: CenterLayout;
		gap?: LayoutGap;
		align?: 'start' | 'center' | 'end' | 'baseline' | 'stretch';
		justify?: 'start' | 'center' | 'end' | 'between';
		children: Snippet;
	}
</script>

<script lang="ts">
	import { cn } from '../primitives/utils.js';
	import { ALIGN_CLASSES, JUSTIFY_CLASSES, GAP_CLASSES } from './layout.shared.js';

	let {
		as = 'div',
		ref = $bindable(null),
		measure = 'reading',
		layout = 'block',
		gap = 'none',
		align,
		justify = 'start',
		class: className,
		children,
		...restProps
	}: CenterProps = $props();
	const measureClasses: Record<CenterMeasure, string> = {
		// A single card or form — an access page, a confirmation, an empty state.
		narrow: 'max-w-lg',
		reading: 'max-w-[var(--measure)]',
		wide: 'max-w-7xl',
		full: 'max-w-none'
	};
	const layoutClasses: Record<CenterLayout, string | undefined> = {
		block: undefined,
		stack: 'flex flex-col',
		inline: 'flex flex-row flex-nowrap',
		cluster: 'flex flex-row flex-wrap',
		grid: 'grid'
	};
	const resolvedAlign = $derived(
		align ?? (layout === 'stack' || layout === 'grid' ? 'stretch' : 'center')
	);
</script>

<svelte:element
	this={as}
	bind:this={ref}
	class={cn(
		'mx-auto min-h-0 w-full min-w-0',
		measureClasses[measure],
		layoutClasses[layout],
		layout !== 'block' && GAP_CLASSES[gap],
		layout !== 'block' && ALIGN_CLASSES[resolvedAlign],
		layout !== 'block' && JUSTIFY_CLASSES[justify],
		// Consumer classes last so marketing shells can tighten the measure
		// (e.g. `measure="full" class="max-w-6xl"`) without twMerge dropping them.
		className
	)}
	data-layout="center"
	{...restProps}
>
	{@render children()}
</svelte:element>
