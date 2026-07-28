<script lang="ts">
	import { cn, type WithElementRef } from '#lib/utils';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		as = 'main',
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLElement>> & { as?: 'main' | 'div' } = $props();
</script>

<svelte:element
	this={as}
	bind:this={ref}
	data-slot="sidebar-inset"
	class={cn(
		'relative flex w-full flex-1 flex-col bg-background',
		'md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</svelte:element>
