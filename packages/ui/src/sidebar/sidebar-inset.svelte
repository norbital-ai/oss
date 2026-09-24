<script lang="ts">
	import { Stack } from '#lib/layout';
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

<Stack
	{as}
	gap="none"
	grow
	data-slot="sidebar-inset"
	class={cn(
		'relative w-full bg-background',
		'md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2',
		className
	)}
	{...restProps}
	{@attach (node: HTMLElement) => {
		ref = node;
		return () => (ref = null);
	}}
>
	{@render children?.()}
</Stack>
