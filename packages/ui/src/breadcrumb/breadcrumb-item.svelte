<script lang="ts">
	import { cn } from '#lib/utils';
	import type { WithElementRef } from 'bits-ui';
	import type { HTMLLiAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLLiAttributes> = $props();
</script>

<!-- stupidity:allow UI6 -- this leaf component root is the reusable layout boundary being defined -->
<li bind:this={ref} class={cn('inline-flex items-center gap-1.5', className)} {...restProps}>
	{@render children?.()}
</li>
