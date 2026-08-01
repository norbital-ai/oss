<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { Scroll } from '#lib/layout';
	import { cn, type WithElementRef } from '#lib/utils';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLElement>> = $props();
</script>

<!-- stupidity:allow UI10 -- collapsed icon mode intentionally disables this component's scroll overflow -->
<Scroll
	axis="y"
	name="Sidebar"
	layout="stack"
	gap="sm"
	grow
	bind:ref
	data-slot="sidebar-content"
	data-sidebar="content"
	class={cn('group-data-[collapsible=icon]:overflow-hidden', className)}
	{...restProps}
>
	{@render children?.()}
</Scroll>
