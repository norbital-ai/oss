<script lang="ts">
	import { cn } from '#lib/utils';
	import type { Snippet } from 'svelte';

	let {
		children,
		class: className
	}: {
		children: Snippet;
		class?: string;
	} = $props();
</script>

<div
	class={cn(
		'w-[240px] shrink-0 border-r border-border bg-card/50 flex flex-col overflow-y-auto',
		className
	)}
>
	{@render children()}
</div>
