<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement, LayoutGap } from './layout.shared.js';

	export interface StackProps extends LayoutAttributes {
		as?: LayoutElement;
		gap?: LayoutGap;
		children: Snippet;
	}
</script>

<script lang="ts">
	import { cn } from '#lib/utils';
	import { GAP_CLASSES } from './layout.shared.js';

	let { as = 'div', gap = 'md', class: className, children, ...restProps }: StackProps = $props();
</script>

<svelte:element
	this={as}
	class={cn(className, 'flex min-w-0 flex-col', GAP_CLASSES[gap])}
	data-layout="stack"
	{...restProps}
>
	{@render children()}
</svelte:element>
