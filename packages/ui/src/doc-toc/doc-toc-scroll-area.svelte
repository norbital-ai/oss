<script lang="ts">
	import { cn } from '#lib/utils';
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
		'relative min-h-0 flex-1 overflow-auto py-3 text-sm [scrollbar-width:none]  ms-px mask-[linear-gradient(to_bottom,transparent,white_16px,white_calc(100%-16px),transparent)] [&::-webkit-scrollbar]:hidden',
		className
	)}
>
	{@render children()}
</div>
