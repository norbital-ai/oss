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
	data-slot="field-content"
	class={cn('group/field-content flex flex-1 flex-col gap-1.5 leading-snug', className)}
	{...restProps}
>
	{@render children?.()}
</div>
