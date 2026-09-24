<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement, LayoutGap } from '#lib/layout/layout.shared';

	export type GridMinimum = 'compact' | 'card' | 'panel';
	export interface GridProps extends LayoutAttributes {
		as?: LayoutElement;
		gap?: LayoutGap;
		/** Space between rows when it differs from `gap` (a definition list: wide columns, tight rows). */
		rowGap?: LayoutGap;
		/** Block-axis placement of every cell. */
		align?: 'start' | 'center' | 'end' | 'stretch';
		minimum?: GridMinimum;
		/**
		 * Explicit column tracks. When set, this is the grid template (via `style`, not a Tailwind
		 * class) and `minimum` is ignored. Use `minimum` for intrinsic auto-fit cards; use `tracks`
		 * when the columns are a known, uneven measure — a log table, a definition list.
		 */
		tracks?: string;
		children: Snippet;
	}
</script>

<script lang="ts">
	import { cn } from '#lib/utils';
	import { setContext } from 'svelte';
	import { COLUMN_PARENT_CONTEXT, GAP_CLASSES, ROW_GAP_CLASSES } from '#lib/layout/layout.shared';

	let {
		as = 'div',
		ref = $bindable(null),
		gap = 'md',
		rowGap,
		align = 'stretch',
		minimum = 'card',
		tracks,
		class: className,
		children,
		...restProps
	}: GridProps = $props();

	const ALIGN_CLASSES = {
		start: 'items-start',
		center: 'items-center',
		end: 'items-end',
		stretch: 'items-stretch'
	} as const;
	const minimumClasses: Record<GridMinimum, string> = {
		compact: '[grid-template-columns:repeat(auto-fit,minmax(min(100%,12rem),1fr))]',
		card: '[grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr))]',
		panel: '[grid-template-columns:repeat(auto-fit,minmax(min(100%,26rem),1fr))]'
	};
	const { style: styleProp, ...attributes } = $derived(
		restProps as { style?: string } & Record<string, unknown>
	);
	setContext(COLUMN_PARENT_CONTEXT, { kind: 'grid' });
</script>

<svelte:element
	this={as}
	bind:this={ref}
	class={cn(
		'grid min-h-0 min-w-0',
		GAP_CLASSES[gap],
		rowGap && ROW_GAP_CLASSES[rowGap],
		ALIGN_CLASSES[align],
		tracks ? null : minimumClasses[minimum],
		// The caller's class last: floors, layers and colours it names win; layout itself is props (doctor-enforced).
		className
	)}
	style={tracks
		? `grid-template-columns: ${tracks};${styleProp ? ` ${styleProp}` : ''}`
		: styleProp}
	data-layout="grid"
	{...attributes}
>
	{@render children()}
</svelte:element>
