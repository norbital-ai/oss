<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement, LayoutGap } from './layout.shared.js';

	export type GridMinimum = 'compact' | 'card' | 'panel';
	export interface GridProps extends LayoutAttributes {
		as?: LayoutElement;
		gap?: LayoutGap;
		minimum?: GridMinimum;
		children: Snippet;
	}
</script>

<script lang="ts">
	import { cn } from '#lib/utils';
	import { setContext } from 'svelte';
	import { COLUMN_PARENT_CONTEXT, GAP_CLASSES } from './layout.shared.js';

	let {
		as = 'div',
		gap = 'md',
		minimum = 'card',
		class: className,
		children,
		...restProps
	}: GridProps = $props();

	const minimumClasses: Record<GridMinimum, string> = {
		compact: '[grid-template-columns:repeat(auto-fit,minmax(min(100%,12rem),1fr))]',
		card: '[grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr))]',
		panel: '[grid-template-columns:repeat(auto-fit,minmax(min(100%,26rem),1fr))]'
	};
	setContext(COLUMN_PARENT_CONTEXT, { kind: 'grid' });
</script>

<svelte:element
	this={as}
	class={cn(className, 'grid min-h-0 min-w-0', GAP_CLASSES[gap], minimumClasses[minimum])}
	data-layout="grid"
	{...restProps}
>
	{@render children()}
</svelte:element>
