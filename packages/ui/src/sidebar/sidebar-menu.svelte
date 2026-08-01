<script lang="ts">
	import { cn, type WithElementRef } from '#lib/utils';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLUListElement>, HTMLUListElement> = $props();
</script>

<!-- stupidity:allow UI6 -- this leaf component root is the reusable layout boundary being defined -->
<ul
	bind:this={ref}
	data-slot="sidebar-menu"
	data-sidebar="menu"
	class={cn('flex w-full min-w-0 flex-col gap-1', className)}
	{...restProps}
>
	{@render children?.()}
</ul>
