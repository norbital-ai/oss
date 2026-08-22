<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement } from '#lib/layout/layout.shared';

	export type ColumnSpan = 1 | 2 | 3 | 4 | 5 | 6 | 'all';
	export interface ColumnProps extends LayoutAttributes {
		as?: LayoutElement;
		span?: ColumnSpan;
		children: Snippet;
	}
</script>

<script lang="ts">
	import { cn } from '#lib/utils';
	import { getContext } from 'svelte';
	import { COLUMN_PARENT_CONTEXT, type ColumnParentContext } from '#lib/layout/layout.shared';

	let { as = 'div', span = 1, class: className, children, ...restProps }: ColumnProps = $props();
	const parent = getContext<ColumnParentContext>(COLUMN_PARENT_CONTEXT);
	const spanClasses: Record<ColumnSpan, string> = {
		1: 'col-span-1',
		2: 'col-span-2',
		3: 'col-span-3',
		4: 'col-span-4',
		5: 'col-span-5',
		6: 'col-span-6',
		all: 'col-span-full'
	};
	const spanClass = $derived.by(() => {
		if (!parent) throw new Error('Column must be a child of Grid or Columns');
		if (parent.kind === 'grid' && span !== 1 && span !== 'all') {
			throw new Error('Column inside Grid accepts only span 1 or all');
		}
		if (parent.kind === 'columns' && span !== 'all' && span > parent.count()) {
			throw new Error(`Column span ${span} exceeds its parent Columns count ${parent.count()}`);
		}
		return spanClasses[span];
	});
</script>

<svelte:element
	this={as}
	class={cn(className, 'min-h-0 min-w-0', spanClass)}
	data-layout="column"
	{...restProps}
>
	{@render children()}
</svelte:element>
