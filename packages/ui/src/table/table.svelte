<script lang="ts">
	import { cn } from '#lib/utils';
	import type { WithElementRef } from 'bits-ui';
	import type { HTMLTableAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		hidden,
		...restProps
	}: WithElementRef<HTMLTableAttributes> = $props();
</script>

<table bind:this={ref} class={cn('w-full caption-bottom text-sm', className)} {...restProps}>
	{@render children?.()}
</table>
