<script lang="ts">
	import { cn } from '#lib/utils';
	import { SCROLL_AXIS_CLASSES, scrollAffordance } from '#lib/layout';
	import type { Snippet } from 'svelte';

	let {
		class: className,
		children,
		scrollElement = $bindable<HTMLDivElement | null>(null)
	}: {
		class?: string;
		children: Snippet;
		scrollElement?: HTMLDivElement | null;
	} = $props();
</script>

<div
	bind:this={scrollElement}
	class={cn(
		// The rail used to fade both ends unconditionally, which dimmed the first and last
		// entry of a table of contents short enough to need no scrolling at all. The
		// attachment fades only the ends that have more behind them.
		'relative ms-px min-h-0 flex-1 py-3 text-sm',
		SCROLL_AXIS_CLASSES.both,
		className
	)}
	{@attach scrollAffordance()}
>
	{@render children()}
</div>
