<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement, LayoutGap } from '#lib/layout/layout.shared';

	export type ColumnCount = 1 | 2 | 3 | 4 | 5 | 6 | 7;
	export interface ColumnsProps extends LayoutAttributes {
		as?: LayoutElement;
		count?: ColumnCount;
		gap?: LayoutGap;
		/**
		 * Below this width of the Columns itself, every child takes a full row. `none` keeps the
		 * count at any width — only for content that is meaningless stacked (a calendar week).
		 */
		collapse?: 'compact' | 'narrow' | 'none';
		children: Snippet;
	}
</script>

<script lang="ts">
	import { cn } from '#lib/utils';
	import { setContext } from 'svelte';
	import { COLUMN_PARENT_CONTEXT, GAP_CLASSES } from '#lib/layout/layout.shared';

	let {
		as = 'div',
		ref = $bindable(null),
		count = 2,
		gap = 'md',
		collapse = 'narrow',
		class: className,
		children,
		...restProps
	}: ColumnsProps = $props();

	const countClasses: Record<ColumnCount, string> = {
		1: 'grid-cols-1',
		2: 'grid-cols-2',
		3: 'grid-cols-3',
		4: 'grid-cols-4',
		5: 'grid-cols-5',
		6: 'grid-cols-6',
		7: 'grid-cols-7'
	};
	setContext(COLUMN_PARENT_CONTEXT, { kind: 'columns', count: () => count });
</script>

<svelte:element
	this={as}
	bind:this={ref}
	class={cn('columns grid min-h-0 min-w-0', GAP_CLASSES[gap], countClasses[count], className)}
	data-layout="columns"
	data-columns={count}
	data-collapse={collapse}
	{...restProps}
>
	{@render children()}
</svelte:element>

<style>
	/* Columns measures itself, like Split: collapsing moves the children, not the template. */
	/*
		Only a collapsing Columns measures itself. Inline-size containment sizes the box without its
		content, so a Columns in a shrink-to-fit parent (a popover) would collapse to zero width.
	*/
	.columns:not([data-collapse='none']) {
		container-type: inline-size;
	}
	@container (max-width: 39.999rem) {
		.columns[data-collapse='narrow'] > :global(*) {
			grid-column: 1 / -1;
		}
	}
	@container (max-width: 29.999rem) {
		.columns[data-collapse='compact'] > :global(*) {
			grid-column: 1 / -1;
		}
	}
</style>
