<script lang="ts">
	import { Stack } from '#lib/layout';
	import { cn, type WithElementRef } from '#lib/utils';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLUListElement>> = $props();
</script>

<Stack
	as="ul"
	gap="xs"
	data-slot="sidebar-menu-sub"
	data-sidebar="menu-sub"
	class={cn(
		// Guide under the parent icon; rows start after it so the highlight hugs the icon, not a hole.
		// repository-health:allow UI7 -- `ml-5` is the indent that puts the guide line under the parent icon, not spacing between siblings; no primitive offsets itself from its parent's edge, and an Imposter would lift the list out of flow
		'mr-0 ml-5 border-l border-sidebar-border py-0.5 pr-0 pl-2',
		'group-data-[collapsible=icon]:hidden',
		className
	)}
	{...restProps as HTMLAttributes<HTMLElement>}
	{@attach (node: HTMLElement) => {
		ref = node;
		return () => (ref = null);
	}}
>
	{@render children?.()}
</Stack>
