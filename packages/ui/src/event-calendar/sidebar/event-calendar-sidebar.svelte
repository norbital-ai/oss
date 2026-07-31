<script lang="ts">
	import { cn } from '#lib/utils';
	import { Scroll } from '#lib/layout';
	import type { Snippet } from 'svelte';

	let {
		children,
		class: className
	}: {
		children: Snippet;
		class?: string;
	} = $props();
</script>

<Scroll
	axis="y"
	name="Calendar sidebar"
	class={cn('w-[240px] shrink-0 border-r border-border bg-card/50', className)}
>
	{@render children()}
</Scroll>
