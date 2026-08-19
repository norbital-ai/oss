<script lang="ts">
	import { cn } from '#lib/utils';
	import { scrollAffordance } from '#lib/layout';
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

<!-- stupidity:allow UI9 -- this local clip boundary contains, rather than duplicates, the descendant scroll owner -->
<div
	bind:this={scrollElement}
	class={cn(
		// The rail used to fade both ends unconditionally, which dimmed the first and last
		// entry of a table of contents short enough to need no scrolling at all. The
		// attachment fades only the ends that have more behind them.
		'relative ms-px min-h-0 flex-1 overflow-auto py-3 text-sm',
		className
	)}
	{@attach scrollAffordance()}
>
	{@render children()}
</div>
