<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { Stack } from '#lib/layout';
	import { cn, type WithElementRef } from '#lib/utils';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLElement>> = $props();
</script>

<Stack
	gap="sm"
	data-slot="sidebar-header"
	data-sidebar="header"
	class={cn('p-2', className)}
	{...restProps}
	{@attach (node: HTMLElement) => {
		ref = node;
		return () => (ref = null);
	}}
>
	{@render children?.()}
</Stack>
