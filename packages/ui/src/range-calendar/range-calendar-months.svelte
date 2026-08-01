<script lang="ts">
	import { cn } from '#lib/utils';
	import type { WithElementRef } from 'bits-ui';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<!-- stupidity:allow UI6; stupidity:allow UI7 -- this leaf component root is the reusable layout boundary being defined; this leaf component owns responsive or internal spacing as part of its public DOM contract -->
<div
	bind:this={ref}
	class={cn('mt-4 flex flex-col space-y-4 sm:flex-row sm:space-y-0 sm:space-x-4', className)}
	{...restProps}
>
	{@render children?.()}
</div>
