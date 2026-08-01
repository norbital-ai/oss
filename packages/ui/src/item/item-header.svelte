<script lang="ts">
	import { cn, type WithElementRef } from '#lib/utils';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<!-- stupidity:allow UI6 -- this leaf component root is the reusable layout boundary being defined -->
<div
	bind:this={ref}
	data-slot="item-header"
	class={cn('flex basis-full items-center justify-between gap-2', className)}
	{...restProps}
>
	{@render children?.()}
</div>
