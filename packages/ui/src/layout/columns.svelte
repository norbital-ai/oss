<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement, LayoutGap } from './layout.shared.js';

	export type ColumnCount = 2 | 3 | 4 | 6;
	export interface ColumnsProps extends LayoutAttributes {
		as?: LayoutElement;
		count?: ColumnCount;
		gap?: LayoutGap;
		children: Snippet;
	}
</script>

<script lang="ts">
	import { cn } from '#lib/utils';
	import { setContext } from 'svelte';
	import { COLUMN_PARENT_CONTEXT, GAP_CLASSES } from './layout.shared.js';

	let {
		as = 'div',
		count = 2,
		gap = 'md',
		class: className,
		children,
		...restProps
	}: ColumnsProps = $props();

	const countClasses: Record<ColumnCount, string> = {
		2: 'grid-cols-2',
		3: 'grid-cols-3',
		4: 'grid-cols-4',
		6: 'grid-cols-6'
	};
	setContext(COLUMN_PARENT_CONTEXT, { kind: 'columns', count: () => count });
</script>

<svelte:element
	this={as}
	class={cn(className, 'grid min-h-0 min-w-0', GAP_CLASSES[gap], countClasses[count])}
	data-layout="columns"
	data-columns={count}
	{...restProps}
>
	{@render children()}
</svelte:element>
