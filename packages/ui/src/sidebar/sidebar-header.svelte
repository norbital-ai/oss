<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '#lib/utils';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLElement>> = $props();
</script>

<!-- stupidity:allow UI6 -- this leaf component root is the reusable layout boundary being defined -->
<div
	bind:this={ref}
	data-slot="sidebar-header"
	data-sidebar="header"
	class={cn('flex flex-col gap-2 p-2', className)}
	{...restProps}
>
	{@render children?.()}
</div>
