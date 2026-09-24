<script lang="ts">
	import { Stack } from '#lib/layout';
	import { cn, type WithElementRef } from '#lib/utils';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLUListElement>, HTMLUListElement> = $props();
</script>

<Stack
	as="ul"
	gap="xs"
	data-slot="sidebar-menu"
	data-sidebar="menu"
	class={cn('w-full', className)}
	{...restProps as HTMLAttributes<HTMLElement>}
	{@attach (node: HTMLUListElement) => {
		ref = node;
		return () => (ref = null);
	}}
>
	{@render children?.()}
</Stack>
