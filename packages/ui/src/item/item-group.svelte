<script lang="ts">
	import { Stack } from '#lib/layout';
	import { cn, type WithElementRef } from '#lib/utils';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<Stack
	gap="none"
	role="list"
	data-slot="item-group"
	class={cn('group/item-group', className)}
	{...restProps}
	{@attach (node: HTMLDivElement) => {
		ref = node;
		return () => (ref = null);
	}}
>
	{@render children?.()}
</Stack>
