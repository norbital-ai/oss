<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement, LayoutGap } from './layout.shared.js';

	export type CenterMeasure = 'narrow' | 'reading' | 'wide' | 'full';
	export type CenterLayout = 'block' | 'stack' | 'inline' | 'cluster' | 'grid';
	export interface CenterProps extends LayoutAttributes {
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
	import { cn } from '#lib/utils';
	import { GAP_CLASSES } from './layout.shared.js';

	let {
		as = 'div',
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
	const resolvedAlign = $derived(align ?? (layout === 'stack' || layout === 'grid' ? 'stretch' : 'center'));
</script>

<svelte:element
	this={as}
	class={cn(
		className,
		'mx-auto min-h-0 w-full min-w-0',
		measureClasses[measure],
		layoutClasses[layout],
		layout !== 'block' && GAP_CLASSES[gap],
		layout !== 'block' && alignClasses[resolvedAlign],
		layout !== 'block' && justifyClasses[justify]
	)}
	data-layout="center"
	{...restProps}
>
	{@render children()}
</svelte:element>
